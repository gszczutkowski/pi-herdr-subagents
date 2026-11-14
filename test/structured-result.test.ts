import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension from "../pi-extension/subagents/subagent-done.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { isStructuredResult } from "../pi-extension/subagents/contracts.ts";

export const proposal = { status: "complete" as const, summary: "Implemented", artifacts: ["patch.diff"],
  checks: [{ criterionIds: ["criterion"], ref: "test-report.txt", outcome: "passed" as const }], unmetCriterionIds: [], risks: [] };

test("real child tool publishes immutable structured turns; durable outbox survives reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "structured-result-"));
  const saved = { ...process.env };
  const session = join(dir, "child.jsonl"); const runId = "structured-child";
  Object.assign(process.env, { PI_SUBAGENT_ID: runId, PI_SUBAGENT_SESSION: session, PI_SUBAGENT_AUTO_EXIT: "1" });
  const handlers = new Map<string, Function[]>(); const tools = new Map<string, any>();
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, shutdown: () => assert.fail("kept-open child must not shut down") };
  const emit = async (name: string, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  let store: RuntimeStore | undefined;
  try {
    writeFileSync(session, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "plain summary" }] } }) + "\n");
    childExtension({ on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
      registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {} } as any);
    assert.ok(isStructuredResult(proposal));
    const results = [];
    const cursor: string[] = [];
    for (const status of ["complete", "partial", "blocked"] as const) {
      await emit("before_agent_start");
      const result = { ...proposal, status };
      const response = await tools.get("subagent_done").execute("finish", { result, close: false }, undefined, undefined, ctx);
      assert.deepEqual(response.details.structuredResult, result);
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
      await emit("agent_settled", { aborted: false });
      const event = readRetainedCompletion(session, runId, cursor)!;
      assert.deepEqual(event.structuredResult, result);
      assert.equal(event.keepOpen, true);
      cursor.push(`subagent:${runId}:completion:${event.eventId}`);
      results.push(event);
    }
    const eventsDir = `${runCompletionFile(session, runId)}.events`;
    assert.equal(readdirSync(eventsDir).length, 3);
    assert.equal(readRetainedCompletion(session, runId, cursor), null);
    const first = JSON.parse(readFileSync(join(eventsDir, readdirSync(eventsDir).sort()[0]), "utf8"));
    assert.equal(first.structuredResult.status, "complete", "later turns never replace earlier claims");
    const parent = { sessionFile: join(dir, "parent.jsonl"), headerId: "parent", branchToken: "branch", checkpoint: "checkpoint" };
    store = new RuntimeStore(join(dir, "runtime"), parent);
    store.prepare({ id: runId, sessionFile: session, name: "worker", task: "task", startTime: Date.now() });
    const id = cursor[0];
    store.enqueue(id, runId, { message: { customType: "subagent_result", display: true, content: "review proposal", details: { ...results[0], eventId: id } }, options: { triggerTurn: true, deliverAs: "steer" } });
    store.close(); store = new RuntimeStore(join(dir, "runtime"), parent);
    assert.deepEqual((store.snapshot().outbox[id].envelope.message.details as any).structuredResult, proposal);
  } finally {
    store?.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    delete (globalThis as any)[Symbol.for(`pi-subagents/keep-open/${runId}`)];
    rmSync(dir, { recursive: true, force: true });
  }
});
