import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUE_COMMAND, continuationCommand, continuationDir, continueLiveChild, registerLiveContinuation } from "../pi-extension/subagents/live-continuation.ts";
import { canonicalSessionPath, type SessionOwner } from "../pi-extension/subagents/ownership.ts";
import { createLifecycle, markInterruptRequested, markProcessRunning } from "../pi-extension/subagents/lifecycle.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "live-continuation-"));
  const runId = randomUUID();
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");
  const activityFile = join(dir, "activity.json");
  const env = { PI_SUBAGENT_ID: runId, PI_SUBAGENT_SESSION: sessionFile, PI_SUBAGENT_ACTIVITY_FILE: activityFile };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  let idle = true;
  let pending = false;
  const ctx = { isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionFile: () => sessionFile } };
  const pi = { on: (name: string, handler: Function) => events.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (...args: any[]) => sent.push(args) };
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
    send: (_surface: string, text: string) => invoke(text), timeoutMs: 0 };
  return { dir, runId, sessionFile, activityFile, child, owner, events, sent, commands, ctx, invoke, transport,
    settle: (aborted = true) => events.get("agent_settled")!({ aborted }, ctx),
    idle: (value: boolean) => { idle = value; }, pending: (value: boolean) => { pending = value; },
    cleanup: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    } };
}

test("interrupted settled child receives exact hostile text via API, reusing all live resources", async () => {
  const f = fixture();
  try {
    f.settle();
    const before = { ...f.child };
    const message = "  /subagent_done\n!echo unsafe\n@private.txt\n/skill:secret\n${shell}; ' \"\n\r\n ";
    let command = "";
    const result = await continueLiveChild(f.owner, f.child, { message }, {
      ...f.transport, send: (surface, text) => { assert.equal(surface, before.surface); command = text; f.invoke(text); },
    });
    assert.equal(result.status, "accepted");
    assert.equal(command, continuationCommand(result.requestId));
    assert.deepEqual(f.sent, [[message, { expandPromptTemplates: false }]]);
    assert.deepEqual(f.child, before); // same run, pane, activity, abort, watcher, config and task
    f.invoke(command);
    assert.equal(f.sent.length, 1);
    assert.equal(f.owner.continuationRequestId, undefined);
    assert.equal(JSON.parse(readFileSync(join(continuationDir(f.activityFile), `${result.requestId}.result.json`), "utf8")).status, "accepted");
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

test("starting, active, finalizing, unknown and non-Pi owners reject without transport", async () => {
  const f = fixture();
  try {
    f.settle();
    const original = f.child.lifecycle;
    for (const processKind of ["starting", "finalizing", "completed", "failed"]) {
      f.child.lifecycle = { ...original, process: { ...original.process, kind: processKind } as any };
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /not a tracked interrupted/);
    }
    for (const kind of ["active", "starting", "unknown", "waiting"]) {
      f.child.lifecycle = { ...original, turn: { kind } as any };
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport));
    }
    f.child.lifecycle = original;
    f.child.cli = "claude";
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport));
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("requires exact nonempty message and immutable name; idle evidence must be child settled-aborted", async () => {
  const f = fixture();
  try {
    for (const message of [undefined, "", " \n\t"]) {
      await assert.rejects(continueLiveChild(f.owner, f.child, { message }, f.transport), /nonempty/);
    }
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x", name: "Other" }, f.transport), /cannot change/);
    for (const event of ["session_start", "before_agent_start", "agent_start"]) {
      f.events.get(event)!();
      await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /not confirmed settled/);
    }
    f.settle(false);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport));
    f.settle();
    f.idle(false);
    await assert.rejects(continueLiveChild(f.owner, f.child, { message: "x" }, f.transport), /Child rejected/);
    assert.equal(f.owner.continuationRequestId, undefined);
    assert.equal(f.sent.length, 0);
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
      ...f.transport, send: () => { throw new Error("transport ambiguous"); },
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
      ...f.transport, send: (_surface, text) => {
        const requestId = text.split(" ")[1];
        writeFileSync(join(continuationDir(f.activityFile), `${requestId}.result.json`),
          JSON.stringify({ runId: f.runId, requestId, status: "dispatching" }));
        f.invoke(text);
      },
    });
    assert.equal(result.status, "pending");
    f.invoke(continuationCommand(result.requestId));
    assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("transport exception after child accepts reconciles acknowledgement instead of ambiguous failure", async () => {
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
