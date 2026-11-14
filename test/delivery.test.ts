import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDeliveryState, enqueueDelivery, flushDeliveries, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import extension, { enqueueSubagentCompletion } from "../pi-extension/subagents/index.ts";

const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
const ctx = { hasUI: false, modelRegistry: { find() {}, getAvailable() { return []; } }, scopedModels: [] };
function install(sendMessage: (...args: any[]) => void) {
  const handlers = new Map<string, any>();
  extension({
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, registerShortcut() {},
    registerMessageRenderer() {}, getAllTools() { return []; }, sendMessage,
  } as any);
  return {
    start: () => handlers.get("session_start")({ reason: "reload" }, ctx),
    shutdown: (reason: string) => handlers.get("session_shutdown")({ reason }, ctx),
  };
}
function child(id: string) {
  return { id, name: id, task: "task", sessionFile: "/tmp/child.jsonl", startTime: Date.now(),
    lifecycle: createLifecycle(Date.now()), interactive: false, runtimePlan: undefined,
    abortController: new AbortController(), surface: "test" };
}
const result = { name: "child", task: "task", summary: "original", elapsed: 1, exitCode: 0, sessionFile: "/tmp/child.jsonl" };

const message = { customType: "subagent_result", content: "original result", display: true, details: { response: "original result" } };

describe("extension delivery readiness", () => {
  it("retains completion in both shutdown/factory gaps and flushes only at replacement session_start", () => {
    const stale: any[] = [];
    const old = install((payload) => stale.push(payload));
    old.start();
    const first = child("shutdown-gap");
    const second = child("factory-gap");
    runtime.runningSubagents.set(first.id, first);
    runtime.runningSubagents.set(second.id, second);
    old.shutdown("reload");
    assert.equal(runtime.delivery.api, undefined);
    enqueueSubagentCompletion(first, result);
    assert.equal(first.lifecycle.delivery, "pending");
    const fresh: any[] = [];
    const replacement = install((payload) => fresh.push(payload));
    enqueueSubagentCompletion(second, result);
    assert.equal(fresh.length, 0);
    assert.equal(stale.length, 0);
    replacement.start();
    replacement.start();
    assert.equal(fresh.length, 2);
    assert.equal(first.lifecycle.delivery, "delivered");
    assert.equal(second.lifecycle.delivery, "delivered");
    assert.equal(runtime.runningSubagents.size, 0);
    replacement.shutdown("quit");
  });
});

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
