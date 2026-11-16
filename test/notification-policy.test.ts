import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryState, enqueueDelivery, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle, observePaneInspection } from "../pi-extension/subagents/lifecycle.ts";
import extension, { refreshSubagentStatus, enqueueSubagentCompletion, enqueueSubagentError } from "../pi-extension/subagents/index.ts";
import { getSubagentConfig } from "../pi-extension/subagents/config.ts";
import { notificationOptions, notificationPolicy } from "../pi-extension/subagents/notification-policy.ts";

test("explicit actionable events wake; observations and presentation do not", () => {
  for (const reason of ["result", "help", "blocker", "question", "error", "decision"] as const) {
    assert.equal(notificationPolicy(reason), "wake");
    assert.deepEqual(notificationOptions(reason), { triggerTurn: true, deliverAs: "steer" });
  }
  for (const reason of ["progress", "stalled", "recovered", "presentation"] as const) {
    assert.equal(notificationPolicy(reason), "panel");
    assert.equal(notificationOptions(reason), undefined);
  }
});

test("production status refresh updates autonomous and interactive panels without sending; results/help/errors still wake", () => {
  const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const widgets: any[] = [];
  const now = Date.now();
  const status = getSubagentConfig().status;
  const previousEnabled = status.enabled;
  status.enabled = true;
  const ctx = { hasUI: true, ui: { setWidget: (_name: string, factory: any) => widgets.push(factory) },
    modelRegistry: { find() {}, getAvailable() { return []; } }, scopedModels: [] };
  extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerCommand() {},
    registerShortcut() {}, registerMessageRenderer() {}, getAllTools() { return []; },
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
    sendUserMessage: () => assert.fail("status refresh must not send user messages"),
  } as any);
  handlers.get("session_start")({ reason: "reload" }, ctx);
  try {
    for (const interactive of [false, true]) {
      const id = `quiet-${interactive}`;
      const running = { id, name: id, task: "task", cli: "pi", interactive, startTime: now - 120_000,
        sessionFile: "/tmp/quiet-child.jsonl", abortController: new AbortController(),
        lifecycle: observePaneInspection(createLifecycle(now - 120_000), { kind: "unavailable" }, now - 90_000) } as any;
      runtime.runningSubagents.set(id, running);
      const before = widgets.length;
      refreshSubagentStatus(now);
      assert.equal(running.lastProjectedKind, "stalled");
      assert.ok(widgets.length > before);
      assert.match(widgets.at(-1)({}, {}).render(160).join("\n"), /stalled/);
      running.lifecycle = observePaneInspection(running.lifecycle, { kind: "present", agentStatus: "working", observedAt: now }, now);
      refreshSubagentStatus(now);
      assert.equal(running.lastProjectedKind, "active");
      assert.match(widgets.at(-1)({}, {}).render(160).join("\n"), /agent working/);
      assert.equal(sent.length, 0, "neither stalled nor recovery wakes any parent");
      runtime.runningSubagents.delete(id);
    }
    for (const kind of ["result", "ping", "error"]) {
      const running = { id: kind, name: kind, task: "task", sessionFile: "/tmp/quiet-child.jsonl", lifecycle: createLifecycle(now) } as any;
      if (kind === "error") enqueueSubagentError(running, new Error("watcher failed"));
      else enqueueSubagentCompletion(running, { name: kind, task: "task", summary: "report", elapsed: 1, exitCode: 0,
        sessionFile: running.sessionFile, ...(kind === "ping" ? { ping: { name: kind, message: "Need decision" } } : {}) });
    }
    assert.equal(sent.length, 3);
    for (const { options } of sent) assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  } finally {
    status.enabled = previousEnabled;
    handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    runtime.runningSubagents.clear();
  }
});

test("production outbox admits actionable categories but never progress/status messages", () => {
  const state = createDeliveryState();
  const sent: any[] = [];
  state.api = { sendMessage: (message, options) => { sent.push({ message, options }); } };
  try {
    for (const customType of ["subagent_result", "subagent_ping", "subagent_blocker", "subagent_question", "subagent_decision", "subagent_status", "subagent_progress"]) {
      enqueueDelivery(state, { id: customType, lifecycle: createLifecycle(Date.now()) }, { customType, content: "Needs help? progress text is not authority", display: true }, () => {});
    }
    assert.equal(sent.length, 5);
    assert.equal(state.pending.size, 0);
    for (const { options } of sent) assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
    enqueueDelivery(state, { id: "error", lifecycle: createLifecycle(Date.now()) }, { customType: "subagent_result", content: "failure", details: { errorMessage: "provider error" }, display: true }, () => {});
    assert.equal(sent.length, 6);
  } finally { pauseDeliveries(state); }
});
