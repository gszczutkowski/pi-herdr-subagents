import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTINUE_COMMAND, continuationCommand, continuationDir, continueLiveChild, registerLiveContinuation } from "../pi-extension/subagents/live-continuation.ts";
import { canonicalSessionPath, type SessionOwner } from "../pi-extension/subagents/ownership.ts";
import { createLifecycle, markInterruptRequested, markProcessRunning, observeActivity, observePaneInspection, projectLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { createSubagentActivityRecorder, readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import { launchProfilePath, QUEUE_CHILD_ENV, queueChildMarkerPath } from "../pi-extension/subagents/queue-child-allocation.ts";

function fixture(queue = false) {
  const dir = mkdtempSync(join(tmpdir(), "live-continuation-"));
  const runId = randomUUID();
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");
  const activityFile = join(dir, "activity.json");
  const env = { PI_SUBAGENT_ID: runId, PI_SUBAGENT_SESSION: sessionFile, PI_SUBAGENT_ACTIVITY_FILE: activityFile };
  const previous = Object.fromEntries([...Object.keys(env), QUEUE_CHILD_ENV].map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  if (queue) process.env[QUEUE_CHILD_ENV] = "1"; else delete process.env[QUEUE_CHILD_ENV];
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  let idle = true;
  let pending = false;
  let failDispatch = false;
  const entries: any[] = [];
  const ctx = { isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionFile: () => sessionFile, getEntries: () => entries } };
  const pi = { on: (name: string, handler: Function) => events.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (...args: any[]) => { sent.push(args); if (failDispatch) throw new Error("API dispatch ambiguous"); } };
  registerLiveContinuation(pi as any);
  const child = { id: runId, name: "Worker", cli: "pi", sessionFile, activityFile, surface: "same-pane",
    lifecycle: markInterruptRequested(markProcessRunning(createLifecycle(1), 2), 3),
    abortController: new AbortController(), watcher: Promise.resolve(), task: "original" };
  const owner: SessionOwner = { runId, surface: child.surface, dispatched: true };
  const invoke = (text: string) => {
    const [command, requestId] = text.split(" ");
    assert.equal(command, `/${CONTINUE_COMMAND}`);
    commands.get(CONTINUE_COMMAND).handler(requestId, ctx);
  };
  const transport = { inspect: async () => ({ kind: "present", agentStatus: "idle", observedAt: Date.now() } as const),
    send: (_surface: string, _text: string) => { assert.fail("Terminal transport must never be used"); }, timeoutMs: 1000 };
  events.get("session_start")!({}, ctx);
  return { dir, runId, sessionFile, activityFile, child, owner, events, sent, commands, ctx, invoke, transport, entries,
    reopen: () => {
      events.get("session_shutdown")!({}, ctx);
      registerLiveContinuation(pi as any);
      events.get("session_start")!({ reason: "reload" }, ctx);
    },
    settle: (aborted = true) => events.get("agent_settled")!({ aborted }, ctx),
    idle: (value: boolean) => { idle = value; }, pending: (value: boolean) => { pending = value; },
    failDispatch: () => { failDispatch = true; },
    cleanup: () => {
      events.get("session_shutdown")!({}, ctx);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    } };
}

/** Fixed parent sampling of real recorder snapshots, including cancellation drain. */
function sampleInterruptedLifecycle(f: ReturnType<typeof fixture>, observedWorking = false, observedDrain = true) {
  let now = 1000;
  const recorder = createSubagentActivityRecorder({ runningChildId: f.runId, activityFile: f.activityFile, now: () => now });
  recorder.sessionStart();
  let lifecycle = observePaneInspection(createLifecycle(now), { kind: "present", agentStatus: "idle", observedAt: 1001 }, 1001);
  if (observedWorking) lifecycle = observePaneInspection(lifecycle, { kind: "present", agentStatus: "working", observedAt: 1005 }, 1005);
  lifecycle = markInterruptRequested(lifecycle, 1010);
  now = 1015;
  recorder.turnStart(1); // Newer activity can replace the local interrupt marker.
  if (observedDrain) {
    lifecycle = observeActivity(lifecycle, readSubagentActivityFile(f.activityFile, f.runId), now);
    assert.equal(lifecycle.turn.kind, "active", "parent really samples intermediate cancellation activity");
  }
  now = 1020;
  recorder.agentEndWaiting();
  lifecycle = observeActivity(lifecycle, readSubagentActivityFile(f.activityFile, f.runId), now);
  assert.equal(lifecycle.activityDetail, null);
  for (const at of [1030, 1040, 1050]) {
    lifecycle = observePaneInspection(lifecycle, { kind: "present", agentStatus: "idle", observedAt: at }, at);
  }
  return lifecycle;
}

for (const scenario of ["missed-working-and-observed-drain", "observed-working", "unobserved-drain"] as const) {
  test(`interrupted sampling: ${scenario} continues the existing child`, async () => {
    const f = fixture();
    try {
      f.child.lifecycle = sampleInterruptedLifecycle(f, scenario === "observed-working", scenario !== "unobserved-drain");
      assert.equal(f.child.lifecycle.hasWorked, scenario === "observed-working");
      const expected = scenario === "observed-working" ? "waiting" : scenario === "unobserved-drain" ? "interrupted" : "starting";
      assert.equal(f.child.lifecycle.turn.kind, expected);
      assert.equal(projectLifecycle(f.child.lifecycle, 1060).kind, expected);
      f.settle(true);
      let validations = 0;
      const result = await continueLiveChild(f.owner, f.child, { message: "resume after cancellation" }, {
        ...f.transport, beforeSend: () => { validations++; },
      });
      assert.equal(result.status, "accepted");
      assert.equal(validations, 1);
      assert.deepEqual(f.sent, [["resume after cancellation", { expandPromptTemplates: false }]]);
      assert.equal(f.owner.continuationRequestId, undefined);
      const dir = continuationDir(f.activityFile);
      assert.equal(readdirSync(dir).filter(name => name.endsWith(".request.json")).length, 1);
      assert.equal(readdirSync(dir).filter(name => name.endsWith(".claim.json")).length, 1);
    } finally { f.cleanup(); }
  });
}

test("starting parent needs interrupted proof; genuinely unstarted and ordinary settled children still reject", async () => {
  const f = fixture();
  try {
    f.child.lifecycle = observePaneInspection(createLifecycle(1), { kind: "present", agentStatus: "idle", observedAt: 2 }, 2);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "unstarted" }, f.transport), /not confirmed settled/);
    f.child.lifecycle = sampleInterruptedLifecycle(f);
    f.settle(false);
    for (const hasTurnResult of [false, true]) {
      await assert.rejects(continueLiveChild(f.owner, { ...f.child, hasTurnResult }, { message: "ordinary idle" }, f.transport), /starting parent/);
    }
    f.settle(true);
    const lifecycle = f.child.lifecycle;
    f.child.lifecycle = { ...lifecycle, process: createLifecycle(1).process };
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "process not confirmed running" }, f.transport), /not a tracked/);
    assert.equal(f.owner.continuationRequestId, undefined);
    assert.equal(readdirSync(continuationDir(f.activityFile)).some(name => name.endsWith(".request.json")), false);
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("native watcher callbacks contain ENOSPC/EACCES/EIO even when diagnostics also fail; claimed dispatch never replays", () => {
  const url = pathToFileURL(resolve("pi-extension/subagents/live-continuation.ts")).href;
  for (const code of ["ENOSPC", "EACCES", "EIO"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      import assert from 'node:assert/strict';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
      const dir=fs.mkdtempSync(join(tmpdir(),'continuation-io-')),session=join(dir,'child.jsonl'),activity=join(dir,'activity');
      fs.writeFileSync(session,'');Object.assign(process.env,{PI_SUBAGENT_ID:'run',PI_SUBAGENT_SESSION:session,PI_SUBAGENT_ACTIVITY_FILE:activity});
      let notify,watchError,closed=0,unref=0,fail=false,sends=0;
      const write=fs.writeFileSync;fs.writeFileSync=(...args)=>{if(fail)throw Object.assign(Error('${code}'),{code:'${code}'});return write(...args);};
      fs.watch=(_dir,fn)=>{notify=fn;return {close(){closed++},unref(){unref++},on(_event,fn){watchError=fn}}};syncBuiltinESMExports();
      const {registerLiveContinuation,CONTINUE_COMMAND,continuationDir}=await import(${JSON.stringify(url)});
      const hooks=new Map(),commands=new Map(),notices=[];
      const ctx={hasUI:true,ui:{notify:m=>notices.push(m)},isIdle:()=>true,hasPendingMessages:()=>false,sessionManager:{getSessionFile:()=>session}};
      registerLiveContinuation({on:(n,f)=>hooks.set(n,f),registerCommand:(n,c)=>commands.set(n,c),sendUserMessage:()=>{sends++;fail=true;throw Error('ambiguous dispatch')}});
      try {
        hooks.get('session_start')({},ctx);hooks.get('agent_settled')({aborted:true},ctx);
        const state=JSON.parse(fs.readFileSync(join(continuationDir(activity),'state.json'),'utf8')),requestId=randomUUID();
        const name=requestId+'.request.json';write(join(continuationDir(activity),name),JSON.stringify({runId:'run',sessionFile:state.sessionFile,requestId,idleToken:state.idleToken,message:'literal'}));
        assert.doesNotThrow(()=>notify('rename',name));assert.equal(sends,1);assert.ok(closed);
        assert.ok(notices.some(m=>/paused|uncertain/i.test(m)),'I/O failure must remain visible when disk diagnostics fail');
        fail=false;hooks.get('session_start')({},ctx);hooks.get('agent_settled')({aborted:true},ctx);
        commands.get(CONTINUE_COMMAND).handler(requestId,ctx);assert.equal(sends,1,'claim survives storage recovery and reload');
        fail=true;assert.doesNotThrow(()=>watchError(Object.assign(Error('${code}'),{code:'${code}'})));
        assert.ok(unref,'watcher must not keep an SDK host alive');
      } finally {fail=false;hooks.get('session_shutdown')({},ctx);fs.rmSync(dir,{recursive:true,force:true});}
    `], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, `${code}: ${result.stderr}`);
  }
});

test("interrupted settled child receives exact hostile text via API, reusing all live resources", async () => {
  const f = fixture();
  try {
    f.settle();
    const before = { ...f.child };
    const message = "  /subagent_done\n!echo unsafe\n@private.txt\n/skill:secret\n${shell}; ' \"\n\r\n ";
    const result = await continueLiveChild(f.owner, f.child, { message }, f.transport);
    const command = continuationCommand(result.requestId);
    assert.equal(result.status, "accepted");
    assert.deepEqual(f.sent, [[message, { expandPromptTemplates: false }]]);
    assert.deepEqual(f.child, before); // same run, pane, activity, abort, watcher, config and task
    f.invoke(command);
    assert.equal(f.sent.length, 1);
    assert.equal(f.owner.continuationRequestId, undefined);
    const dir = continuationDir(f.activityFile);
    assert.equal(JSON.parse(readFileSync(join(dir, `${result.requestId}.result.json`), "utf8")).status, "accepted");
    assert.equal(JSON.parse(readFileSync(join(dir, `${result.requestId}.claim.json`), "utf8")).status, "dispatching");
    // Real duplicate filesystem notification/request, not only a manual command.
    const requestPath = join(dir, `${result.requestId}.request.json`);
    writeFileSync(requestPath, readFileSync(requestPath));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("HC done requires a fresh child settled token, never coarse done alone", async () => {
  const f = fixture();
  try {
    const transport = { ...f.transport, inspect: async () => ({ kind: "present", agentStatus: "done", observedAt: Date.now() } as const) };
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, transport), /not confirmed settled/);
    f.settle();
    assert.equal((await continueLiveChild(f.owner, f.child, { message: "x" }, transport)).status, "accepted");
    assert.equal(f.sent.length, 1);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, transport), /not confirmed settled/);
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("manual Escape reconciles a waiting parent without inventing a completed result", async () => {
  const f = fixture();
  try {
    f.child.lifecycle = { ...f.child.lifecycle, turn: { kind: "waiting", startedAt: 4 } };
    f.settle(false);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /not confirmed an interrupted/);
    f.settle(true);
    assert.equal((await continueLiveChild(f.owner, f.child, { message: "manual escape follow-up" }, f.transport)).status, "accepted");
    assert.equal(f.sent.length, 1);
    f.events.get("agent_start")!({}, f.ctx);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "stale" }, f.transport), /not confirmed settled/);
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

for (const kind of ["active", "starting"] as const) {
  test(`only a fresh interrupted-idle capability can override a stale ${kind} parent label`, async () => {
    const f = fixture();
    try {
      f.child.lifecycle = kind === "starting" ? sampleInterruptedLifecycle(f)
        : { ...f.child.lifecycle, turn: { kind: "active", source: "activity", startedAt: 4 } };
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "busy must not dispatch" }, f.transport), /not confirmed settled/);
      f.settle(false);
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "ordinary idle cannot override stale label" }, f.transport), /active parent|starting parent/);
      assert.equal(f.sent.length, 0);
      f.settle(true);
      const result = await continueLiveChild(f.owner, f.child, { message: "confirmed interrupted follow-up" }, f.transport);
      assert.equal(result.status, "accepted");
      assert.equal(f.sent.length, 1);
      assert.deepEqual(f.sent[0], ["confirmed interrupted follow-up", { expandPromptTemplates: false }]);
      f.events.get("before_agent_start")!({}, f.ctx);
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "expired must not dispatch" }, f.transport), /not confirmed settled/);
      assert.equal(f.sent.length, 1);
    } finally { f.cleanup(); }
  });
}

for (const kind of ["interrupted", "starting"] as const) {
  test(`foreign, malformed and busy child state cannot authorize continuation from ${kind}`, async () => {
    const f = fixture();
    try {
      if (kind === "starting") f.child.lifecycle = sampleInterruptedLifecycle(f);
      f.settle();
      const dir = continuationDir(f.activityFile);
      const path = join(dir, "state.json");
      const state = JSON.parse(readFileSync(path, "utf8"));
      for (const patch of [{ runId: randomUUID() }, { sessionFile: "foreign" }, { state: "busy" }, { idleToken: "stale" }]) {
        writeFileSync(path, JSON.stringify({ ...state, ...patch }));
        await assert.rejects(continueLiveChild(f.owner, f.child, { message: "must not dispatch" }, f.transport), /not confirmed settled/);
        assert.equal(f.owner.continuationRequestId, undefined);
        assert.equal(readdirSync(dir).some(name => name.endsWith(".request.json")), false);
      }
      assert.equal(f.sent.length, 0);
    } finally { f.cleanup(); }
  });
}

test("starting reconciliation preserves pane, custody, ownership and inspection-race fences", async () => {
  const f = fixture();
  try {
    f.child.lifecycle = sampleInterruptedLifecycle(f);
    f.settle(true);
    const lifecycle = f.child.lifecycle;
    const reject = async (transport: Parameters<typeof continueLiveChild>[3] = f.transport, owner = f.owner, child = f.child) => {
      await assert.rejects(continueLiveChild(owner, child, { message: "must not dispatch" }, transport));
      assert.equal(f.owner.continuationRequestId, undefined);
      assert.equal(readdirSync(continuationDir(f.activityFile)).some(name => name.endsWith(".request.json")), false);
      assert.equal(f.sent.length, 0);
    };
    for (const agentStatus of ["working", "blocked", "unknown"] as const) {
      await reject({ ...f.transport, inspect: async () => ({ kind: "present", agentStatus, observedAt: 1060 }) });
    }
    for (const kind of ["missing", "unavailable"] as const) {
      await reject({ ...f.transport, inspect: async () => ({ kind }) });
    }
    await reject({ ...f.transport, beforeSend: () => { throw new Error("custody lost"); } });
    await reject(f.transport, { ...f.owner, runId: randomUUID() });
    await reject(f.transport, { ...f.owner, closeRequestId: randomUUID() });
    await reject(f.transport, f.owner, { ...f.child, cli: "claude" });
    for (const changed of [
      { ...lifecycle, process: createLifecycle(1).process },
      { ...lifecycle, turn: { kind: "blocked" as const, startedAt: 1060 } },
      { ...lifecycle, turn: { kind: "unknown" as const } },
    ]) {
      await reject({ ...f.transport, inspect: async () => {
        f.child.lifecycle = changed;
        return f.transport.inspect();
      } });
      f.child.lifecycle = lifecycle;
    }
  } finally { f.cleanup(); }
});

for (const fence of ["stale-token", "busy", "pending-messages", "changed-session"] as const) {
  test(`starting reconciliation still rejects child-side ${fence} after parent validation`, async () => {
    const f = fixture();
    try {
      f.child.lifecycle = sampleInterruptedLifecycle(f);
      f.settle(true);
      const stateFile = join(continuationDir(f.activityFile), "state.json");
      if (fence === "stale-token") {
        const expired = readFileSync(stateFile, "utf8");
        f.settle(true); // Token has rotated but the parent's file is stale.
        writeFileSync(stateFile, expired);
      } else if (fence === "busy") f.idle(false);
      else if (fence === "pending-messages") f.pending(true);
      else f.ctx.sessionManager.getSessionFile = () => join(f.dir, "other.jsonl");
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "must not reach API" }, f.transport), /Child rejected/);
      assert.equal(f.owner.continuationRequestId, undefined);
      assert.equal(f.sent.length, 0);
      assert.equal(readdirSync(continuationDir(f.activityFile)).some(name => name.endsWith(".claim.json")), false);
    } finally { f.cleanup(); }
  });
}

test("reservation happens before asynchronous inspection; concurrent resumes cannot duplicate", async () => {
  const f = fixture();
  try {
    f.settle();
    let release!: Function;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = continueLiveChild(f.owner, f.child, { message: "one" }, {
      ...f.transport, inspect: async () => { await gate; return f.transport.inspect(); },
    });
    assert.ok(f.owner.continuationRequestId);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "two" }, f.transport), /in flight/);
    release();
    assert.equal((await first).status, "accepted");
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("a stale acknowledgement waiter cannot settle a replacement reservation", async () => {
  const f = fixture();
  try {
    f.settle();
    const dir = continuationDir(f.activityFile);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    let published!: (requestId: string) => void;
    const started = new Promise<string>(resolve => { published = resolve; });
    const waiter = continueLiveChild(f.owner, f.child, { message: "old request" }, {
      ...f.transport,
      beforeSend: (requestId) => {
        // Keep the real child from acknowledging the old request in this fixture.
        writeFileSync(join(dir, `${requestId}.claim.json`), "{}");
        published(requestId);
      },
      settled: () => assert.fail("The old waiter must not reconcile a different request"),
    });
    const originalId = await started;
    const requestId = randomUUID();
    const request = { runId: f.runId, requestId, sessionFile: state.sessionFile, idleToken: state.idleToken, message: "new request" };
    writeFileSync(join(dir, `${requestId}.claim.json`), JSON.stringify({ runId: f.runId, requestId, status: "dispatching" }));
    writeFileSync(join(dir, `${requestId}.request.json`), JSON.stringify(request));
    writeFileSync(join(dir, `${requestId}.result.json`), JSON.stringify({ ...request, status: "accepted" }));
    f.owner.continuationRequestId = requestId;
    assert.deepEqual(await waiter, { requestId: originalId, status: "pending" });
    assert.equal(f.owner.continuationRequestId, requestId);
  } finally { f.cleanup(); }
});

test("starting, active without aborted proof, finalizing, unknown and non-Pi owners reject without dispatch", async () => {
  const f = fixture();
  try {
    f.settle(false); // Ordinary idle is deliberately insufficient to override active.
    const original = f.child.lifecycle;
    for (const processKind of ["starting", "finalizing", "completed", "failed"]) {
      f.child.lifecycle = { ...original, process: { ...original.process, kind: processKind } as any };
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /not a tracked interrupted/);
    }
    for (const kind of ["active", "starting", "unknown"]) {
      f.child.lifecycle = { ...original, turn: { kind } as any };
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport));
    }
    f.child.lifecycle = original;
    f.child.cli = "claude";
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport));
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("requires exact nonempty message and immutable name; Escape to idle uses existing child settlement",  async () => {
  const f = fixture();
  try {
    for (const message of [undefined, "", " \n\t"]) {
      await assert.rejects(continueLiveChild(f.owner, f.child, { message }, f.transport), /nonempty/);
    }
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x", name: "Other" }, f.transport), /cannot change/);
    for (const event of ["session_start", "before_agent_start", "agent_start"]) {
      f.events.get(event)!({}, f.ctx);
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /not confirmed settled/);
    }
    f.settle(false);
    assert.equal((await continueLiveChild(f.owner, f.child, { message: "x" }, f.transport)).status, "accepted",
      "Escape to an already idle child does not require a new aborted settlement");
    f.settle();
    f.idle(false);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /Child rejected/);
    assert.equal(f.owner.continuationRequestId, undefined);
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("unknown/missing pane never continues; failed transport retains uncertainty and never falls back to spawn", async () => {
  const f = fixture();
  try {
    f.settle();
    for (const kind of ["unavailable", "missing"]) {
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, {
        ...f.transport, inspect: async () => ({ kind } as any),
      }), /not confirmed idle/);
      assert.equal(f.owner.continuationRequestId, undefined);
    }
    const result = await continueLiveChild(f.owner, f.child, { message: "x" }, {
      ...f.transport, timeoutMs: 0,
    });
    assert.equal(result.status, "pending");
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "retry" }, f.transport), /uncertain/);
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("state changes during inspection and pending child messages fail closed", async () => {
  const f = fixture();
  try {
    f.settle();
    const before = f.child.lifecycle;
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, {
      ...f.transport, inspect: async () => {
        f.child.lifecycle = { ...before, turn: { kind: "unknown" } };
        return f.transport.inspect();
      },
    }), /changed state/);
    f.child.lifecycle = before;
    f.pending(true);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /Child rejected/);
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("ambiguous API dispatch is durably claimed and cannot replay", async () => {
  const f = fixture();
  try {
    f.settle();
    const result = await continueLiveChild(f.owner, f.child, { message: "x" }, {
      ...f.transport, timeoutMs: 0, beforeSend: () => {
        const requestId = f.owner.continuationRequestId!;
        writeFileSync(join(continuationDir(f.activityFile), `${requestId}.result.json`),
          JSON.stringify({ runId: f.runId, requestId, status: "dispatching" }));
      },
    });
    assert.equal(result.status, "pending");
    f.invoke(continuationCommand(result.requestId));
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("throwing API dispatch retains a separate durable claim across child reload", async () => {
  const f = fixture();
  try {
    f.settle();
    f.failDispatch();
    const result = await continueLiveChild(f.owner, f.child, { message: "x" }, { ...f.transport, timeoutMs: 100 });
    assert.equal(result.status, "pending");
    assert.equal(f.sent.length, 1);
    f.events.get("session_start")!({}, f.ctx);
    f.settle();
    f.invoke(continuationCommand(result.requestId));
    assert.equal(f.sent.length, 1);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "retry" }, f.transport), /uncertain/);
  } finally { f.cleanup(); }
});

test("custody validation precedes publication; unsupported children never get terminal fallback", async () => {
  const f = fixture();
  try {
    f.settle();
    const dir = continuationDir(f.activityFile);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, {
      ...f.transport, beforeSend: () => { throw new Error("custody lost"); },
    }), /custody lost/);
    assert.equal(readdirSync(dir).some(name => name.endsWith(".request.json")), false);
    assert.equal(f.owner.continuationRequestId, undefined);
    const stateFile = join(dir, "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    delete state.transport;
    writeFileSync(stateFile, JSON.stringify(state));
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /Update\/reload/);
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("watcher starts only in session_start and stops on shutdown/reload; stale tokens reject", async () => {
  const f = fixture();
  try {
    f.settle();
    const dir = continuationDir(f.activityFile);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    f.events.get("session_shutdown")!({}, f.ctx);
    const requestId = randomUUID();
    const request = { runId: f.runId, sessionFile: canonicalSessionPath(f.sessionFile), requestId, idleToken: state.idleToken, message: "x" };
    writeFileSync(join(dir, `${requestId}.request.json`), JSON.stringify(request));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.sent.length, 0);
    f.events.get("session_start")!({}, f.ctx);
    // Replacing a session invalidates old settled evidence, including queued files.
    f.invoke(continuationCommand(requestId));
    assert.equal(JSON.parse(readFileSync(join(dir, `${requestId}.result.json`), "utf8")).status, "rejected");
    f.settle();
    assert.equal((await continueLiveChild(f.owner, f.child, { message: "new" }, f.transport)).status, "accepted");
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("queue continuation receiver fails closed across missing env, recovered assignment and duplicate request", async () => {
  const f = fixture(true);
  try {
    const files = continuationDir(f.activityFile);
    const reject = async () => {
      f.settle();
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "must not send" }, f.transport), /Queue continuation authority unavailable/);
      const request = readdirSync(files).filter(name => name.endsWith(".request.json")).at(-1)!;
      f.invoke(continuationCommand(request.slice(0, -".request.json".length)));
      assert.equal(f.sent.length, 0, "no Pi API transport, including explicit command replay");
      assert.equal(readdirSync(files).some(name => name.endsWith(".claim.json")), false);
    };
    delete process.env[QUEUE_CHILD_ENV]; // A running child never drops its captured restriction.
    await reject();
    const marker = queueChildMarkerPath(canonicalSessionPath(f.sessionFile));
    writeFileSync(marker, "1\n");
    f.reopen(); // Fresh registration without the launch marker env.
    await reject();
    rmSync(marker);
    f.entries.push({ type: "custom", customType: "subagent-assignment",
      data: { sessionFile: canonicalSessionPath(f.sessionFile), queueAllocation: null } });
    f.reopen();
    await reject(); // Malformed allocation cannot be reclassified as unbound.
  } finally { f.cleanup(); }
});

test("watcher rejects a persisted queue assignment absent from preloaded entries", async () => {
  const f = fixture();
  try {
    f.settle();
    writeFileSync(f.sessionFile, JSON.stringify({ type: "custom", customType: "subagent-assignment",
      data: { sessionFile: canonicalSessionPath(f.sessionFile), queueAllocation: null } }) + "\n", { flag: "a" });
    assert.deepEqual(f.entries, []);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "follow-up" }, f.transport), /Queue continuation authority unavailable/);
    assert.equal(f.sent.length, 0);
    assert.equal(readdirSync(continuationDir(f.activityFile)).some(name => name.endsWith(".claim.json")), false);
  } finally { f.cleanup(); }
});

test("failed settlement of an unpublished continuation retains its reservation", async () => {
  const f = fixture();
  try {
    f.settle();
    let intent: string | undefined;
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "follow-up" }, {
      ...f.transport, beforeSend: id => { intent = id; return () => { throw new Error("target changed"); }; },
      settled: id => { assert.equal(id, intent); throw new Error("cannot persist settlement"); },
    }), /cannot persist settlement/);
    assert.ok(intent);
    assert.equal(f.owner.continuationRequestId, intent);
    assert.deepEqual(readdirSync(continuationDir(f.activityFile)), ["state.json"]);
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("persisted queue profile alone blocks watcher and fresh private command transport", async () => {
  const f = fixture();
  try {
    const files = continuationDir(f.activityFile);
    const file = canonicalSessionPath(f.sessionFile);
    // Unknown launch/allocation versions are restrictive, even without a
    // marker, assignment card, or queue environment in the fresh runtime.
    writeFileSync(launchProfilePath(file), JSON.stringify({ version: 99, sessionFile: file, queueAllocation: { version: 99 } }));
    f.reopen();
    f.settle();
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "watcher" }, f.transport), /Queue continuation authority unavailable/);
    assert.equal(readdirSync(files).filter(name => name.endsWith(".result.json")).length, 1);
    assert.equal(f.sent.length, 0);
    f.reopen(); // Fresh closure with no previously detected queue classification.
    f.settle();
    const requestId = randomUUID();
    const { idleToken } = JSON.parse(readFileSync(join(files, "state.json"), "utf8"));
    writeFileSync(join(files, `${requestId}.request.json`), JSON.stringify({ runId: f.runId, sessionFile: file, requestId, idleToken, message: "private command" }));
    // The command rejects before control returns to the event loop, so this
    // receipt is from a fresh command, not a watcher-produced duplicate.
    f.invoke(continuationCommand(requestId));
    assert.equal(JSON.parse(readFileSync(join(files, `${requestId}.result.json`), "utf8")).reason, "Queue continuation authority unavailable");
    assert.equal(readdirSync(files).filter(name => name.endsWith(".claim.json")).length, 0);
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("artifact acknowledgement needs no terminal send", async () => {
  const f = fixture();
  try {
    f.settle();
    const result = await continueLiveChild(f.owner, f.child, { message: "x" }, {
      ...f.transport, send: (_surface, text) => { f.invoke(text); throw new Error("lost reply"); },
    });
    assert.equal(result.status, "accepted");
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("child validates identity, token, payload and request IDs; rejection is durable", () => {
  const f = fixture();
  try {
    f.settle();
    const dir = continuationDir(f.activityFile);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    for (const patch of [{ runId: "foreign" }, { sessionFile: "foreign" }, { idleToken: randomUUID() },
      { message: " " }, { requestId: randomUUID() }, { message: 42 }]) {
      const requestId = randomUUID();
      writeFileSync(join(dir, `${requestId}.request.json`), JSON.stringify({ runId: f.runId, requestId,
        sessionFile: canonicalSessionPath(f.sessionFile), idleToken: state.idleToken, message: "x", ...patch }));
      f.invoke(continuationCommand(requestId));
      assert.equal(JSON.parse(readFileSync(join(dir, `${requestId}.result.json`), "utf8")).status, "rejected");
      f.invoke(continuationCommand(requestId));
    }
    for (const invalid of ["../escape", "id\n!shell", "@file", `${randomUUID()} extra`]) {
      assert.throws(() => continuationCommand(invalid));
      f.commands.get(CONTINUE_COMMAND).handler(invalid, f.ctx);
    }
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});
