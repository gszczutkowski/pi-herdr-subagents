import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withChildSession } from "./child-session.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";

const result = { status: "blocked", summary: "Task B requires a decision", artifacts: [], checks: [], unmetCriterionIds: [], risks: [] };
const done = (structured = false) => ({ stopReason: "toolUse" as const, content: [
  { type: "toolCall" as const, id: "done", name: "subagent_done", arguments: { close: false, ...(structured ? { result } : {}) } },
] });
function completions(): any[] {
  const dir = `${process.env.PI_SUBAGENT_SESSION}.${process.env.PI_SUBAGENT_ID}.exit.events`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".json")).sort().map(name => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

test("native keepOpen: a textless task preserves its own structured result, not the previous task's summary", async () => {
  await withChildSession({ autoExit: false, respond: index => index === 0 ? { content: [{ type: "text", text: "TASK_A_COMPLETED" }] }
    : index === 1 ? done(true) : { content: [{ type: "text", text: "TASK_C_COMPLETED" }] } }, async ({ session, requests }) => {
    await session.prompt("Task A");
    await session.prompt("Task B");
    await session.prompt("Task C");
    assert.equal(requests.length, 3);
    const events = completions();
    assert.equal(events.length, 3);
    assert.equal(events[0].summary, "TASK_A_COMPLETED");
    assert.equal(events[0].keepOpen, true);
    assert.match(events[1].summary, /No assistant text was produced for this supervised task/);
    const parsed = readRetainedCompletion(process.env.PI_SUBAGENT_SESSION!, process.env.PI_SUBAGENT_ID!,
      [`subagent:${process.env.PI_SUBAGENT_ID}:completion:${events[0].eventId}`])!;
    assert.equal(parsed.summary, events[1].summary, "explicit absence survives the parent reader without a stale-text fallback");
    assert.deepEqual(parsed.structuredResult, result);
    assert.deepEqual(events[1].structuredResult, result);
    assert.equal(events[2].summary, "TASK_C_COMPLETED");
    assert.equal(new Set(events.map(event => event.eventId)).size, 3);
  });
});

test("native resumed history: a tool-only first task cannot reuse the previous process's text", async () => {
  await withChildSession({ setup: manager => {
    manager.appendMessage({ role: "user", content: "Previous task", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "PREVIOUS_PROCESS_COMPLETED" }],
      api: "child-test-api", provider: "child-test", model: "model", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);
  }, respond: () => done(true) }, async ({ session, requests }) => {
    await session.prompt("New supervised task");
    assert.match(JSON.stringify(requests[0]), /PREVIOUS_PROCESS_COMPLETED/);
    assert.match(completions()[0].summary, /No assistant text was produced/);
    assert.deepEqual(completions()[0].structuredResult, result);
  });
});

test("native active branch: abandoned text written during this task is never a completion summary", async () => {
  let branchAway: (leaf: string) => void;
  await withChildSession({ respond: () => done(true), extensions: [pi => {
    pi.on("tool_call", (event: any, ctx: any) => {
      if (event.toolName !== "subagent_done") return;
      // Real SessionManager tree navigation, after the tool-calling assistant
      // has been persisted; JSONL's physical tail now belongs to another path.
      const manager = ctx.sessionManager;
      const leaf = manager.getLeafId();
      // The public extension facade is read-only; the native manager is captured
      // below through the fixture's session, not cast to a writable facade.
      branchAway(leaf);
    });
  }] }, async ({ session, requests }) => {
    branchAway = leaf => {
      const manager = session.sessionManager;
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ABANDONED_TASK_TEXT" }],
        stopReason: "stop", timestamp: 3 } as any);
      manager.branch(leaf);
    };
    await session.prompt("Complete without text");
    assert.match(completions()[0].summary, /No assistant text was produced/);
    assert.deepEqual(completions()[0].structuredResult, result);
    assert.match(JSON.stringify(session.sessionManager.getEntries()), /ABANDONED_TASK_TEXT/);
    assert.doesNotMatch(JSON.stringify(session.sessionManager.getBranch()), /ABANDONED_TASK_TEXT/);
    await session.prompt("Another textless task");
    assert.doesNotMatch(JSON.stringify(requests[1]), /ABANDONED_TASK_TEXT/);
    assert.match(completions()[1].summary, /No assistant text was produced/);
  });
});
