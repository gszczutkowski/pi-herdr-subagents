import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { closeDir, closeOwnedChild, registerCloseControl, CLOSE_CAPABILITY } from "../pi-extension/subagents/close-control.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { continueLiveChild, continuationDir, CONTINUATION_TRANSPORT } from "../pi-extension/subagents/live-continuation.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";
import { isProtectedProcess, probeProcess } from "../pi-extension/subagents/process-identity.ts";
import { auditSession, enumerateProcesses } from "../pi-extension/subagents/session-audit.ts";
import { readChildIdentity } from "../pi-extension/subagents/recovery-identity.ts";

const put = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data));
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const pause = () => new Promise(resolvePause => setTimeout(resolvePause, 20));
async function until(fn: () => boolean, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() > deadline) throw new Error("condition timeout"); await pause(); }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "close-control-"));
  const session = canonicalSessionPath(join(dir, "child.jsonl"));
  const activity = join(dir, "activity.json");
  put(session, { type: "session", id: "header" });
  const identity = { schema: 1, runId: "run", sessionFile: session, headerId: "header", nonce: "nonce", process: { pid: 123, birth: "original" } };
  put(`${runCompletionFile(session, "run")}.identity.json`, identity);
  const child = { id: "run", cli: "pi", sessionFile: session, activityFile: activity };
  const owner: any = { runId: "run", dispatched: true };
  const control = closeDir(activity); mkdirSync(control);
  const idleToken = randomUUID();
  put(join(control, `${idleToken}.idle.json`), { ...identity, capability: CLOSE_CAPABILITY, idleToken });
  put(join(control, "current.json"), { file: `${idleToken}.idle.json` });
  const audit = () => ({ sessionPath: session, status: "single" as const, owners: [identity.process], ownerCount: 1, uncertainCount: 0, truncated: false });
  const transport = { validate: () => {}, timeoutMs: 0, audit, protected: () => false, probe: () => ({ kind: "present" as const, identity: identity.process }) };
  return { dir, identity, child, owner, control, transport, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("close needs run identity, sole owner, ancestry and idle proof; busy/legacy/untracked never receive text or signals", async () => {
  const f = fixture();
  try {
    await assert.rejects(closeOwnedChild({ ...f.owner, runId: "wrong" }, f.child, f.transport), /tracked owned/);
    await assert.rejects(closeOwnedChild(f.owner, { ...f.child, cli: "claude" }, f.transport), /tracked owned/);
    await assert.rejects(closeOwnedChild({ ...f.owner, continuationRequestId: "pending" }, f.child, f.transport), /Continuation/);
    await assert.rejects(closeOwnedChild(f.owner, f.child, { ...f.transport, protected: () => true }), /self\/ancestor/);
    await assert.rejects(closeOwnedChild(f.owner, f.child, { ...f.transport, protected: () => undefined }), /unverified/);
    await assert.rejects(closeOwnedChild(f.owner, f.child, { ...f.transport, audit: () => ({ ...f.transport.audit(), ownerCount: 2, status: "duplicate" }) }), /duplicate/);
    rmSync(join(f.control, "current.json"));
    await assert.rejects(closeOwnedChild(f.owner, f.child, f.transport), /no fresh idle/);
    assert.equal(readdirSync(f.control).some(name => name.endsWith("request.json")), false);
    assert.equal(isProtectedProcess(process.pid), true);
    assert.equal(isProtectedProcess(process.ppid), true);
  } finally { f.cleanup(); }
});

test("acknowledgement without actual exit stays pending; repeated/reloaded requests do not dispatch twice", async () => {
  const f = fixture();
  try {
    const first = await closeOwnedChild(f.owner, f.child, f.transport);
    assert.equal(first.status, "pending");
    const id = first.requestId!;
    put(join(f.control, `${id}.ack.json`), { ...f.identity, requestId: id, status: "requested" });
    const replay = await closeOwnedChild({ runId: "run", dispatched: true }, f.child, f.transport);
    assert.equal(replay.status, "pending"); assert.equal(replay.requestId, id);
    assert.equal(readdirSync(f.control).filter(name => name.endsWith("request.json")).length, 1);
    const unknown = await closeOwnedChild(f.owner, f.child, { ...f.transport, probe: () => ({ kind: "unverified" }) });
    assert.equal(unknown.status, "uncertain");
    assert.equal(f.owner.closeRequestId, id);
  } finally { f.cleanup(); }
});

test("definite rejection unlocks only its request, preserves immutable history and permits continuation/new close after reload", async () => {
  for (const reason of ["busy race", "draft typed after idle"]) {
    const f = fixture();
    try {
      const first = await closeOwnedChild(f.owner, f.child, f.transport);
      const id = first.requestId!;
      const intent = read(join(f.control, "intent.json"));
      const ack = { ...f.identity, capability: CLOSE_CAPABILITY, idleToken: intent.idleToken,
        requestId: id, status: "rejected", dispatched: false, reason };
      put(join(f.control, `${id}.ack.json`), ack);
      const bytes = readFileSync(join(f.control, `${id}.ack.json`), "utf8");
      const reloadedOwner: any = { runId: "run", dispatched: true, closeRequestId: id };
      assert.equal((await closeOwnedChild(reloadedOwner, f.child, f.transport)).status, "rejected");
      assert.equal(reloadedOwner.closeRequestId, undefined);
      assert.equal(existsSync(join(f.control, "intent.json")), false);
      assert.equal(reloadedOwner.runId, "run", "process ownership is not released");
      assert.equal(readFileSync(join(f.control, `${id}.ack.json`), "utf8"), bytes);
      assert.ok(existsSync(join(f.control, `${id}.request.json`)));
      // Exercise the actual continuation reservation guard, not just its flag.
      const dir = continuationDir(f.child.activityFile); mkdirSync(dir);
      put(join(dir, "state.json"), { runId: "run", sessionFile: f.child.sessionFile,
        transport: CONTINUATION_TRANSPORT, state: "settled-idle", idleToken: randomUUID() });
      const live: any = { ...f.child, name: "child", surface: "owned", hasTurnResult: true,
        lifecycle: { process: { kind: "running" }, turn: { kind: "waiting" } } };
      const continuation = await continueLiveChild(reloadedOwner, live, { message: "resume after rejection" }, {
        inspect: async () => ({ kind: "present", agentStatus: "idle" } as any), timeoutMs: 0 });
      assert.equal(continuation.status, "pending", "continuation publication is no longer locked by rejected close");
      assert.ok(existsSync(join(dir, `${continuation.requestId}.request.json`)));
      // A later accepted continuation would clear this independent reservation.
      delete reloadedOwner.continuationRequestId;
      const token = randomUUID();
      put(join(f.control, `${token}.idle.json`), { ...f.identity, capability: CLOSE_CAPABILITY, idleToken: token });
      put(join(f.control, "current.json"), { file: `${token}.idle.json` });
      const fresh = await closeOwnedChild(reloadedOwner, f.child, f.transport);
      assert.notEqual(fresh.requestId, id); assert.equal(fresh.status, "pending");
      assert.equal(readFileSync(join(f.control, `${id}.ack.json`), "utf8"), bytes);
      assert.equal((await closeOwnedChild(reloadedOwner, f.child, f.transport)).requestId, fresh.requestId);
      assert.equal(readdirSync(f.control).filter(name => name.endsWith(".request.json")).length, 2);
    } finally { f.cleanup(); }
  }
});

test("wrong/ambiguous rejection records and durable claims never unlock or replay CLOSE", async () => {
  for (const extra of [{ process: { pid: 123, birth: "wrong" } }, { nonce: "wrong" }, { runId: "wrong" },
    { requestId: randomUUID() }, { headerId: "wrong" }, { idleToken: randomUUID() }, { dispatched: undefined }, { status: "requested" }, { claim: true }]) {
    const f = fixture();
    try {
      const first = await closeOwnedChild(f.owner, f.child, f.transport);
      const id = first.requestId!; const intent = read(join(f.control, "intent.json"));
      put(join(f.control, `${id}.ack.json`), { ...f.identity, capability: CLOSE_CAPABILITY, idleToken: intent.idleToken,
        requestId: id, status: "rejected", dispatched: false, ...extra });
      if ("claim" in extra) put(join(f.control, `${id}.claim.json`), { requestId: id });
      assert.equal((await closeOwnedChild(f.owner, f.child, f.transport)).status, "pending");
      assert.equal(f.owner.closeRequestId, id); assert.ok(existsSync(join(f.control, "intent.json")));
      assert.equal(readdirSync(f.control).filter(name => name.endsWith(".request.json")).length, 1);
    } finally { f.cleanup(); }
  }
});

test("PID reuse proves only original gone; remaining duplicate writers are not reported as whole-session closure", async () => {
  const f = fixture();
  try {
    const result = await closeOwnedChild(f.owner, f.child, { ...f.transport,
      probe: () => ({ kind: "present", identity: { ...f.identity.process, birth: "replacement" } }),
      audit: () => ({ ...f.transport.audit(), ownerCount: 2, status: "duplicate" }) });
    assert.equal(result.status, "closed"); assert.equal(result.remainingOwners, 2);
    assert.match(result.reason!, /Original owned process exited; session still/);
    assert.equal(readdirSync(f.control).some(name => name.endsWith("request.json")), false);
  } finally { f.cleanup(); }
});

test("lease/branch loss after awaiting never reports closed and retains ownership", async () => {
  const f = fixture();
  try {
    let valid = true;
    const closing = closeOwnedChild(f.owner, f.child, { ...f.transport, timeoutMs: 200,
      validate: () => { if (!valid) throw new Error("lease/branch lost"); } });
    valid = false;
    await assert.rejects(closing, /lease\/branch lost/);
    assert.ok(f.owner.closeRequestId);
    assert.ok(existsSync(join(f.control, `${f.owner.closeRequestId}.request.json`)));
  } finally { f.cleanup(); }
});

test("closure-phase yield still revalidates binding after original PID death", async () => {
  const f = fixture();
  try {
    let bindingValid = true;
    const closing = closeOwnedChild(f.owner, f.child, { ...f.transport,
      probe: () => ({ kind: "absent" }),
      validateClosed: () => { if (!bindingValid) throw new Error("closure branch/lease lost"); } });
    bindingValid = false;
    await assert.rejects(closing, /closure branch\/lease lost/);
    assert.equal(readdirSync(f.control).some(name => name.endsWith(".request.json")), false);
  } finally { f.cleanup(); }
});

test("child validates wrong run/process, busy state, immutable claims and replay; factory starts no watcher", async () => {
  const f = fixture();
  const env = { PI_SUBAGENT_ID: "run", PI_SUBAGENT_SESSION: f.child.sessionFile, PI_SUBAGENT_ACTIVITY_FILE: f.child.activityFile };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const handlers = new Map<string, Function>();
  const own = probeProcess(process.pid);
  assert.equal(own.kind, "present");
  if (own.kind !== "present") return;
  const identity = { ...f.identity, process: own.identity };
  put(`${runCompletionFile(f.child.sessionFile, "run")}.identity.json`, identity);
  let shutdowns = 0, idle = true, draft = "";
  const ctx = { hasUI: true, mode: "tui", ui: { getEditorText: () => draft },  sessionManager: { getHeader: () => ({ id: "header" }), getSessionFile: () => f.child.sessionFile },
    isIdle: () => idle, hasPendingMessages: () => false, shutdown: () => { shutdowns++; } };
  try {
    Object.assign(process.env, env);
    registerCloseControl({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
    rmSync(f.control, { recursive: true });
    assert.equal(existsSync(f.control), false);
    handlers.get("session_start")!({}, ctx);
    handlers.get("agent_settled")!({}, ctx);
    const pointer = read(join(f.control, "current.json"));
    const state = read(join(f.control, pointer.file));
    const request = async (extra: object = {}) => {
      const requestId = randomUUID();
      put(join(f.control, `${requestId}.request.json`), { ...state, ...extra, requestId });
      await until(() => existsSync(join(f.control, `${requestId}.ack.json`)));
      return { requestId, ack: read(join(f.control, `${requestId}.ack.json`)) };
    };
    assert.equal((await request({ runId: "wrong" })).ack.status, "rejected");
    assert.equal((await request({ process: { ...own.identity, birth: "wrong" } })).ack.status, "rejected");
    idle = false;
    assert.equal((await request()).ack.status, "rejected");
    assert.equal(shutdowns, 0);
    idle = true;
    // The idle capability already exists: typing after settlement must still
    // reject immediately before a claim, without discarding the draft.
    draft = "unsent draft after idle publication";
    const drafted = await request();
    assert.equal(drafted.ack.status, "rejected");
    assert.equal(existsSync(join(f.control, `${drafted.requestId}.claim.json`)), false);
    assert.equal(shutdowns, 0);
    draft = "";
    ctx.mode = "rpc";
    assert.equal((await request()).ack.status, "rejected", "RPC editor defaults cannot prove safety");
    ctx.mode = "tui";
    const getter = ctx.ui.getEditorText;
    ctx.ui.getEditorText = () => { throw new Error("unavailable editor"); };
    assert.equal((await request()).ack.status, "rejected");
    ctx.ui.getEditorText = getter;
    assert.equal(shutdowns, 0);
    const accepted = await request();
    assert.equal(accepted.ack.status, "requested"); assert.equal(shutdowns, 1);
    const ackBytes = readFileSync(join(f.control, `${accepted.requestId}.ack.json`), "utf8");
    put(join(f.control, `${accepted.requestId}.request.json`), { ...state, requestId: accepted.requestId });
    await pause(); assert.equal(shutdowns, 1);
    handlers.get("session_shutdown")!({}, ctx);
    handlers.get("session_start")!({}, ctx);
    handlers.get("agent_settled")!({}, ctx);
    put(join(f.control, `${accepted.requestId}.request.json`), { ...state, requestId: accepted.requestId });
    await pause(); assert.equal(shutdowns, 1);
    assert.equal(readFileSync(join(f.control, `${accepted.requestId}.ack.json`), "utf8"), ackBytes);
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.cleanup();
  }
});

test("SDK disposal after a real CLOSE watcher starts exits naturally with scrubbed inherited environment", { timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "close-sdk-dispose-"));
  const session = join(dir, "session.jsonl"), activityFile = join(dir, "activity.json");
  put(session, { type: "session", version: 3, id: "close-sdk", timestamp: new Date().toISOString(), cwd: dir });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("HC_") && !key.startsWith("HERDR")));
  Object.assign(env, { PI_SUBAGENT_ID: "sdk-run", PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ACTIVITY_FILE: activityFile });
  const child = spawn(process.execPath, [resolve("test/close-sdk-dispose-fixture.ts"), dir], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error(`SDK host failed natural exit: ${output}`)), 30000);
      child.once("exit", code => { clearTimeout(timer); resolveExit(code); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(code, 0, output);
    assert.match(output, /SDK disposed after live CLOSE publication/);
    assert.equal(probeProcess(child.pid!).kind, "absent");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once("exit", resolveExit)); child.kill(); await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi RPC UI cannot prove editor safety and rejects CLOSE without a model turn", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "close-pi-rpc-"));
  const session = join(dir, "session.jsonl"), activityFile = join(dir, "activity.json");
  put(session, { type: "session", version: 3, id: "close-rpc", timestamp: new Date().toISOString(), cwd: dir });
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT") && !key.startsWith("HC_") && !key.startsWith("HERDR")));
  Object.assign(env, { PI_SUBAGENT_ID: "rpc-run", PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ACTIVITY_FILE: activityFile });
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", session, "--no-extensions", "-e", resolve("test/close-rpc-fixture.ts"), "--provider", "close-test", "--model", "model", "--no-mcp", "--no-skills", "--no-context-files", "--offline"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const exit = new Promise(resolveExit => child.once("exit", resolveExit));
  try {
    child.stdin.write(JSON.stringify({ type: "prompt", message: "Settle once" }) + "\n");
    await until(() => existsSync(join(closeDir(activityFile), "current.json")), 60000);
    const identity = readChildIdentity(session, "rpc-run")!;
    assert.ok(identity); assert.equal(identity.process.pid, child.pid);
    const snapshot = enumerateProcesses();
    assert.ok(snapshot.rows.some(row => row.pid === child.pid));
    // Scope the OS enumeration fixture to this test's owned process. Unrelated host
    // processes can legitimately make a global Windows audit uncertain (unknown cwd).
    const audit = () => auditSession(session, { rows: snapshot.rows.filter(row => row.pid === child.pid), verified: snapshot.verified });
    assert.equal(audit().status, "single");
    const before = readFileSync(session, "utf8");
    const closing = closeOwnedChild({ runId: "rpc-run", dispatched: true }, { id: "rpc-run", cli: "pi", sessionFile: session, activityFile }, { validate: () => {}, audit, timeoutMs: 10000 });
    await until(() => readdirSync(closeDir(activityFile)).some(name => name.endsWith(".ack.json")));
    const result = await closing;
    assert.equal(result.status, "rejected");
    assert.equal(existsSync(join(closeDir(activityFile), `${result.requestId}.claim.json`)), false);
    assert.equal(probeProcess(identity.process.pid).kind, "present");
    const after = readFileSync(session, "utf8");
    assert.equal(after, before, "close does not start another model turn or append a prompt");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
    rmSync(dir, { recursive: true, force: true });
  }
});
