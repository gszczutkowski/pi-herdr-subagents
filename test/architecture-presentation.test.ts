import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_WIDGET } from "../pi-extension/subagents/plan-view-registration.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { createDeliveryState, enqueueDelivery, flushDeliveries, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

test("native plan UI and context are read-only projections independent of durable delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "architecture-presentation-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const saved = { id: process.env.PI_SUBAGENT_ID, session: process.env.PI_SUBAGENT_SESSION };
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const widgets = new Map<string, any>();
  let appends = 0; let messages = 0; let notices = 0; let sends = 0;
  const api: any = { registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    appendEntry(type: string, data: any) { appends++; sm.appendCustomEntry(type, data); },
    sendMessage() { messages++; }, sendUserMessage() { messages++; } };
  const ctx: any = { hasUI: true, mode: "tui", sessionManager: sm, ui: {
    setWidget: (name: string, value: any) => widgets.set(name, value), notify() { notices++; },
  } };
  const persistence = registerPlanTools(api);
  const emit = async (name: string, event = {}) => {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  };
  const read = () => persistence.read(ctx.sessionManager).snapshot!;
  const mutate = (fn: any) => persistence.mutate(sm, read().planId, read().revision, fn);
  const render = () => widgets.get(PLAN_WIDGET)?.({}, { fg: (_: string, text: string) => text }).render(160).join("\n") ?? "";
  let runtime: RuntimeStore | undefined;
  const delivery = createDeliveryState();
  try {
    await emit("session_start");
    persistence.create(sm, 0, "Durable parent plan");
    const criterionId = randomUUID();
    mutate((p: any, c: any) => store.addTask(p, c, "Accepted work", { criteria: [{ criterionId, text: "Parent verification" }] }));
    const taskId = read().tasks[0].taskId;
    mutate((p: any, c: any) => store.startAttempt(p, c, taskId));
    const binding = bindPlanRun(persistence, ctx, "run", { planId: read().planId, taskId,
      attemptId: read().tasks[0].attempts[0].attemptId, expectedRevision: read().revision })!;
    mutate((p: any, c: any) => store.submitReview(p, c, taskId, "Parent review"));
    mutate((p: any, c: any) => store.addEvidence(p, c, taskId, { criterionId, ref: "Verified report" }));
    mutate((p: any, c: any) => store.accept(p, c, taskId, { [criterionId]: p.tasks[0].evidence.map((e: any) => e.evidenceId) }, "Parent verified"));
    const acceptedTip = sm.getLeafId()!;
    runtime = new RuntimeStore(join(dir, "runtime"), { sessionFile: sm.getSessionFile()!, headerId: sm.getSessionId(), branchToken: "token", checkpoint: acceptedTip });
    runtime.prepare({ id: "run", name: "Worker", task: "Work", startTime: 1, sessionFile: join(dir, "child.jsonl"), planTask: binding });
    delivery.store = runtime;
    delivery.onEnvelope = (id, envelope) => importPlanEnvelope(persistence, ctx, binding, id, envelope);
    delivery.api = { sendMessage() { sends++; throw new Error("Injected synchronous handoff failure"); } };
    enqueueDelivery(delivery, { id: "run", lifecycle: createLifecycle(1) }, {
      customType: "subagent_result", display: true, content: "Late worker result", details: { exitCode: 0, sessionFile: "child.jsonl" },
    }, () => {}, "late");
    pauseDeliveries(delivery);
    assert.equal(sends, 1);
    assert.equal(delivery.pending.size, 1);
    assert.equal(read().tasks[0].status, "accepted", "delivery failure/late import cannot erase parent acceptance");
    const accepted = read();
    const sessionBytes = readFileSync(sm.getSessionFile()!, "utf8");
    const runtimeBytes = readFileSync(join(dir, "runtime", "manifest.json"), "utf8");
    const beforeAppends = appends;
    const beforeOutbox = runtime.snapshot().outbox;
    assert.equal(Object.values(beforeOutbox)[0].status, "pending");
    for (const mode of ["full", "compact", "details T1"]) {
      await commands.get("plan-view").handler(mode, ctx);
      assert.match(render(), /accepted/);
      for (const width of [1, 20, 80]) widgets.get(PLAN_WIDGET)({}, { fg: (_: string, text: string) => text }).render(width);
      const context = await emit("context", { messages: [] });
      assert.match(JSON.stringify(context), /accepted/);
    }
    await emit("session_start", { reason: "reload" });
    await emit("session_tree");
    assert.equal(appends, beforeAppends);
    assert.equal(messages, 0);
    assert.equal(notices, 0);
    assert.equal(sends, 1, "UI/context refresh never retries transport");
    assert.deepEqual(runtime.snapshot().outbox, beforeOutbox);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), sessionBytes);
    assert.equal(readFileSync(join(dir, "runtime", "manifest.json"), "utf8"), runtimeBytes);

    // Clear the widget and reopen the native session: presentation owns no state.
    await emit("session_shutdown");
    assert.equal(widgets.get(PLAN_WIDGET), undefined);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    ctx.sessionManager = reopened;
    await emit("session_start", { reason: "resume" });
    assert.deepEqual(read(), accepted);
    assert.match(render(), /accepted/);
    // A native branch before late import selects the earlier accepted snapshot,
    // not the latest widget cache or the physical file tail.
    reopened.branch(acceptedTip);
    await emit("session_tree");
    assert.equal(read().tasks[0].attempts[0].results.length, 0);
    assert.equal(read().tasks[0].status, "accepted");
    assert.match(JSON.stringify(await emit("context", { messages: [] })), /accepted/);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), sessionBytes);
    assert.deepEqual(runtime.snapshot().outbox, beforeOutbox);

    delivery.api = { sendMessage() { sends++; } };
    for (const entry of delivery.pending.values()) entry.retryAt = 0;
    flushDeliveries(delivery);
    assert.equal(delivery.pending.size, 0);
    assert.equal(Object.values(runtime.snapshot().outbox)[0].status, "handedOff");
    assert.equal(read().tasks[0].status, "accepted");
    assert.equal(appends, beforeAppends, "handoff cannot mutate task storage");
  } finally {
    pauseDeliveries(delivery);
    runtime?.close();
    if (saved.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = saved.id;
    if (saved.session === undefined) delete process.env.PI_SUBAGENT_SESSION; else process.env.PI_SUBAGENT_SESSION = saved.session;
    rmSync(dir, { recursive: true, force: true });
  }
});
