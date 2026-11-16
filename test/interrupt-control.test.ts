import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { Type } from "@sinclair/typebox";
import { INTERRUPT_CAPABILITY, interruptDir, interruptOwnedChild, registerInterruptControl } from "../pi-extension/subagents/interrupt-control.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";
import { withChildSession } from "./child-session.ts";

const put = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "interrupt control condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "interrupt-control-"));
  const sessionFile = canonicalSessionPath(join(dir, "child.jsonl"));
  put(sessionFile, { type: "session", id: "header" });
  const child = { id: "run", cli: "pi", sessionFile, activityFile: join(dir, "activity.json") };
  const identity = { schema: 1, runId: child.id, sessionFile, headerId: "header", nonce: "nonce", process: { pid: process.pid, birth: "fixture-birth" } };
  put(`${runCompletionFile(sessionFile, child.id)}.identity.json`, identity);
  const owner: any = { runId: child.id, dispatched: true };
  const control = interruptDir(child.activityFile);
  mkdirSync(control);
  const activeToken = randomUUID();
  const state = { ...identity, capability: INTERRUPT_CAPABILITY, activeToken, state: "active" };
  put(join(control, `${activeToken}.active.json`), state);
  put(join(control, "current.json"), { file: `${activeToken}.active.json` });
  const transport = { validate: () => {}, timeoutMs: 0 };
  // Production polling/watching is unref'ed; the foreground test owns its lifetime.
  const keepAlive = setInterval(() => {}, 1000);
  return { dir, child, identity, owner, control, activeToken, state, transport,
    cleanup: () => { clearInterval(keepAlive); rmSync(dir, { recursive: true, force: true }); } };
}
function childControl(f: ReturnType<typeof fixture>, abort?: () => void) {
  const env = { PI_SUBAGENT_ID: f.child.id, PI_SUBAGENT_SESSION: f.child.sessionFile, PI_SUBAGENT_ACTIVITY_FILE: f.child.activityFile };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const handlers = new Map<string, Function>();
  let aborts = 0, idle = false, sessionFile = f.child.sessionFile, headerId = "header";
  const ctx: any = { isIdle: () => idle, sessionManager: { getSessionFile: () => sessionFile, getHeader: () => ({ id: headerId }) },
    abort: () => {
      const claims = readdirSync(f.control).filter(name => name.endsWith(".claim.json"));
      assert.equal(claims.length, 1, "durable claim must exist BEFORE the public abort call");
      assert.equal(existsSync(join(f.control, "current.json")), false, "token is consumed before abort");
      aborts++; abort?.();
    } };
  try {
    Object.assign(process.env, env);
    registerInterruptControl({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any,
      () => ({ kind: "present", identity: f.identity.process }));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  return { emit, ctx, aborts: () => aborts, idle: (value: boolean) => { idle = value; },
    session: (value: string) => { sessionFile = value; }, header: (value: string) => { headerId = value; },
    state: () => read(join(f.control, read(join(f.control, "current.json")).file)),
    stop: () => emit("session_shutdown") };
}

test("watcher is deferred, unref'ed, and disposed on shutdown/error; old tokens cannot survive reload", () => {
  const f = fixture(), c = childControl(f);
  let watches = 0, unrefs = 0, closes = 0;
  let watcher: any;
  try {
    mock.method(fs, "watch", () => {
      watches++;
      watcher = Object.assign(new EventEmitter(), { unref: () => { unrefs++; }, close: () => { closes++; } });
      return watcher;
    });
    syncBuiltinESMExports();
    assert.equal(watches, 0);
    c.emit("session_start"); c.emit("before_agent_start");
    const token = c.state().activeToken;
    assert.equal(watches, 1); assert.equal(unrefs, 1);
    c.stop(); c.stop();
    assert.equal(closes, 1); assert.equal(existsSync(join(f.control, "current.json")), false);
    c.emit("session_start"); c.emit("before_agent_start");
    assert.notEqual(c.state().activeToken, token);
    watcher.emit("error", new Error("watch failed"));
    assert.equal(closes, 2); assert.equal(existsSync(join(f.control, "current.json")), false);
    c.emit("before_agent_start");
    assert.equal(existsSync(join(f.control, "current.json")), false);
  } finally { c.stop(); mock.restoreAll(); syncBuiltinESMExports(); f.cleanup(); }
});

test("startup with missing capability, wrong process or changed header cannot advertise active control", () => {
  for (const scenario of ["missing-identity", "wrong-process", "wrong-header", "no-abort"]) {
    const f = fixture(), c = childControl(f);
    try {
      if (scenario === "missing-identity") rmSync(`${runCompletionFile(f.child.sessionFile, f.child.id)}.identity.json`);
      if (scenario === "wrong-process") put(`${runCompletionFile(f.child.sessionFile, f.child.id)}.identity.json`, { ...f.identity, process: { ...f.identity.process, birth: "wrong" } });
      if (scenario === "wrong-header") c.header("replacement");
      if (scenario === "no-abort") c.ctx.abort = undefined;
      c.emit("session_start"); c.emit("before_agent_start");
      assert.equal(existsSync(join(f.control, "current.json")), false);
      assert.equal(c.aborts(), 0);
    } finally { c.stop(); f.cleanup(); }
  }
});

test("factory starts no resources; child claims synchronously before abort; acknowledgement is NOT settlement", async () => {
  const f = fixture(), c = childControl(f);
  try {
    rmSync(f.control, { recursive: true });
    assert.equal(existsSync(f.control), false);
    c.emit("session_start");
    assert.equal(existsSync(join(f.control, "current.json")), false);
    c.emit("before_agent_start");
    const state = c.state();
    const result = await interruptOwnedChild(f.owner, f.child, { ...f.transport, timeoutMs: 1000 });
    assert.equal(result.status, "requested"); assert.equal(result.settlement, "unconfirmed");
    assert.equal(c.aborts(), 1);
    const id = result.requestId;
    const requestFile = join(f.control, `${id}.request.json`), ackFile = join(f.control, `${id}.ack.json`);
    const ackBytes = readFileSync(ackFile, "utf8");
    // Repeated events and reload cannot replay either acknowledged or ambiguous claims.
    put(requestFile, { ...state, requestId: id });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(c.aborts(), 1); assert.equal(readFileSync(ackFile, "utf8"), ackBytes);
    c.idle(true); c.emit("agent_settled", { aborted: true });
    const settled = read(join(f.control, `${id}.settled.json`));
    assert.equal(settled.status, "aborted"); assert.equal(settled.activeToken, state.activeToken);
    c.emit("session_shutdown"); c.emit("session_start");
    c.idle(false); c.emit("before_agent_start");
    assert.notEqual(c.state().activeToken, state.activeToken);
    put(requestFile, { ...state, requestId: id });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(c.aborts(), 1); assert.equal(readFileSync(ackFile, "utf8"), ackBytes);
  } finally { c.stop(); f.cleanup(); }
});

test("child rejects stale active tokens, wrong identity/capability, idle and replaced sessions without claiming", async () => {
  const f = fixture(), c = childControl(f);
  try {
    c.emit("session_start"); c.emit("before_agent_start");
    const state = c.state();
    const reject = async (extra: object = {}) => {
      const requestId = randomUUID();
      put(join(f.control, `${requestId}.request.json`), { ...state, requestId, ...extra });
      await until(() => existsSync(join(f.control, `${requestId}.ack.json`)));
      assert.equal(read(join(f.control, `${requestId}.ack.json`)).status, "rejected");
      assert.equal(existsSync(join(f.control, `${requestId}.claim.json`)), false);
    };
    for (const extra of [{ runId: "wrong" }, { sessionFile: "wrong" }, { headerId: "wrong" }, { nonce: "wrong" },
      { process: { ...f.identity.process, birth: "wrong" } }, { process: { ...f.identity.process, pid: 1 } },
      { capability: "legacy" }, { activeToken: randomUUID() }, { requestId: randomUUID() }]) await reject(extra);
    c.idle(true); await reject(); c.idle(false);
    c.header("replacement"); await reject(); c.header("header");
    c.session(join(f.dir, "replacement.jsonl")); await reject(); c.session(f.child.sessionFile);
    c.idle(true); c.emit("agent_settled", { aborted: false }); c.idle(false);
    await reject(); // The stale proof cannot abort a new run before it issued a new token.
    c.emit("before_agent_start"); await reject();
    assert.equal(c.aborts(), 0);
  } finally { c.stop(); f.cleanup(); }
});

for (const failure of ["abort-api", "ack-storage"] as const) {
  test(`ambiguous ${failure} failure never replays a durable claim, even after reload`, async () => {
    const f = fixture();
    const c = childControl(f, () => { if (failure === "abort-api") throw new Error("abort unavailable"); });
    const originalLink = fs.linkSync;
    try {
      c.emit("session_start"); c.emit("before_agent_start");
      const state = c.state();
      const requestId = randomUUID();
      if (failure === "ack-storage") {
        mock.method(fs, "linkSync", (source: any, target: any) => {
          if (String(target).endsWith(".ack.json")) throw new Error("ack disk unavailable");
          return originalLink(source, target);
        });
        syncBuiltinESMExports();
      }
      const file = join(f.control, `${requestId}.request.json`);
      const request = { ...state, requestId };
      put(file, request);
      await until(() => existsSync(join(f.control, `${requestId}.claim.json`)) && !existsSync(join(f.control, "current.json")));
      assert.equal(c.aborts(), 1); assert.equal(existsSync(join(f.control, `${requestId}.ack.json`)), false);
      mock.restoreAll(); syncBuiltinESMExports();
      c.emit("session_start"); c.emit("before_agent_start");
      put(file, request);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(c.aborts(), 1);
      c.idle(true); c.emit("agent_settled", { aborted: true });
      assert.equal(existsSync(join(f.control, `${requestId}.settled.json`)), false, "reload cannot manufacture old aborted settlement");
    } finally { mock.restoreAll(); syncBuiltinESMExports(); c.stop(); f.cleanup(); }
  });
}

test("natural settlement or session replacement cannot confirm an interrupt", async () => {
  for (const replacement of [false, true]) {
    const f = fixture(), c = childControl(f);
    try {
      c.emit("session_start"); c.emit("before_agent_start");
      const result = await interruptOwnedChild(f.owner, f.child, { ...f.transport, timeoutMs: 1000 });
      assert.equal(result.status, "requested");
      if (replacement) c.header("replacement");
      c.idle(true); c.emit("agent_settled", { aborted: replacement });
      assert.equal(existsSync(join(f.control, `${result.requestId}.settled.json`)), false);
    } finally { c.stop(); f.cleanup(); }
  }
});

test("unsupported/idle children, wrong ownership, invalid proofs and conflicting controls fail closed", async () => {
  const f = fixture();
  try {
    for (const [owner, child] of [[{ ...f.owner, runId: "wrong" }, f.child], [{ ...f.owner, dispatched: false }, f.child],
      [f.owner, { ...f.child, cli: "claude" }], [f.owner, { ...f.child, activityFile: undefined }],
      [{ ...f.owner, closeRequestId: "pending" }, f.child], [{ ...f.owner, continuationRequestId: "pending" }, f.child]]) {
      await assert.rejects(interruptOwnedChild(owner as any, child as any, f.transport), /tracked owned|pending/);
    }
    for (const extra of [{ nonce: "wrong" }, { headerId: "wrong" }, { process: { ...f.identity.process, birth: "wrong" } },
      { activeToken: randomUUID() }, { capability: "legacy" }, { state: "idle" }]) {
      put(join(f.control, `${f.activeToken}.active.json`), { ...f.state, ...extra });
      await assert.rejects(interruptOwnedChild(f.owner, f.child, f.transport), /proof is invalid/);
    }
    rmSync(join(f.control, "current.json"));
    await assert.rejects(interruptOwnedChild(f.owner, f.child, f.transport), /no fresh active/);
    assert.equal(readdirSync(f.control).some(name => name.endsWith(".request.json")), false);
  } finally { f.cleanup(); }
});

test("timeout and concurrent rechecks never republish/retry a request or a reservation left by a crash", async () => {
  const f = fixture();
  try {
    const [first, concurrent] = await Promise.all([interruptOwnedChild(f.owner, f.child, f.transport), interruptOwnedChild(f.owner, f.child, f.transport)]);
    assert.equal(first.status, "pending"); assert.equal(first.settlement, "unconfirmed");
    assert.equal(concurrent.requestId, first.requestId);
    const file = join(f.control, `${first.requestId}.request.json`);
    const bytes = readFileSync(file, "utf8");
    assert.equal((await interruptOwnedChild(f.owner, f.child, f.transport)).requestId, first.requestId);
    assert.equal(readFileSync(file, "utf8"), bytes);
    rmSync(file); // Crash between durable reservation and publication is ambiguous, NOT retry permission.
    assert.equal((await interruptOwnedChild(f.owner, f.child, f.transport)).status, "pending");
    assert.equal(existsSync(file), false);
    assert.equal(readdirSync(f.control).filter(name => name.endsWith(".intent.json")).length, 1);
    assert.equal(f.owner.dispatched, true);
  } finally { f.cleanup(); }
});

test("parent requires correlated claim+ack; only a distinct correlated aborted settlement confirms cancellation", async () => {
  const f = fixture();
  try {
    const first = await interruptOwnedChild(f.owner, f.child, f.transport);
    const id = first.requestId, request = read(join(f.control, `${id}.request.json`));
    const ackFile = join(f.control, `${id}.ack.json`), claimFile = join(f.control, `${id}.claim.json`), settledFile = join(f.control, `${id}.settled.json`);
    put(ackFile, { ...request, status: "requested" });
    assert.equal((await interruptOwnedChild(f.owner, f.child, f.transport)).status, "pending", "ack without claim is not accepted");
    put(claimFile, { ...request, status: "claimed" });
    for (const extra of [{ requestId: randomUUID() }, { activeToken: randomUUID() }, { nonce: "wrong" }, { headerId: "wrong" },
      { process: { ...f.identity.process, birth: "wrong" } }]) {
      put(ackFile, { ...request, status: "requested", ...extra });
      assert.equal((await interruptOwnedChild(f.owner, f.child, f.transport)).status, "pending");
      put(ackFile, { ...request, status: "requested" });
      put(settledFile, { ...request, status: "aborted", ...extra });
      assert.equal((await interruptOwnedChild(f.owner, f.child, f.transport)).settlement, "unconfirmed");
    }
    put(settledFile, { ...request, status: "aborted" });
    assert.deepEqual(await interruptOwnedChild(f.owner, f.child, f.transport), { requestId: id, status: "requested", settlement: "aborted" });
    rmSync(claimFile); rmSync(settledFile);
    put(ackFile, { ...request, status: "rejected", dispatched: false, reason: "settled before dispatch" });
    assert.equal((await interruptOwnedChild(f.owner, f.child, f.transport)).status, "rejected");
  } finally { f.cleanup(); }
});

test("custody and cancellation are revalidated after asynchronous waits; watcher/process ownership is untouched", async () => {
  const f = fixture();
  try {
    let valid = true;
    const pending = interruptOwnedChild(f.owner, f.child, { timeoutMs: 1000, validate: () => { if (!valid) throw new Error("custody lost"); } });
    valid = false;
    await assert.rejects(pending, /custody lost/);
    const controller = new AbortController();
    const cancelled = interruptOwnedChild(f.owner, f.child, { ...f.transport, timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, /abort/i);
    assert.equal(readdirSync(f.control).filter(name => name.endsWith(".request.json")).length, 1);
    assert.equal(f.owner.dispatched, true);
  } finally { f.cleanup(); }
});

for (const stagedClose of [undefined, false, true]) {
test(`real offline Pi ctx.abort preserves settlement semantics (staged close=${stagedClose}) without extra model turns or shutdown`, async () => {
  const root = mkdtempSync(join(tmpdir(), "interrupt-native-"));
  const sessionFile = join(root, "seed.jsonl");
  put(sessionFile, { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await withChildSession({ sessionFile, liveContinuation: true, autoExit: true,
      respond: () => ({ stopReason: "toolUse", content: [
        ...(stagedClose === undefined ? [] : [{ type: "toolCall" as const, id: "done", name: "subagent_done", arguments: { close: stagedClose } }]),
        { type: "toolCall", id: "gate", name: "gate", arguments: {} },
      ] }),
      extensions: [pi => pi.registerTool({ name: "gate", label: "Gate", description: "offline gate", parameters: Type.Object({}),
        execute: async (_id: string, _args: object, signal: AbortSignal) => {
          entered();
          await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
          return { content: [{ type: "text", text: "gate aborted" }], details: {} };
        } })] }, async ({ session, requests, shutdowns }) => {
      const running = session.prompt("Hold the active tool gate");
      await started;
      const runId = process.env.PI_SUBAGENT_ID!, activityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE!;
      const result = await interruptOwnedChild({ runId, dispatched: true }, { id: runId, cli: "pi", sessionFile, activityFile }, { validate: () => {}, timeoutMs: 2000 });
      assert.equal(result.status, "requested");
      await running;
      const control = interruptDir(activityFile);
      assert.equal(read(join(control, `${result.requestId}.settled.json`)).status, "aborted");
      assert.equal(existsSync(join(control, "current.json")), false);
      assert.equal(requests.length, 1, "abort transport must not start another model turn");
      const eventsDir = `${runCompletionFile(sessionFile, runId)}.events`;
      if (stagedClose === undefined) {
        assert.equal(existsSync(eventsDir), false, "unstaged abort must not fabricate completion");
      } else {
        const events = readdirSync(eventsDir).map(name => read(join(eventsDir, name)));
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "error"); assert.equal(events[0].stopReason, "aborted");
        assert.equal(events[0].keepOpen, true, "staged abort cannot close the child even with close:true");
      }
      assert.equal(shutdowns(), 0, "abort preserves the supervised process");
      assert.equal(canonicalSessionPath(session.sessionFile!), canonicalSessionPath(sessionFile));
      await assert.rejects(interruptOwnedChild({ runId, dispatched: true }, { id: runId, cli: "pi", sessionFile, activityFile }, { validate: () => {}, timeoutMs: 0 }), /no fresh active/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
}
