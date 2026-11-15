import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSubagentActivityRecorder,
  readSubagentActivityFile,
  type SubagentActivityRecorder,
} from "../pi-extension/subagents/activity.ts";
import { getBehaviorConfig } from "../pi-extension/subagents/config.ts";
import { createLifecycle, markInterruptRequested, observeActivity } from "../pi-extension/subagents/lifecycle.ts";
import childExtension from "../pi-extension/subagents/subagent-done.ts";

for (const method of ["subagentDone", "agentEndDone"] as const) {
  test(`recorder ${method}(true) publishes done and preserves follow-up activity sequence`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const dir = mkdtempSync(join(tmpdir(), "keep-open-activity-"));
    const activityFile = join(dir, "activity.json");
    const recorder = createSubagentActivityRecorder({ runningChildId: "child", activityFile });
    const read = () => {
      const result = readSubagentActivityFile(activityFile, "child");
      assert.ok(result.ok);
      return result.activity;
    };
    try {
      recorder.sessionStart();
      recorder.beforeAgentStart();
      recorder.turnStart(0);
      recorder.messageUpdate("text_delta"); // Pending write must not overwrite done.
      recorder[method](true);
      const done = read();
      assert.equal(done.phase, "done");
      assert.equal(done.latestEvent, method === "subagentDone" ? "subagent_done" : "agent_end");
      assert.equal(done.agentActive, false);
      assert.equal(done.turnActive, false);
      assert.equal(done.providerActive, false);
      assert.equal(done.toolActive, false);
      assert.equal(done.activeScope, undefined);
      assert.equal(done.activeSince, undefined);
      assert.equal(done.waitingSince, undefined);
      t.mock.timers.tick(500);
      assert.deepEqual(read(), done);

      recorder.input();
      assert.equal(read().sequence, done.sequence + 1);
      recorder.beforeAgentStart();
      recorder.agentStart();
      recorder.turnStart(1);
      recorder.beforeProviderRequest();
      const request = read();
      assert.equal(request.activeScope, "provider");
      assert.equal(request.providerActive, true);
      assert.ok(request.sequence > done.sequence);
      recorder.afterProviderResponse();
      recorder.messageUpdate("text_delta");
      t.mock.timers.tick(500);
      const streaming = read();
      assert.equal(streaming.activeScope, "streaming");
      assert.equal(streaming.latestEvent, "message_update");
      assert.ok(streaming.sequence > request.sequence);
      recorder.toolExecutionStart("follow-up-tool", "bash");
      const tool = read();
      assert.equal(tool.activeScope, "tool");
      assert.equal(tool.toolName, "bash");
      assert.ok(tool.sequence > streaming.sequence);
    } finally {
      recorder.sessionShutdown("reload");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("child reload preserves the activity high-water sequence and clears interruption on new work", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const dir = mkdtempSync(join(tmpdir(), "reload-activity-"));
  const activityFile = join(dir, "activity.json");
  const params = { runningChildId: "reloaded-child", activityFile };
  const before = createSubagentActivityRecorder(params);
  let after: SubagentActivityRecorder | undefined;
  try {
    before.sessionStart();
    before.beforeAgentStart();
    for (let i = 0; i < 100; i++) before.toolExecutionStart(`tool-${i}`, "bash");
    const old = readSubagentActivityFile(activityFile, params.runningChildId);
    assert.ok(old.ok);
    let lifecycle = observeActivity(createLifecycle(1_000), old, Date.now());
    lifecycle = markInterruptRequested(lifecycle, Date.now());
    before.messageUpdate("text_delta"); // Reload must discard this pending flush.
    before.sessionShutdown("reload");
    t.mock.timers.tick(1_000);

    after = createSubagentActivityRecorder(params);
    after.sessionStart();
    const starting = readSubagentActivityFile(activityFile, params.runningChildId);
    assert.ok(starting.ok);
    assert.ok(starting.activity.sequence > old.activity.sequence);
    assert.equal(starting.activity.phase, "starting");
    assert.equal(starting.activity.toolActive, false);
    assert.equal(starting.activity.toolName, undefined, "old transient tool state must not carry over");
    after.beforeAgentStart();
    const active = readSubagentActivityFile(activityFile, params.runningChildId);
    assert.ok(active.ok);
    lifecycle = observeActivity(lifecycle, active, Date.now());
    assert.equal(lifecycle.turn.kind, "active", "fresh reloaded work must clear interrupted status immediately");
    t.mock.timers.tick(1_000);
    assert.deepEqual(readSubagentActivityFile(activityFile, params.runningChildId), active);
  } finally {
    before.sessionShutdown("reload");
    after?.sessionShutdown("reload");
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const snapshot of ["invalid", "wrong-id"] as const) {
  test(`recorder does not inherit sequence from a ${snapshot} snapshot`, () => {
    const dir = mkdtempSync(join(tmpdir(), "invalid-activity-sequence-"));
    const activityFile = join(dir, "activity.json");
    const previous = createSubagentActivityRecorder({ runningChildId: "other-child", activityFile });
    let recorder: SubagentActivityRecorder | undefined;
    try {
      previous.sessionStart();
      previous.beforeAgentStart();
      previous.sessionShutdown("reload");
      if (snapshot === "invalid") writeFileSync(activityFile, "{");
      recorder = createSubagentActivityRecorder({ runningChildId: "new-child", activityFile });
      recorder.sessionStart();
      const current = readSubagentActivityFile(activityFile, "new-child");
      assert.ok(current.ok);
      assert.equal(current.activity.sequence, 1);
    } finally {
      previous.sessionShutdown("reload");
      recorder?.sessionShutdown("reload");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const closingCases: [string, (recorder: SubagentActivityRecorder) => void][] = [
  ["subagentDone default", (recorder) => recorder.subagentDone()],
  ["subagentDone(false)", (recorder) => recorder.subagentDone(false)],
  ["agentEndDone default", (recorder) => recorder.agentEndDone()],
  ["agentEndDone(false)", (recorder) => recorder.agentEndDone(false)],
  ["caller ping", (recorder) => recorder.callerPing()],
  ...(["quit", "reload", "new", "resume", "fork"] as const).map((reason): [string, (recorder: SubagentActivityRecorder) => void] =>
    [`shutdown ${reason}`, (recorder) => recorder.sessionShutdown(reason)]),
];

for (const [name, close] of closingCases) {
  test(`recorder ${name} disables follow-up writes and pending timers`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const dir = mkdtempSync(join(tmpdir(), "closed-activity-"));
    const activityFile = join(dir, "activity.json");
    const recorder = createSubagentActivityRecorder({ runningChildId: "child", activityFile });
    try {
      recorder.sessionStart();
      recorder.subagentDone(true); // Closing must still work after a kept-open turn.
      recorder.beforeAgentStart();
      recorder.messageUpdate("text_delta");
      close(recorder);
      const closed = readSubagentActivityFile(activityFile, "child");
      assert.ok(closed.ok);
      if (name.startsWith("shutdown ") && name !== "shutdown quit") {
        assert.equal(closed.activity.latestEvent, "before_agent_start");
      } else {
        assert.equal(closed.activity.phase, "done");
      }
      recorder.input();
      recorder.beforeAgentStart();
      recorder.beforeProviderRequest();
      recorder.messageUpdate("text_delta");
      recorder.toolExecutionStart("late-tool", "bash");
      t.mock.timers.tick(1_000);
      assert.deepEqual(readSubagentActivityFile(activityFile, "child"), closed);
    } finally {
      recorder.sessionShutdown("reload");
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const completion of ["close:false", "natural"] as const) {
  test(`child ${completion} completion keeps follow-up snapshots live and clears interrupt after abort`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const dir = mkdtempSync(join(tmpdir(), "child-activity-"));
    const activityFile = join(dir, "activity.json");
    const runId = completion === "close:false" ? "activity-explicit" : "activity-natural";
    const env = {
      PI_SUBAGENT_ID: runId,
      PI_SUBAGENT_SESSION: join(dir, "child.jsonl"),
      PI_SUBAGENT_ACTIVITY_FILE: activityFile,
      PI_SUBAGENT_AUTO_EXIT: "1",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const config = getBehaviorConfig();
    const oldClose = config.closeOnDone;
    config.closeOnDone = completion === "close:false";
    Object.assign(process.env, env);
    const handlers = new Map<string, Function[]>();
    const tools = new Map<string, any>();
    let shutdowns = 0;
    const ctx = {
      shutdown: () => { shutdowns++; },
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionFile: () => env.PI_SUBAGENT_SESSION },
    };
    const emit = async (name: string, event = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };
    const read = () => {
      const result = readSubagentActivityFile(activityFile, runId);
      assert.ok(result.ok);
      return result.activity;
    };
    try {
      childExtension({
        on: (name: string, handler: Function) => {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand() {},
        registerShortcut() {},
      } as any);
      await emit("before_agent_start");
      await emit("agent_start");
      if (completion === "close:false") {
        await tools.get("subagent_done").execute("done", { close: false }, undefined, undefined, ctx);
        assert.equal(read().phase, "done");
      }
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
      await emit("agent_settled", { aborted: false });
      assert.equal(shutdowns, 0);
      const completed = read();
      if (completion === "natural") assert.equal(completed.phase, "done");
      await emit("input");
      await emit("before_agent_start");
      assert.ok(read().sequence > completed.sequence, "kept-open follow-up must publish new activity");
      await emit("agent_start");
      await emit("turn_start", { turnIndex: 1 });
      await emit("before_provider_request");
      assert.equal(read().activeScope, "provider");
      await emit("after_provider_response");
      await emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
      t.mock.timers.tick(500);
      assert.equal(read().activeScope, "streaming");
      await emit("tool_execution_start", { toolCallId: "follow-up-tool", toolName: "bash" });
      const active = read();
      assert.equal(active.activeScope, "tool");

      let lifecycle = observeActivity(createLifecycle(1_000), { ok: true, activity: active }, Date.now());
      lifecycle = markInterruptRequested(lifecycle, Date.now());
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
      await emit("agent_settled", { aborted: true });
      lifecycle = observeActivity(lifecycle, { ok: true, activity: read() }, Date.now());
      assert.equal(lifecycle.turn.kind, "interrupted");
      await emit("input");
      await emit("before_agent_start");
      const resumed = read();
      assert.ok(resumed.sequence > active.sequence);
      lifecycle = observeActivity(lifecycle, { ok: true, activity: resumed }, Date.now());
      assert.equal(lifecycle.turn.kind, "active");
      assert.equal(shutdowns, 0);
    } finally {
      await emit("session_shutdown", { reason: "reload" });
      delete (globalThis as any)[Symbol.for(`pi-subagents/keep-open/${runId}`)];
      config.closeOnDone = oldClose;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
