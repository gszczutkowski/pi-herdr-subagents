import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension, { enqueueSubagentCompletion, enqueueSubagentError } from "../pi-extension/subagents/index.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { flushDeliveries, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { getSubagentConfig } from "../pi-extension/subagents/config.ts";
import { CONTEXT_CHECKPOINT_CONTEXT_TYPE } from "../pi-extension/subagents/context-checkpoint.ts";
import { PLAN_CONTEXT_TYPE } from "../pi-extension/subagents/plan-context.ts";

const roleNames = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"] as const;
const savedRole = roleNames.map(name => process.env[name]);
before(() => { for (const name of roleNames) delete process.env[name]; });
after(() => roleNames.forEach((name, index) => { if (savedRole[index] === undefined) delete process.env[name]; else process.env[name] = savedRole[index]; }));

test("production wiring preserves checkpoint/plan through compaction and bounds each durable report before handoff/retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-protection-"));
  const sm = SessionManager.create(dir, dir);
  const first = sm.appendMessage({ role: "user", content: "Protect context", timestamp: 1 });
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
  let fail = true; let sends = 0;
  const ctx: any = { sessionManager: sm, hasUI: false, scopedModels: [],
    modelRegistry: { find() {}, getAvailable() { return []; } } };
  const pi: any = {
    on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getAllTools() { return []; }, getSettings() { return {}; },
    appendEntry(type: string, data: any) { ctx.sessionManager.appendCustomEntry(type, data); },
    sendUserMessage() { assert.fail("checkpoint/projection must not start a turn"); },
    sendMessage() { sends++; if (fail) throw new Error("Injected handoff failure"); },
  };
  const emit = async (name: string, event: any = {}) => {
    for (const handler of events.get(name) ?? []) {
      const result: any = await handler(event, ctx);
      if (result?.messages) event = { ...event, messages: result.messages };
      if (result?.cancel) return result;
    }
    return event;
  };
  let store: RuntimeStore | undefined;
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" });
    assert.ok(tools.has("context_checkpoint"));
    assert.ok(events.has("turn_end"));
    const call = (tool: string, args: any) => tools.get(tool).execute("test", args, undefined, undefined, ctx);
    const plan = (await call("plan_update", { expectedRevision: 0, command: { action: "create", title: "Verified migration" } })).details;
    const state = { goal: "Preserve migration state", decisions: ["Keep existing schema"], nextSteps: ["Review report artifact"], verification: ["Unit tests passed"], refs: ["docs/report.md"] };
    await call("context_checkpoint", { action: "save", ...state });
    await call("plan_update", { expectedRevision: 0, command: { action: "add", planId: plan.planId, title: "Review migration" } });
    assert.equal((await emit("session_before_compact", { reason: "manual" })).cancel, undefined);
    const snapshot = await call("context_checkpoint", { action: "read" });
    assert.deepEqual(snapshot.details.checkpoint.workingState, state);
    assert.equal(snapshot.details.checkpoint.plan.revision, 1);

    store = new RuntimeStore(join(dir, "runtime"), { sessionFile: sm.getSessionFile()!, headerId: sm.getSessionId(), branchToken: "test", checkpoint: first });
    runtime.store = store; runtime.delivery.store = store;
    const child = (id: string): any => ({ id, name: id, task: "Migration review", sessionFile: join(dir, "child.jsonl"), startTime: 1,
      lifecycle: createLifecycle(1), interactive: false, runtimePlan: undefined, durableStore: store });
    const full = "Verified findings 日本語 🚀\n".repeat(5000);
    for (const kind of ["result", "ping", "provider-error", "watcher-error"] as const) {
      const running = child(kind);
      store.prepare(running);
      if (kind === "watcher-error") enqueueSubagentError(running, new Error(full));
      else enqueueSubagentCompletion(running, { name: kind, task: "Review", summary: full, exitCode: 0, elapsed: 1, sessionFile: running.sessionFile,
        ...(kind === "ping" ? { ping: { name: kind, message: full } } : {}),
        ...(kind === "provider-error" ? { errorMessage: full } : {}) });
    }
    pauseDeliveries(runtime.delivery);
    assert.ok(sends >= 4);
    const initialSends = sends;
    const manifestBefore = readFileSync(join(dir, "runtime", "manifest.json"), "utf8");
    const outbox = store.snapshot().outbox;
    assert.equal(Object.keys(outbox).length, 4);
    for (const event of Object.values(outbox)) {
      const message = event.envelope.message;
      assert.ok(Buffer.byteLength(String(message.content), "utf8") <= getSubagentConfig().contextProtection.maxReportBytes);
      assert.equal(event.status, "pending");
      const ref = /Full content and details: (.+)\]/.exec(String(message.content))![1];
      const artifact = JSON.parse(readFileSync(ref, "utf8"));
      assert.ok(String(artifact.message.content).includes(full));
      assert.equal(artifact.runId, event.runId);
    }

    sm.appendCompaction("Older conversation summarized without working-state details", null, 100000);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    ctx.sessionManager = reopened;
    const sessionBefore = readFileSync(sm.getSessionFile()!, "utf8");
    const projected = await emit("context", { messages: reopened.buildSessionContext().messages });
    const checkpointMessages = projected.messages.filter((message: any) => message.role === "custom" && message.customType === CONTEXT_CHECKPOINT_CONTEXT_TYPE);
    const planMessages = projected.messages.filter((message: any) => message.role === "custom" && message.customType === PLAN_CONTEXT_TYPE);
    assert.equal(checkpointMessages.length, 1); assert.match(checkpointMessages[0].content, /Keep existing schema/);
    assert.equal(planMessages.length, 1); assert.match(planMessages[0].content, /revision=1/);
    assert.match(planMessages[0].content, /Review migration/);
    assert.equal(readFileSync(join(dir, "runtime", "manifest.json"), "utf8"), manifestBefore);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), sessionBefore);
    assert.equal(sends, initialSends, "projection/compaction never retries or replays reports");
    fail = false;
    runtime.delivery.api = pi;
    for (const entry of runtime.delivery.pending.values()) entry.retryAt = 0;
    flushDeliveries(runtime.delivery);
    assert.equal(sends, initialSends + 4);
    assert.equal(runtime.delivery.pending.size, 0);
    assert.ok(Object.values(store.snapshot().outbox).every(event => event.status === "handedOff"));
  } finally {
    pauseDeliveries(runtime.delivery);
    await emit("session_shutdown", { reason: "quit" });
    rmSync(dir, { recursive: true, force: true });
  }
});
