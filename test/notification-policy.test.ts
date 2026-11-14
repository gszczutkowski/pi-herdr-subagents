import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryState, enqueueDelivery, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
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
