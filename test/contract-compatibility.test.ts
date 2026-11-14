import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import childExtension from "../pi-extension/subagents/subagent-done.ts";
import { interpretExitSidecar, readRetainedCompletion } from "../pi-extension/subagents/completion.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";
import { isStructuredResult, normalizeStructuredResult, isAssignmentContract } from "../pi-extension/subagents/contracts.ts";

test("legacy sidecars and malformed optional structures retain delivery with explicit review diagnostics", () => {
  assert.deepEqual(interpretExitSidecar({ type: "done" }), { reason: "done", exitCode: 0 });
  assert.equal(normalizeStructuredResult(undefined).structuredResult, undefined);
  for (const bad of [null, "done", { accepted: true }, { status: "complete", testsPassed: true }, { status: "blocked", summary: "" }]) {
    const result = interpretExitSidecar({ type: "done", keepOpen: true, structuredResult: bad });
    assert.equal(result.reason, "done");
    assert.equal(result.keepOpen, true);
    assert.equal(result.structuredResult, undefined);
    assert.match(result.resultDiagnostic ?? "", /Malformed.*requires parent review/);
  }
  const dir = mkdtempSync(join(tmpdir(), "contract-legacy-"));
  try {
    const session = join(dir, "old.jsonl");
    const base = runCompletionFile(session, "run");
    writeFileSync(base, JSON.stringify({ type: "done", runId: "run", eventId: "old", summary: "Foreign harness/plain text output", structuredResult: { accepted: true } }));
    const event = readRetainedCompletion(session, "run", [])!;
    assert.equal(event.summary, "Foreign harness/plain text output");
    assert.equal(event.eventId, "old");
    assert.match(event.resultDiagnostic ?? "", /Malformed/);
    assert.equal(readRetainedCompletion(session, "run", ["subagent:run:completion:old"]), null);
    const tools = new Map<string, any>();
    childExtension({ on() {}, registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, registerShortcut() {} } as any);
    const tool = tools.get("subagent_done");
    const prepared = tool.prepareArguments({ close: false, result: { testsPassed: true, accepted: true } });
    assert.deepEqual(prepared, { close: false });
    assert.ok(Value.Check(tool.parameters, prepared), "strict schema still permits legacy plain completion");
    assert.equal(Value.Check(tool.parameters, { result: { accepted: true } }), false);
    assert.equal(Value.Check(tool.parameters, { accepted: true }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("aggregate contract/result size is bounded even when every individual field fits", () => {
  const long = Array(10).fill("x".repeat(8192));
  assert.equal(isStructuredResult({ status: "complete", summary: "claim", artifacts: long, checks: [], unmetCriterionIds: [], risks: [] }), false);
  assert.equal(isAssignmentContract({ objective: "o", scope: "s", criteria: [], dependencies: [], inputs: [], files: long, decisions: [], changeConstraints: [] }), false);
});
