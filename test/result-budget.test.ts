import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundSubagentMessage, DEFAULT_MAX_REPORT_BYTES, type ResultBudgetOptions } from "../pi-extension/subagents/result-budget.ts";
import { createDeliveryState, enqueueDelivery, flushDeliveries, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];

function fixture(t: TestContext): ResultBudgetOptions {
  const artifactDir = mkdtempSync(join(tmpdir(), "pi-report-budget-"));
  t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
  return { artifactDir, runId: "run-1", eventId: "event-1", maxReportBytes: 600 };
}

function report(content: Message["content"], details: unknown = {}): Message {
  return { customType: "subagent_result", content, display: true, details };
}

function boundedText(message: Message, maxBytes: number): string {
  assert.equal(typeof message.content, "string");
  const text = message.content as string;
  assert.ok(Buffer.byteLength(text, "utf8") <= maxBytes, `${Buffer.byteLength(text)} > ${maxBytes}`);
  assert.ok(text.isWellFormed(), "no broken surrogate pairs");
  assert.ok(!text.includes("\ufffd"), "no replacement character from a split UTF-8 sequence");
  return text;
}

function archives(options: ResultBudgetOptions): string[] {
  const directory = join(options.artifactDir, "subagent-reports");
  return readdirSync(directory).map((name) => join(directory, name));
}

function readArchive(path: string): { version: number; runId: string; eventId: string; message: Message } {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("bounded subagent reports", () => {
  it("leaves short strings, empty reports and multipart messages unchanged without storage access", (t) => {
    const options = fixture(t);
    const blockedDirectory = join(options.artifactDir, "not-a-directory");
    writeFileSync(blockedDirectory, "block archive creation");
    options.artifactDir = blockedDirectory;
    for (const content of ["", "Done 日本語 🧑‍💻", [{ type: "text" as const, text: "Part one" }, { type: "text" as const, text: "Part two" }]]) {
      const message = report(content, { response: "x".repeat(100_000), structuredResult: { status: "complete" } });
      assert.equal(boundSubagentMessage(message, options), message);
    }
    assert.equal(readFileSync(blockedDirectory, "utf8"), "block archive creation");
  });

  it("defaults to 12000 bytes and leaves an exactly-at-limit string unchanged", (t) => {
    const options = fixture(t);
    delete options.maxReportBytes;
    assert.equal(DEFAULT_MAX_REPORT_BYTES, 12_000);
    const exact = report("界".repeat(4_000));
    assert.equal(boundSubagentMessage(exact, options), exact);
    const oversized = report(`${exact.content}!`);
    const output = boundedText(boundSubagentMessage(oversized, options), 12_000);
    assert.match(output, /Report truncated/);
    assert.equal(readArchive(archives(options)[0]).message.content, oversized.content);
  });

  it("keeps UTF-8 boundaries valid and counts the notice and full path inside the limit", (t) => {
    const options = fixture(t);
    const message = report("Sub-agent Worker completed\n" + "🙂界é日本語".repeat(2_000) + "\nDiagnostic: parent review required");
    for (let limit = 500; limit < 540; limit++) {
      const text = boundedText(boundSubagentMessage(message, { ...options, maxReportBytes: limit }), limit);
      assert.ok(text.startsWith("Sub-agent Worker completed"));
      assert.ok(text.includes("Diagnostic: parent review required"));
      assert.ok(text.includes(archives(options)[0]), "complete, readable archive path");
      assert.ok(text.endsWith("]"), "notice itself is not truncated");
    }
    assert.equal(archives(options).length, 1, "budget changes must not change the archived original");
  });

  it("archives the complete original content and details and does not mutate a frozen envelope", (t) => {
    const options = fixture(t);
    const details = Object.freeze({
      response: "full response " + "界".repeat(10_000),
      structuredResult: { status: "complete", summary: "proposal", artifacts: ["proof.txt"], checks: [{ outcome: "passed", ref: "test" }] },
      resultDiagnostic: "Requires parent review, not acceptance.",
      runtimePlan: { runtimeMismatch: "different model" },
      sessionFile: "/sessions/child.jsonl",
    });
    const message = Object.freeze(report("Sub-agent Worker completed\n\n" + JSON.stringify(details), details));
    const original = structuredClone(message);
    const bounded = boundSubagentMessage(message, options);
    const text = boundedText(bounded, options.maxReportBytes!);
    assert.notEqual(bounded, message);
    assert.equal(bounded.details, details, "structured consumers and renderers receive full original details");
    assert.equal(bounded.customType, message.customType);
    assert.equal(bounded.display, message.display);
    assert.deepEqual(message, original);
    const paths = archives(options);
    assert.equal(paths.length, 1);
    assert.ok(text.includes(paths[0]));
    assert.deepEqual(readArchive(paths[0]), { version: 1, runId: options.runId, eventId: options.eventId, message: original });
  });

  it("Pi's actual model projection receives bounded content, not the full details", (t) => {
    const options = fixture(t);
    const details = { response: "renderer-only evidence ".repeat(10_000), structuredResult: { status: "complete", summary: "proposal" } };
    const bounded = boundSubagentMessage(report("Model-facing result ".repeat(2_000), details), options);
    boundedText(bounded, options.maxReportBytes!);
    const projected = convertToLlm([{ ...bounded, role: "custom", timestamp: 0 }]);
    assert.deepEqual(projected, [{ role: "user", content: [{ type: "text", text: bounded.content }], timestamp: 0 }]);
    assert.equal(bounded.details, details);
    assert.ok(!JSON.stringify(projected).includes("renderer-only evidence"));
  });

  it("preserves separate reports for multiple events and runs, even when their contents match", (t) => {
    const options = fixture(t);
    const message = report("same report ".repeat(1_000));
    const identities = [options, { ...options, eventId: "event-2" }, { ...options, runId: "run-2" }];
    const texts = identities.map((identity) => boundedText(boundSubagentMessage(message, identity), options.maxReportBytes!));
    const paths = archives(options);
    assert.equal(paths.length, 3);
    for (const identity of identities) {
      assert.ok(paths.some((path) => {
        const archived = readArchive(path);
        return archived.runId === identity.runId && archived.eventId === identity.eventId;
      }));
    }
    for (const text of texts) assert.equal(paths.filter((path) => text.includes(path)).length, 1);
  });

  it("retries reuse the immutable archive and a reused event ID never overwrites an earlier payload", (t) => {
    const options = fixture(t);
    const original = report("first ".repeat(2_000));
    const first = boundSubagentMessage(original, options);
    const path = archives(options)[0];
    const before = statSync(path);
    const payload = readFileSync(path, "utf8");
    assert.deepEqual(boundSubagentMessage(original, options), first);
    const after = statSync(path);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino);
    assert.equal(boundSubagentMessage(first, options), first, "already-bounded outbox retries do not archive again");
    boundSubagentMessage(report("second ".repeat(2_000)), options);
    assert.equal(archives(options).length, 2);
    assert.equal(readFileSync(path, "utf8"), payload);
    assert.ok(archives(options).every((name) => name.endsWith(".json")), "no temporary files remain");
  });

  it("never trusts or overwrites a conflicting existing archive", (t) => {
    const options = fixture(t);
    const message = report("original ".repeat(2_000), { sessionFile: "/sessions/recovery.jsonl" });
    boundSubagentMessage(message, options);
    const path = archives(options)[0];
    writeFileSync(path, "conflicting evidence");
    const text = boundedText(boundSubagentMessage(message, options), options.maxReportBytes!);
    assert.match(text, /archive failed \(ECONFLICT\)/);
    assert.match(text, /Session: \/sessions\/recovery.jsonl/);
    assert.ok(!text.includes("Full content and details:"));
    assert.equal(readFileSync(path, "utf8"), "conflicting evidence");
    assert.equal(archives(options).length, 1);
  });

  it("bounds multipart content as a whole and preserves all original blocks in the artifact", (t) => {
    const options = fixture(t);
    const content: Exclude<Message["content"], string> = [
      { type: "text", text: "Sub-agent multipart failed\n" + "界".repeat(2_000) },
      { type: "image", data: "a".repeat(5_000), mimeType: "image/png" },
      { type: "text", text: "🙂".repeat(2_000) + "\nDiagnostic: retry required" },
    ];
    const message = report(content, { response: "full renderer response" });
    const text = boundedText(boundSubagentMessage(message, options), options.maxReportBytes!);
    assert.ok(text.includes("Sub-agent multipart failed"));
    assert.ok(text.includes("Diagnostic: retry required"));
    assert.deepEqual(readArchive(archives(options)[0]).message, message);
    assert.equal(message.content, content);
  });

  it("counts multipart wrapper/image bytes, not just text, and does not forward raw oversized images", (t) => {
    const options = fixture(t);
    for (const content of [
      Array.from({ length: 100 }, () => ({ type: "text" as const, text: "a" })),
      [{ type: "image" as const, data: "a".repeat(5_000), mimeType: "image/png" }],
    ]) {
      const message = report(content);
      const text = boundedText(boundSubagentMessage(message, options), options.maxReportBytes!);
      assert.match(text, /Report truncated/);
      assert.ok(!text.includes("a".repeat(5_000)));
    }
    assert.equal(archives(options).length, 2);
  });

  for (const kind of ["structured result", "diagnostic", "ping", "provider error", "watcher error"]) {
    it(`bounds ${kind} uniformly while keeping full details`, (t) => {
      const options = fixture(t);
      const body = `${kind}: ` + "important evidence 日本語🙂 ".repeat(1_000);
      const details = { sessionFile: "/sessions/child.jsonl", response: body,
        ...(kind === "structured result" ? { structuredResult: { status: "complete", summary: body } } : {}),
        ...(kind === "diagnostic" ? { resultDiagnostic: body } : {}),
        ...(kind === "ping" ? { message: body } : {}),
        ...(kind === "provider error" ? { errorMessage: body, exitCode: 1 } : {}),
        ...(kind === "watcher error" ? { error: body } : {}),
      };
      const message = { ...report(body, details), customType: kind === "ping" ? "subagent_ping" : "subagent_result" };
      const bounded = boundSubagentMessage(message, options);
      assert.ok(boundedText(bounded, options.maxReportBytes!).startsWith(`${kind}:`));
      assert.equal(bounded.details, details);
      assert.equal(bounded.customType, message.customType);
      assert.deepEqual(readArchive(archives(options)[0]).message, message);
    });
  }

  it("fails safely on storage errors without claiming a saved artifact and supplies a session fallback", (t) => {
    const options = fixture(t);
    const blocker = join(options.artifactDir, "blocker");
    writeFileSync(blocker, "not a directory");
    const details = { response: "all evidence ".repeat(2_000), sessionFile: "/sessions/child.jsonl" };
    const message = report("Sub-agent failed\n" + details.response, details);
    const bounded = boundSubagentMessage(message, { ...options, artifactDir: blocker, sessionFile: "/sessions/override.jsonl" });
    const text = boundedText(bounded, options.maxReportBytes!);
    assert.match(text, /Sub-agent failed/);
    assert.match(text, /archive failed/);
    assert.match(text, /Session: \/sessions\/override.jsonl/);
    assert.ok(!/saved|Full report:|Full content and details:/.test(text));
    assert.equal(bounded.details, details);
    assert.equal(readFileSync(blocker, "utf8"), "not a directory");
  });

  it("fails safely on unserializable details and still delivers bounded content", (t) => {
    const options = fixture(t);
    const details: { sessionFile: string; self?: unknown } = { sessionFile: "/sessions/recovery.jsonl" };
    details.self = details;
    const bounded = boundSubagentMessage(report("Error report\n" + "large ".repeat(2_000), details), options);
    const text = boundedText(bounded, options.maxReportBytes!);
    assert.match(text, /archive failed \(storage\/serialization error\)/);
    assert.match(text, /Session: \/sessions\/recovery.jsonl/);
    assert.equal(bounded.details, details);
    assert.deepEqual(readdirSync(options.artifactDir), []);
  });

  it("honors tiny limits and overlong reference paths without printing a false or partial saved path", (t) => {
    const options = fixture(t);
    const message = report("🙂界".repeat(2_000));
    for (const limit of [1, 2, 3, 10, 32, 64, 100]) {
      const text = boundedText(boundSubagentMessage(message, { ...options, maxReportBytes: limit }), limit);
      assert.ok(!text.includes("Full report:"));
      assert.ok(!text.includes("Full content and details:"));
      assert.ok(!text.includes(".json"));
    }
    assert.equal(archives(options).length, 1, "the full archive still exists when its reference cannot fit");
  });

  it("invalid limits cannot disable the default bound", (t) => {
    const options = fixture(t);
    for (const invalid of [0, -1, NaN, Infinity, 3.5]) {
      const message = report("x".repeat(DEFAULT_MAX_REPORT_BYTES + 1));
      boundedText(boundSubagentMessage(message, { ...options, maxReportBytes: invalid }), DEFAULT_MAX_REPORT_BYTES);
    }
  });

  it("preserves durable outbox identity, proposals, ownership and the original envelope on retry", (t) => {
    const options = fixture(t);
    const details = { response: "large result ".repeat(2_000), structuredResult: { status: "complete", summary: "proposal, not acceptance" } };
    const bounded = boundSubagentMessage(report(details.response, details), options);
    const state = createDeliveryState();
    t.after(() => pauseDeliveries(state));
    const owner = { id: options.runId, lifecycle: createLifecycle(0) };
    const lifecycle = owner.lifecycle;
    enqueueDelivery(state, owner, bounded, () => {}, options.eventId);
    assert.equal(owner.lifecycle, lifecycle, "bounding and enqueue cannot accept a plan or settle a child");
    const pending = [...state.pending.values()][0];
    assert.deepEqual((pending.envelope.message.details as typeof details).structuredResult, details.structuredResult);
    assert.deepEqual(pending.envelope.options, { triggerTurn: true, deliverAs: "steer" });
    const attempts: unknown[] = [];
    state.api = { sendMessage(message) { attempts.push(message); throw new Error("transport unavailable"); } };
    flushDeliveries(state);
    pending.retryAt = 0;
    flushDeliveries(state);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
    assert.equal(owner.lifecycle.delivery, "pending");
    assert.equal(archives(options).length, 1);
  });
});
