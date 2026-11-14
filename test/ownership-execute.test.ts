import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test, mock } from "node:test";

// Exercise actual tool/terminal code, replacing only OS boundaries (no live herdr).
let prepareFails = false;
let sendFails = false;
let serial = 0;
let inspect: (pane: string) => Promise<string> = async () => JSON.stringify({ error: { code: "pane_not_found" } });
const closed: string[] = [];
const sent: string[] = [];
let onRun: (surface: string, command: string) => void = () => {};
const escapes: string[] = [];
const childShutdowns: Array<() => void> = [];
const originalWrite = fs.writeFileSync;
mock.method(fs, "writeFileSync", (path: any, ...args: any[]) => {
  if (prepareFails && String(path).endsWith(".sh")) throw new Error("preparation failed");
  return (originalWrite as any)(path, ...args);
});
mock.method(childProcess, "execSync", () => "herdr");
mock.method(childProcess, "execFileSync", (_command: any, args: any) => {
  if (_command === "powershell.exe") return "[]";
  if (args[0] === "tab" && args[1] === "create") {
    return JSON.stringify({ result: { root_pane: { pane_id: `child-${++serial}` } } });
  }
  if (args[1] === "run") {
    sent.push(args[2]);
    if (sendFails) throw new Error("ambiguous send failure");
    onRun(args[2], args[3]);
  }
  if (args[1] === "send-keys") escapes.push(args[2]);
  if (args[1] === "close") closed.push(args[2]);
  return "";
});
const originalExec = childProcess.execFile;
childProcess.execFile = Object.assign(() => { throw new Error("unexpected execFile"); }, {
  [promisify.custom]: async (_command: string, args: string[]) => ({ stdout: args[1] === "get" ? await inspect(args[2]) : "" }),
}) as any;
syncBuiltinESMExports();
const { default: extension, __test__ } = await import("../pi-extension/subagents/index.ts");
const { canonicalSessionPath, reserveSession, releaseSession, sessionOwners } = await import("../pi-extension/subagents/ownership.ts");
const { persistLaunchProfile, resolveLaunchProfile } = await import("../pi-extension/subagents/launch-profile.ts");
const { runCompletionFile } = await import("../pi-extension/subagents/run-artifacts.ts");
const { runInPane, runScriptInPane } = await import("../pi-extension/subagents/terminal.ts");
const { CONTINUE_COMMAND, continuationCommand, registerLiveContinuation } = await import("../pi-extension/subagents/live-continuation.ts");
const keys = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_SUBAGENT_SHELL_READY_DELAY_MS", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "workspace";
process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT"]) delete process.env[key];
after(() => {
  mock.restoreAll();
  childProcess.execFile = originalExec;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function fixture(run: (f: any) => Promise<void>) {
  const dir = fs.mkdtempSync(join(tmpdir(), "ownership-execute-"));
  const agentDir = join(dir, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const session = canonicalSessionPath(join(dir, "child.jsonl"));
  fs.writeFileSync(session, '{"type":"session","version":3,"id":"child","cwd":"test"}\n');
  const context: any = {
    params: { id: "original", name: "Original" }, runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
    effectiveCwd: dir, effectiveAutoExit: false, effectiveInteractive: true, taskDelivery: "artifact",
    subagentSessionFile: session, localAgentDir: agentDir, denySet: new Set(),
  };
  persistLaunchProfile(resolveLaunchProfile(context, "pi", "read"));
  const existingOwners = new Set(sessionOwners.keys());
  const handoffs: any[] = [];
  let failNotifications = false;
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const api: any = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: any) => tools.set(tool.name, tool)
    : key === "on" ? (event: string, handler: any) => handlers.set(event, handler)
    : key === "getAllTools" ? () => []
    : key === "sendMessage" ? (message: any) => { if (failNotifications) throw new Error("offline"); handoffs.push(message); }
    : key === "getThinkingLevel" ? () => "off" : () => {} });
  extension(api);
  const ctx = {
    hasUI: false, scopedModels: [], cwd: dir, model: { provider: "test", id: "model" },
    modelRegistry: { find: () => ({ provider: "test", id: "model", reasoning: true }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => session, getSessionDir: () => dir, getSessionId: () => "parent" },
  };
  const resume = (params = {}) => tools.get("subagent_resume").execute("call", { sessionPath: session, ...params }, undefined, undefined, ctx);
  const interrupt = (id: string) => tools.get("subagent_interrupt").execute("interrupt", { id }, undefined, undefined, ctx);
  try { await run({ dir, session, ctx, tools, resume, interrupt, handoffs,
    start: () => handlers.get("session_start")({ reason: "reload" }, ctx),
    shutdown: () => handlers.get("session_shutdown")({ reason: "reload" }, ctx),
    reload: () => { extension(api); handlers.get("session_start")({ reason: "reload" }, ctx); },
    failNotifications: (value: boolean) => { failNotifications = value; } }); } finally {
    for (const stop of childShutdowns.splice(0)) stop();
    prepareFails = false;
    sendFails = false;
    onRun = () => {};
    inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } });
    handlers.get("session_shutdown")({ reason: "exit" }, ctx);
    for (const [path, owner] of sessionOwners) if (!existingOwners.has(path)) releaseSession(path, owner.runId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "condition timed out"); await pause(); }
}

test("registered audit is read only and accepts a path or an owned selector", async () => fixture(async ({ tools, ctx, session, resume }: any) => {
  const audit = tools.get("subagent_audit");
  assert.ok(audit);
  const before = serial;
  const result = await audit.execute("audit", { sessionPath: session }, undefined, undefined, ctx);
  assert.equal(result.details.status, "clear");
  assert.equal(serial, before);
  await assert.rejects(audit.execute("audit", { sessionPath: session, id: "other" }, undefined, undefined, ctx), /OR/);
  const started = await resume();
  assert.equal((await audit.execute("audit", { id: started.details.id }, undefined, undefined, ctx)).details.sessionPath, session);
}));

test("registered interrupt/resume preserves the live run and watcher; concurrent continuation has one winner", async () => fixture(async ({ session, resume, interrupt }: any) => {
  const started = await resume();
  const child = __test__.runningSubagents.get(started.details.id)!;
  const owner = sessionOwners.get(session)!;
  const abort = child.abortController;
  const activityFile = child.activityFile;
  const launchScript = child.launchScriptFile;
  const surfacesBefore = serial;
  const sendsBefore = sent.length;
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const env = { PI_SUBAGENT_ID: child.id, PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ACTIVITY_FILE: activityFile };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    registerLiveContinuation({ on: (event: string, handler: Function) => events.set(event, handler),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      sendUserMessage: (...args: any[]) => messages.push(args) } as any);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const childCtx = { isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionFile: () => session } };
  events.get("session_start")!({}, childCtx);
  childShutdowns.push(() => events.get("session_shutdown")!({}, childCtx));
  fs.writeFileSync(activityFile, JSON.stringify({ version: 1, runningChildId: child.id,
    createdAt: Date.now(), updatedAt: Date.now(), sequence: 1, latestEvent: "agent_start",
    phase: "active", activeScope: "agent", agentActive: true, turnActive: true, providerActive: false, toolActive: false }));
  assert.equal((await interrupt(child.id)).details.status, "interrupt_requested");
  assert.equal(escapes.at(-1), child.surface);
  assert.equal(child.lifecycle.process.kind, "running");
  assert.equal(child.lifecycle.turn.kind, "interrupted");
  assert.equal(abort.signal.aborted, false);
  assert.equal(sessionOwners.get(session), owner);
  assert.equal(__test__.runningSubagents.get(child.id), child);
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  const message = "  /subagent_done\n!echo unsafe\n@private.txt\n/skill:secret\n${shell}; ' \"\n\r\n ";
  await assert.rejects(resume({ message }), /not confirmed settled/);
  assert.equal(messages.length, 0, "Escape alone is not child settlement evidence");
  assert.equal(sent.length, sendsBefore);
  events.get("agent_settled")!({ aborted: true }, childCtx);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let inspectionHeld = false;
  inspect = async (pane) => {
    if (owner.continuationRequestId && !inspectionHeld) { inspectionHeld = true; await gate; }
    return JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  };
  onRun = (surface, command) => {
    assert.equal(surface, child.surface);
    assert.equal(command, continuationCommand(owner.continuationRequestId!));
    commands.get(CONTINUE_COMMAND).handler(command.split(" ")[1], childCtx);
  };
  const first = resume({ message });
  try {
    await until(() => !!owner.continuationRequestId);
    // Keep the winner suspended at continuation inspection while the loser passes routing.
    await assert.rejects(resume({ message: "must not be delivered" }), /in flight/);
    assert.equal(messages.length, 0);
    assert.equal(sent.length, sendsBefore);
    release();
    const result = await first;
    assert.equal(result.details.status, "continued");
    assert.equal(result.details.id, child.id);
    assert.equal(result.details.sessionPath, session);
  } finally { release(); }
  assert.deepEqual(messages, [[message, { expandPromptTemplates: false }]]);
  assert.equal(serial, surfacesBefore, "no replacement process/pane");
  assert.equal(sent.length, sendsBefore, "artifact continuation never sends terminal input");
  assert.equal(sessionOwners.get(session), owner);
  assert.equal(__test__.runningSubagents.get(child.id), child);
  assert.equal(child.abortController, abort);
  assert.equal(abort.signal.aborted, false);
  assert.equal(child.activityFile, activityFile);
  assert.equal(child.launchScriptFile, launchScript);
  // No replacement launch: the original watcher must still consume this run's sidecar.
  assert.equal(child.lifecycle.process.completion, undefined);
  fs.writeFileSync(runCompletionFile(session, child.id), JSON.stringify({ type: "done", runId: child.id, keepOpen: true }));
  await until(() => child.hasTurnResult === true);
  assert.equal(child.lifecycle.process.kind, "running");
  assert.equal(child.lifecycle.turn.kind, "waiting");
  assert.equal(serial, surfacesBefore);
}));

test("simultaneous registered resumes of a closed owner reserve once after shared inspection", async () => fixture(async ({ session, resume }: any) => {
  const old = reserveSession(session, "closed-owner"); old.surface = "closed-pane";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let inspections = 0;
  inspect = async () => { inspections++; await gate; return JSON.stringify({ error: { code: "pane_not_found" } }); };
  const before = serial;
  const sendsBefore = sent.length;
  const attempts = [resume(), resume()];
  const results = Promise.allSettled(attempts);
  try {
    await until(() => inspections === 2);
    assert.equal(sessionOwners.get(session), old);
    assert.equal(serial, before, "no launch before inspection resolves");
    release();
    const settled = await results;
    const winners = settled.filter((result) => result.status === "fulfilled");
    const losers = settled.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(String(losers[0].reason), /already owned/);
    const winner = winners[0].value;
    assert.equal(winner.details.status, "started");
    assert.equal(sessionOwners.get(session)!.runId, winner.details.id);
    assert.equal(sessionOwners.get(session)!.dispatched, true);
    assert.equal(serial, before + 1);
    assert.equal(sent.length, sendsBefore + 1);
    assert.ok(__test__.runningSubagents.has(winner.details.id));
  } finally { release(); }
}));

test("registered resume recovers a missing pane before selecting its tracked live run", async () => fixture(async ({ session, resume }: any) => {
  const first = await resume();
  const original = __test__.runningSubagents.get(first.details.id)!;
  const oldOwner = sessionOwners.get(session)!;
  const before = serial;
  // The fixture reports missing, even though the previous running entry still exists.
  const next = await resume({ message: "closed session follow-up" });
  assert.equal(next.details.status, "started");
  assert.notEqual(next.details.id, original.id);
  assert.notEqual(sessionOwners.get(session), oldOwner);
  assert.equal(sessionOwners.get(session)!.runId, next.details.id);
  assert.equal(serial, before + 1);
}));

test("real resume execute: completion retains ownership, closed pane inspection unlocks fresh resume", async () => fixture(async ({ session, resume }: any) => {
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  const first = await resume();
  const owner = sessionOwners.get(session)!;
  assert.equal(owner.dispatched, true);
  fs.writeFileSync(runCompletionFile(session, first.details.id), JSON.stringify({ type: "done", runId: first.details.id, keepOpen: true }));
  await until(() => __test__.runningSubagents.get(first.details.id)?.hasTurnResult === true);
  assert.equal(sessionOwners.get(session), owner, "logical completion is not process exit");
  inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } });
  const second = await resume();
  assert.equal(second.details.status, "started");
  assert.notEqual(second.details.id, first.details.id);
  assert.notEqual(sessionOwners.get(session)!.surface, owner.surface);
}));

test("awaited inspection cannot release a replacement ownership token", async () => fixture(async ({ session, resume }: any) => {
  const old = reserveSession(session, "old"); old.surface = "closed";
  let finish!: (value: string) => void;
  let inspecting = false;
  inspect = async () => { inspecting = true; return new Promise((resolve) => { finish = resolve; }); };
  try {
    const pending = resume();
    await until(() => inspecting);
    releaseSession(session, "old");
    const replacement = reserveSession(session, "old"); replacement.surface = "replacement";
    finish(JSON.stringify({ error: { code: "pane_not_found" } }));
    await assert.rejects(pending, /already owned/);
    assert.equal(sessionOwners.get(session), replacement);
  } finally { inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } }); }
}));

test("no-owner resumes reserve synchronously before yielding", async () => fixture(async ({ resume }: any) => {
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "working" } } });
  try {
    const first = resume();
    await assert.rejects(resume(), /already owned/);
    assert.equal((await first).details.status, "started");
  } finally { inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } }); }
}));

test("resume preparation failure closes new surface and unlocks; ambiguous send retains owner", async () => fixture(async ({ session, resume }: any) => {
  prepareFails = true;
  const before = sent.length;
  await assert.rejects(resume(), /preparation failed/);
  assert.equal(sessionOwners.has(session), false);
  assert.ok(closed.includes(`child-${serial}`));
  assert.equal(sent.length, before);
  prepareFails = false; sendFails = true;
  await assert.rejects(resume(), /ambiguous send failure/);
  const owner = sessionOwners.get(session)!;
  assert.equal(owner.dispatched, true);
  assert.ok(!closed.includes(owner.surface!));
}));

test("spawn preparation cleanup respects caller-owned surfaces; ambiguous sends retain ownership", async () => fixture(async ({ ctx }: any) => {
  const params: any = { name: "Spawn", task: "task", cwd: ctx.cwd };
  prepareFails = true;
  await assert.rejects(__test__.launchSubagent(params, ctx, "off"), /preparation failed/);
  assert.ok(closed.includes(`child-${serial}`));
  await assert.rejects(__test__.launchSubagent(params, ctx, "off", { surface: "provided" }), /preparation failed/);
  assert.ok(!closed.includes("provided"));
  assert.equal([...sessionOwners.values()].filter((owner) => owner.surface === "provided").length, 0);
  prepareFails = false; sendFails = true;
  await assert.rejects(__test__.launchSubagent(params, ctx, "off"), /ambiguous send failure/);
  const owner = [...sessionOwners.values()].find((entry) => entry.surface === `child-${serial}`)!;
  assert.equal(owner.dispatched, true);
  assert.ok(!closed.includes(owner.surface!));
}));

test("terminal dispatch callbacks follow preparation and preflight, but precede ambiguous send", async () => fixture(async ({ dir }: any) => {
  let dispatched = false;
  prepareFails = true;
  assert.throws(() => runScriptInPane("target", "true", { scriptPath: join(dir, "launch.sh"), onDispatch: () => { dispatched = true; } }), /preparation failed/);
  assert.equal(dispatched, false);
  const env = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  assert.throws(() => runInPane("target", "true", () => { dispatched = true; }), /not available/);
  assert.equal(dispatched, false);
  process.env.HERDR_ENV = env;
  prepareFails = false; sendFails = true;
  assert.throws(() => runScriptInPane("target", "true", { scriptPath: join(dir, "launch.sh"), onDispatch: () => { dispatched = true; } }), /ambiguous send failure/);
  assert.equal(dispatched, true);
}));

test("keepOpen first result retains watcher and owner; parent follow-up and manual turns survive reload/outbox failure", async () => fixture(async (f: any) => {
  const { session, resume, handoffs } = f;
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  f.start();
  f.failNotifications(true);
  const started = await resume();
  const child = __test__.runningSubagents.get(started.details.id)!;
  const owner = sessionOwners.get(session)!;
  const abort = child.abortController;
  const paneCount = serial;
  const completion = (eventId: string, summary: string, keepOpen = true) => fs.writeFileSync(runCompletionFile(session, child.id),
    JSON.stringify({ type: "done", runId: child.id, eventId, summary, keepOpen }));
  const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
  completion("first", "first snapshot");
  await until(() => child.hasTurnResult && runtime.delivery.pending.size === 1);
  assert.equal(child.lifecycle.process.kind, "running");
  assert.equal(child.lifecycle.turn.kind, "waiting");
  assert.equal(sessionOwners.get(session), owner);
  assert.equal(handoffs.length, 0);
  const widget = __test__.renderSubagentWidgetLines([child], 120).join("\n");
  assert.match(widget, /1 open/);
  assert.match(widget, /idle/);
  assert.doesNotMatch(widget, /1 active/);
  const firstEnvelope = [...runtime.delivery.pending.values()][0].envelope;
  f.shutdown();
  // Real child bridge registration: completed (not aborted) settlement issues a
  // fresh idle token; the parent must use the same pane/run/profile.
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const prompts: any[] = [];
  const env = { PI_SUBAGENT_ID: child.id, PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ACTIVITY_FILE: child.activityFile };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    registerLiveContinuation({ on: (event: string, handler: Function) => events.set(event, handler),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      sendUserMessage: (...args: any[]) => prompts.push(args) } as any);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const childCtx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => session } };
  events.get("session_start")!({}, childCtx);
  childShutdowns.push(() => events.get("session_shutdown")!({}, childCtx));
  events.get("agent_settled")!({ aborted: false }, childCtx);
  onRun = (_surface, command) => {
    const id = command.split(" ")[1];
    commands.get(CONTINUE_COMMAND).handler(id, childCtx);
    commands.get(CONTINUE_COMMAND).handler(id, childCtx); // duplicate terminal delivery
  };
  const exact = " /skill:private\n!literal\n@file\nline two ";
  const followup = await resume({ message: exact });
  assert.equal(followup.details.status, "continued");
  assert.deepEqual(prompts, [[exact, { expandPromptTemplates: false }]]);
  assert.equal(child.abortController, abort);
  assert.equal(serial, paneCount);
  completion("second", "follow-up snapshot");
  await until(() => runtime.delivery.pending.size === 2);
  assert.equal([...runtime.delivery.pending.values()][0].envelope, firstEnvelope);
  f.failNotifications(false);
  for (const entry of runtime.delivery.pending.values()) entry.retryAt = 0;
  f.reload();
  assert.deepEqual(handoffs.map((m: any) => m.details.response), ["first snapshot", "follow-up snapshot"]);
  assert.equal(new Set(handoffs.map((m: any) => m.details.eventId)).size, 2);
  assert.equal(runtime.delivery.pending.size, 0);
  assert.equal(__test__.runningSubagents.get(child.id), child);
  assert.equal(sessionOwners.get(session), owner);
  // A manual follow-up needs no parent continuation request but still reports.
  completion("manual", "manual snapshot");
  await until(() => handoffs.length === 3);
  completion("manual", "duplicate must not replace snapshot");
  await until(() => !fs.existsSync(runCompletionFile(session, child.id)));
  assert.equal(handoffs.length, 3);
  assert.equal(child.abortController, abort);
  // Closing the process ends supervision without re-sending the last result.
  inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } });
  await until(() => !__test__.runningSubagents.has(child.id));
  assert.equal(sessionOwners.has(session), false);
  assert.equal(handoffs.length, 3);
}));
