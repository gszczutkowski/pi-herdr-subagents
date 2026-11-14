import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDeliveryState, enqueueDelivery, flushDeliveries, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

const message = { customType: "subagent_result", content: "original result", display: true, details: { response: "original result" } };

describe("completion outbox", () => {
  it("retains the exact immutable envelope and pending lifecycle on sync throw, then retries without child/status timers", async () => {
    const state = createDeliveryState();
    const owner = { id: "run", lifecycle: createLifecycle(0) };
    const attempts: any[] = [];
    let handedOff = 0;
    state.api = { sendMessage(payload, options) {
      attempts.push({ payload, options });
      assert.equal(owner.lifecycle.delivery, "pending");
      assert.equal(state.pending.size, 1, "enqueued before attempting");
      if (attempts.length === 1) throw new Error("not ready");
    } };
    enqueueDelivery(state, owner, message, () => { handedOff++; });
    assert.equal(owner.lifecycle.delivery, "pending");
    assert.equal(state.pending.size, 1);
    assert.equal(handedOff, 0);
    assert.ok(Object.isFrozen(attempts[0].payload.details));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].payload, attempts[1].payload);
    assert.equal(attempts[0].options, attempts[1].options);
    assert.equal(attempts[1].payload.content, "original result");
    assert.equal(owner.lifecycle.delivery, "delivered");
    assert.equal(state.pending.size, 0);
    assert.equal(handedOff, 1);
    flushDeliveries(state);
    assert.equal(attempts.length, 2);
    pauseDeliveries(state);
  });

  it("deduplicates pending and handed-off IDs without replacing the first payload", () => {
    const state = createDeliveryState();
    const owner = { id: "duplicate", lifecycle: createLifecycle(0) };
    enqueueDelivery(state, owner, message, () => {});
    const original = [...state.pending.values()][0].envelope;
    enqueueDelivery(state, owner, { ...message, content: "replacement error" }, () => assert.fail("replacement callback"));
    assert.equal(state.pending.size, 1);
    assert.equal([...state.pending.values()][0].envelope, original);
    let calls = 0;
    state.api = { sendMessage(payload) {
      calls++;
      assert.equal(payload, original.message);
      assert.equal((payload.details as any).eventId, "subagent:duplicate:completion");
      flushDeliveries(state); // A reentrant start/flush must not resend.
    } };
    flushDeliveries(state);
    enqueueDelivery(state, { id: owner.id, lifecycle: createLifecycle(0) }, message, () => assert.fail("duplicate"));
    flushDeliveries(state);
    assert.equal(calls, 1);
    assert.equal(state.handedOff.size, 1);
    assert.equal(state.pending.size, 0);
    pauseDeliveries(state);
  });

  it("queues without an API", () => {
    const state = createDeliveryState();
    const owner = { id: "gap", lifecycle: createLifecycle(0) };
    enqueueDelivery(state, owner, message, () => {});
    assert.equal(state.pending.size, 1);
    assert.equal(owner.lifecycle.delivery, "pending");
    assert.equal(state.timer, undefined);
  });
});
