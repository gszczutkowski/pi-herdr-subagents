import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childExtension from "../pi-extension/subagents/subagent-done.ts";
import { getBehaviorConfig } from "../pi-extension/subagents/config.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";

for (const autoExit of [true, false]) {
  test(`child publishes each settled follow-up once (autoExit=${autoExit}) without stale completion suppression`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "keep-open-"));
    const session = join(dir, "child.jsonl");
    const runId = `tracked-child-${autoExit}`;
    const env = { PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ID: runId,
      PI_SUBAGENT_ACTIVITY_FILE: join(dir, "activity.json"), PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : "0" };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const config = getBehaviorConfig();
    const oldClose = config.closeOnDone;
    // Explicit close:false must retain collaboration even when auto-exit and
    // closeOnDone normally close autonomous children on the next settled turn.
    config.closeOnDone = true;
    Object.assign(process.env, env);
    const handlers = new Map<string, Function[]>();
    const tools = new Map<string, any>();
    let shutdowns = 0;
    const ctx = { isIdle: () => true, hasPendingMessages: () => false,
      shutdown: () => { shutdowns++; }, sessionManager: { getSessionFile: () => session } };
    const emit = async (event: string, data = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
    };
    const snapshot = (text: string) => writeFileSync(session, JSON.stringify({ type: "message", id: text,
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } }) + "\n");
    try {
      childExtension({ on: (name: string, handler: Function) => {
        const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
      }, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {} } as any);
      for (const [index, text] of ["first", "parent follow-up", "manual follow-up"].entries()) {
        await emit("input");
        await emit("before_agent_start");
        await emit("agent_start");
        snapshot(text);
        if (index === 0) {
          const result = await tools.get("subagent_done").execute("done", { close: false }, undefined, undefined, ctx);
          assert.equal(result.terminate, true);
        }
        await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
        await emit("agent_settled", { aborted: false });
        await emit("agent_settled", { aborted: false });
      }
      const events = `${runCompletionFile(session, runId)}.events`;
      assert.equal(readdirSync(events).filter((file) => file.endsWith(".json")).length, 3);
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await waitForCompletion(new AbortController().signal, {
        intervalMs: 1, sessionFile: session, runId, readTerminalTail: async () => "",
      }));
      assert.deepEqual(results.map((result) => result.summary), ["first", "parent follow-up", "manual follow-up"]);
      assert.equal(new Set(results.map((result) => result.eventId)).size, 3);
      assert.ok(results.every((result) => result.keepOpen));
      assert.equal(shutdowns, 0);
      // An aborted turn is not an additional completion.
      await emit("before_agent_start");
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
      await emit("agent_settled", { aborted: true });
      assert.equal(readdirSync(events).filter((file) => file.endsWith(".json")).length, 0);
      // Explicit closure is a distinct final turn, not suppressed by prior results.
      await emit("before_agent_start");
      snapshot("closing");
      await tools.get("subagent_done").execute("close", { close: true }, undefined, undefined, ctx);
      assert.equal(shutdowns, 1);
      const closed = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1, sessionFile: session, runId, readTerminalTail: async () => "",
      });
      assert.notEqual(closed.keepOpen, true);
      assert.equal(closed.summary, "closing");
    } finally {
      delete (globalThis as any)[Symbol.for(`pi-subagents/keep-open/${runId}`)];
      config.closeOnDone = oldClose;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
