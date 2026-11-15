import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUE_COMMAND, continuationDir, continueLiveChild, reconcileContinuation, registerLiveContinuation } from "../pi-extension/subagents/live-continuation.ts";
import { canonicalSessionPath, releaseSession, sessionOwners } from "../pi-extension/subagents/ownership.ts";
import { createLifecycle, markInterruptRequested, markProcessRunning } from "../pi-extension/subagents/lifecycle.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { reconcileRuntime } from "../pi-extension/subagents/runtime-recovery.ts";
import { closeOwnedChild } from "../pi-extension/subagents/close-control.ts";

for (const reload of [false, true]) for (const accepted of [false, true]) {
  test(`late ${accepted ? "acceptance" : "rejection"}, reload=${reload}: reconcile without resend`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "late-continuation-"));
    const runId = randomUUID();
    const sessionFile = canonicalSessionPath(join(dir, "child.jsonl"));
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "child", cwd: dir }) + "\n");
    const activityFile = join(dir, "activity.json");
    const parent = { sessionFile: join(dir, "parent.jsonl"), headerId: "parent", branchToken: "branch", checkpoint: "cp" };
    let store = new RuntimeStore(join(dir, "runtime"), parent);
    const child = { id: runId, name: "Worker", cli: "pi", sessionFile, activityFile, surface: "pane",
      lifecycle: markInterruptRequested(markProcessRunning(createLifecycle(1), 2), 3) };
    const owner = { runId, dispatched: true, continuationRequestId: undefined as string | undefined };
    const env = { PI_SUBAGENT_ID: runId, PI_SUBAGENT_SESSION: sessionFile, PI_SUBAGENT_ACTIVITY_FILE: activityFile };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const events = new Map<string, Function>();
    let receive!: Function;
    let sends = 0;
    let idle = true;
    let stop: (() => void) | undefined;
    const ctx = { isIdle: () => idle, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => sessionFile } };
    try {
      Object.assign(process.env, env);
      registerLiveContinuation({ on: (name: string, fn: Function) => events.set(name, fn),
        registerCommand: (name: string, command: any) => { assert.equal(name, CONTINUE_COMMAND); receive = command.handler; },
        sendUserMessage: () => { sends++; } } as any);
      events.get("session_start")!({}, ctx);
      events.get("agent_settled")!({ aborted: true }, ctx);
      store.prepare({ ...child, task: "task", startTime: 1 });
      const transport = { inspect: async () => ({ kind: "present", agentStatus: "idle", observedAt: Date.now() } as const), timeoutMs: 0,
        beforeSend: () => store.continuation(runId, owner.continuationRequestId!),
        settled: (requestId: string) => store.settleContinuation(runId, requestId) };
      const pending = await continueLiveChild(owner, child, { message: "original message" }, transport);
      assert.equal(pending.status, "pending");
      // A child-side receipt arrives only after the parent timeout.
      idle = accepted;
      receive(pending.requestId, ctx);
      assert.equal(sends, accepted ? 1 : 0);
      if (reload) {
        store.close();
        store = new RuntimeStore(join(dir, "runtime"), parent);
        // Recovery is artifact-only; it consumes receipts without restoring terminal control.
        const manifest = store.snapshot();
        assert.equal(manifest.runs[runId].continuationRequestId, pending.requestId);
        stop = await reconcileRuntime(store, () => assert.fail("no completion expected"), () => true);
        assert.equal(sessionOwners.get(sessionFile)?.continuationRequestId, undefined);
      } else {
        if (accepted) {
          const resolved = await continueLiveChild(owner, child, { message: "MUST NOT DISPATCH THIS RECHECK" }, transport);
          assert.deepEqual(resolved, { requestId: pending.requestId, status: "accepted" });
        } else {
          await assert.rejects(continueLiveChild(owner, child, { message: "MUST NOT DISPATCH" }, transport), /Child rejected/);
        }
        assert.equal(owner.continuationRequestId, undefined);
      }
      assert.equal(store.snapshot().runs[runId].continuationRequestId, undefined);
      assert.equal(sends, accepted ? 1 : 0);
      assert.equal(readdirSync(continuationDir(activityFile)).filter(name => name.endsWith(".request.json")).length, 1);
      // CLOSE is no longer blocked by the late acknowledgement; identity remains mandatory.
      const currentOwner = reload ? sessionOwners.get(sessionFile)! : owner;
      await assert.rejects(closeOwnedChild(currentOwner, child, { validate() {} }), /lacks verified process identity/);
      store.close();
      store = new RuntimeStore(join(dir, "runtime"), parent);
      assert.equal(store.snapshot().runs[runId].continuationRequestId, undefined, "resolution survives another reload");
    } finally {
      stop?.();
      events.get("session_shutdown")?.({}, ctx);
      store.close();
      releaseSession(sessionFile, runId);
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("foreign/malformed receipts and failed durable settlement retain the original fence", () => {
  const dir = mkdtempSync(join(tmpdir(), "late-invalid-"));
  try {
    const requestId = randomUUID();
    const child = { id: "run", sessionFile: canonicalSessionPath(join(dir, "child.jsonl")), activityFile: join(dir, "activity") };
    const owner = { runId: "run", continuationRequestId: requestId };
    const d = continuationDir(child.activityFile);
    // Creating the protocol directory via an independent fixture write is sufficient here.
    const request = { runId: child.id, requestId, sessionFile: child.sessionFile, idleToken: randomUUID(), message: "task" };
    mkdirSync(d);
    writeFileSync(join(d, `${requestId}.request.json`), JSON.stringify(request));
    writeFileSync(join(d, `${requestId}.claim.json`), JSON.stringify({ runId: child.id, requestId, status: "dispatching" }));
    const result = { ...request, status: "accepted" };
    for (const patch of [{ runId: "foreign" }, { requestId: randomUUID() }, { sessionFile: "other" }, { idleToken: randomUUID() }, { status: "dispatching" }]) {
      writeFileSync(join(d, `${requestId}.result.json`), JSON.stringify({ ...result, ...patch }));
      assert.equal(reconcileContinuation(owner, child), undefined);
      assert.equal(owner.continuationRequestId, requestId);
    }
    writeFileSync(join(d, `${requestId}.result.json`), JSON.stringify(result));
    assert.throws(() => reconcileContinuation(owner, child, () => { throw new Error("disk failure"); }), /disk failure/);
    assert.equal(owner.continuationRequestId, requestId);
    assert.equal(JSON.parse(readFileSync(join(d, `${requestId}.result.json`), "utf8")).status, "accepted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
