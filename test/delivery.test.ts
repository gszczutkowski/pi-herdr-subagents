import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getSubagentConfig } from "../pi-extension/subagents/config.ts";
import { createDeliveryState, enqueueDelivery, flushDeliveries, pauseDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import extension, { enqueueSubagentCompletion, enqueueSubagentError, observeSubagentCompletion } from "../pi-extension/subagents/index.ts";

const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
const ctx = { hasUI: false, modelRegistry: { find() {}, getAvailable() { return []; } }, scopedModels: [] };
function install(sendMessage: (...args: any[]) => void, factory = extension) {
  const handlers = new Map<string, any>();
  factory({
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
  it("retains completion in both shutdown/factory gaps and flushes only at replacement session_start", async () => {
    const stale: any[] = [];
    const old = install((payload) => stale.push(payload));
    old.start();
    const first = child("shutdown-gap");
    const second = child("factory-gap");
    runtime.runningSubagents.set(first.id, first);
    runtime.runningSubagents.set(second.id, second);
    old.shutdown("reload");
    assert.equal(runtime.delivery.api, undefined);
    await observeSubagentCompletion(first, Promise.resolve(result));
    const original = [...runtime.delivery.pending.values()][0].envelope;
    assert.equal(first.lifecycle.delivery, "pending");
    // Re-evaluate the module, as /reload does, retaining the same global outbox.
    const reloaded = await import("../pi-extension/subagents/index.ts?delivery-reload-test");
    const fresh: any[] = [];
    const replacement = install((payload) => fresh.push(payload), reloaded.default);
    await observeSubagentCompletion(second, Promise.resolve(result));
    enqueueSubagentError(first, new Error("duplicate callback must not replace result"));
    assert.equal([...runtime.delivery.pending.values()][0].envelope, original);
    assert.equal(fresh.length, 0);
    assert.equal(stale.length, 0);
    replacement.start();
    replacement.start();
    assert.equal(fresh.length, 2);
    assert.equal(fresh[0], original.message);
    assert.equal(fresh[0].details.eventId, "subagent:shutdown-gap:completion");
    enqueueSubagentCompletion(child(first.id), result);
    flushDeliveries(runtime.delivery);
    assert.equal(fresh.length, 2, "handed-off IDs survive module replacement");
    assert.equal(first.lifecycle.delivery, "delivered");
    assert.equal(second.lifecycle.delivery, "delivered");
    assert.equal(runtime.runningSubagents.size, 0);
    replacement.shutdown("quit");
  });
});

describe("spawn/resume watcher dispatch regressions", () => {
  for (const resumed of [false, true]) {
    for (const kind of ["result", "ping", "provider-error", "watcher-error"]) {
      it(`${resumed ? "resume" : "spawn"} ${kind}: retries original envelope with status disabled and no active children`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-delivery-"));
        const sessionPath = join(dir, "session.jsonl");
        writeFileSync(sessionPath, ["old", "new resume response"].map((text, i) => JSON.stringify({
          type: "message", id: String(i), message: { role: "assistant", content: [{ type: "text", text }] },
        })).join("\n"));
        const status = getSubagentConfig().status;
        const previousEnabled = status.enabled;
        status.enabled = false;
        const attempts: any[] = [];
        const lifecycle = install((payload, options) => {
          attempts.push({ payload, options });
          if (attempts.length === 1) throw new Error("synchronous transport failure");
        });
        try {
          lifecycle.start();
          const running = child(`${resumed}-${kind}`);
          running.sessionFile = sessionPath;
          assert.equal(runtime.runningSubagents.size, 0, "no child-driven refresh can drive retries");
          const resume = resumed ? { sessionPath, entryCountBefore: 1 } : undefined;
          const output = { ...result, sessionFile: sessionPath,
            ...(kind === "ping" ? { ping: { name: "Worker", message: "Need help" } } : {}),
            ...(kind === "provider-error" ? { errorMessage: "Provider unavailable", exitCode: 1 } : {}),
          };
          await observeSubagentCompletion(running, kind === "watcher-error"
            ? Promise.reject(new Error("Watcher failed")) : Promise.resolve(output), resume);
          assert.equal(status.enabled, false);
          assert.equal(running.lifecycle.delivery, "pending");
          assert.equal(runtime.delivery.pending.size, 1);
          const original = [...runtime.delivery.pending.values()][0].envelope;
          // Duplicate terminal callbacks, including a competing error, cannot overwrite it.
          await observeSubagentCompletion(running, Promise.resolve({ ...output, summary: "replacement" }), resume);
          await observeSubagentCompletion(running, Promise.reject(new Error("replacement error")), resume);
          flushDeliveries(runtime.delivery);
          lifecycle.start();
          assert.equal(attempts.length, 1, "duplicates must respect retry backoff");
          assert.equal([...runtime.delivery.pending.values()][0].envelope, original);
          await new Promise((resolve) => setTimeout(resolve, 350));
          assert.equal(attempts.length, 2);
          assert.equal(attempts[0].payload, attempts[1].payload);
          assert.equal(attempts[0].options, attempts[1].options);
          assert.equal(attempts[1].payload, original.message);
          const payload = attempts[1].payload;
          assert.equal(payload.details.eventId, `subagent:${running.id}:completion`);
          assert.deepEqual(attempts[1].options, { triggerTurn: true, deliverAs: "steer" });
          assert.equal(payload.customType, kind === "ping" ? "subagent_ping" : "subagent_result");
          assert.equal(payload.details.sessionFile, sessionPath);
          if (kind === "ping") assert.equal(payload.details.message, "Need help");
          else assert.equal(payload.details.response, kind === "watcher-error" ? "Watcher failed"
            : kind === "provider-error" ? "Error: Provider unavailable"
              : resumed ? "new resume response" : "original");
          assert.equal(running.lifecycle.delivery, "delivered");
          assert.equal(runtime.delivery.pending.size, 0);
          await observeSubagentCompletion(child(running.id), Promise.resolve(output), resume);
          flushDeliveries(runtime.delivery);
          lifecycle.start();
          assert.equal(attempts.length, 2, "no resend after handoff");
        } finally {
          lifecycle.shutdown("quit");
          status.enabled = previousEnabled;
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  for (const reason of ["quit", "new", "resume", "fork"]) {
    it(`${reason} clears session deliveries and suppresses late resolved/rejected callbacks`, async () => {
      const attempts: any[] = [];
      let fail = false;
      const old = install(() => { if (fail) throw new Error("retry pending"); });
      old.start();
      enqueueSubagentCompletion(child("previously-handed-off"), result);
      assert.equal(runtime.delivery.handedOff.size, 1);
      fail = true;
      const pending = child(`pending-${reason}`);
      const late = child(`late-${reason}`);
      runtime.runningSubagents.set(pending.id, pending);
      runtime.runningSubagents.set(late.id, late);
      enqueueSubagentCompletion(pending, result);
      let resolve!: (value: typeof result) => void;
      let reject!: (error: Error) => void;
      const resolved = observeSubagentCompletion(late, new Promise((r) => { resolve = r; }));
      const rejected = observeSubagentCompletion(late, new Promise((_r, j) => { reject = j; }));
      old.shutdown(reason);
      assert.equal(runtime.delivery.api, undefined);
      assert.equal(runtime.delivery.timer, undefined);
      assert.equal(runtime.delivery.pending.size, 0);
      assert.equal(runtime.delivery.handedOff.size, 0);
      assert.equal(runtime.runningSubagents.size, 0);
      assert.equal(runtime.modelCatalog, undefined);
      assert.equal(runtime.agentCatalog, undefined);
      assert.equal(pending.lifecycle.delivery, "suppressed");
      assert.equal(late.lifecycle.delivery, "suppressed");
      assert.equal(late.abortController.signal.aborted, true);
      const fresh = install((payload) => attempts.push(payload));
      fresh.start();
      resolve(result);
      reject(new Error("late watcher rejection"));
      await Promise.all([resolved, rejected]);
      enqueueSubagentCompletion(pending, result);
      flushDeliveries(runtime.delivery);
      assert.equal(attempts.length, 0, "nothing from the old session may leak");
      enqueueSubagentCompletion(child("previously-handed-off"), result);
      assert.equal(attempts.length, 1, "deduplication state belongs to the old session only");
      fresh.shutdown("quit");
    });
  }

  it("initializes an empty pre-R3 runtime without treating its captured API as ready (active legacy watchers are not migrated)", () => {
    const script = `
      import assert from 'node:assert/strict';
      const key = Symbol.for('pi-subagents/runtime');
      const old = { runningSubagents: new Map(), pi: { sendMessage() { throw new Error('stale'); } } };
      globalThis[key] = old;
      const { default: extension } = await import('./pi-extension/subagents/index.ts');
      assert.equal(globalThis[key], old);
      assert.equal(old.delivery.pending.size, 0);
      assert.equal(old.delivery.handedOff.size, 0);
      assert.equal(old.delivery.api, undefined);
      assert.equal(old.delivery.timer, undefined);
      extension({ on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {},
        registerMessageRenderer() {}, getAllTools() { return []; }, sendMessage() { assert.fail('factory not ready'); } });
      assert.equal(old.pi, undefined);
      assert.equal(old.delivery.api, undefined);
      assert.equal(old.delivery.timer, undefined);
    `;
    const check = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    assert.equal(check.status, 0, check.stdout + check.stderr);
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

  it("bounds exponential retry delays at 30 seconds and cancels retry resources when paused", () => {
    const state = createDeliveryState();
    const owner = { id: "backoff", lifecycle: createLifecycle(0) };
    state.api = { sendMessage() { throw new Error("still unavailable"); } };
    enqueueDelivery(state, owner, message, () => assert.fail("not handed off"));
    const entry = [...state.pending.values()][0];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = entry.retryAt - Date.now();
      const expected = Math.min(250 * 2 ** Math.min(attempt - 1, 7), 30_000);
      assert.ok(delay <= expected && delay >= expected - 100, `${delay} vs ${expected}`);
      assert.equal(entry.attempts, attempt);
      if (attempt < 12) {
        entry.retryAt = 0;
        flushDeliveries(state);
      }
    }
    pauseDeliveries(state);
    assert.equal(state.timer, undefined);
    assert.equal(state.api, undefined);
    assert.equal(state.pending.size, 1, "pausing for reload must retain the envelope");
    assert.equal(owner.lifecycle.delivery, "pending");
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
