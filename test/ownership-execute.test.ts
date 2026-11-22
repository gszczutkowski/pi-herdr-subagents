import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { canWaitForDelegation, DELEGATION_PAUSED } from "../pi-extension/subagents/delegation-wait.ts";

// Exercise actual tool/terminal code, replacing only OS boundaries (no live herdr).
let powershellResponder: ((command: string) => string) | undefined;
let processEnumerationFails = false;
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
const originalRead = fs.readFileSync;
const originalReaddir = fs.readdirSync;
// Match the empty Windows process snapshot below: never audit the host's live
// processes (including inaccessible /proc entries) in these dispatch fixtures.
mock.method(fs, "readdirSync", (path: any, ...args: any[]) => {
  if (String(path) === "/proc") {
    if (processEnumerationFails) throw Object.assign(new Error("enumeration denied"), { code: "EACCES" });
    return [];
  }
  return (originalReaddir as any)(path, ...args);
});
let readFailureFile: string | undefined;
let readFailureCode = "EACCES";
mock.method(fs, "readFileSync", (path: any, ...args: any[]) => {
  if (readFailureFile && String(path).replaceAll("\\", "/").toLowerCase() === readFailureFile.replaceAll("\\", "/").toLowerCase()) {
    throw Object.assign(new Error(readFailureCode), { code: readFailureCode });
  }
  return (originalRead as any)(path, ...args);
});
mock.method(fs, "writeFileSync", (path: any, ...args: any[]) => {
  if (prepareFails && String(path).endsWith(".sh")) throw new Error("preparation failed");
  return (originalWrite as any)(path, ...args);
});
mock.method(childProcess, "execSync", () => "herdr");
mock.method(childProcess, "execFileSync", (_command: any, args: any) => {
  if (_command === "powershell.exe") {
    if (processEnumerationFails && args.at(-1).includes("Where-Object")) throw new Error("enumeration denied");
    return powershellResponder?.(args.at(-1)) ?? "[]";
  }
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
const { CONTINUE_COMMAND, CONTINUATION_TRANSPORT, continuationCommand, continuationDir, registerLiveContinuation } = await import("../pi-extension/subagents/live-continuation.ts");
const { registerInterruptControl } = await import("../pi-extension/subagents/interrupt-control.ts");
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

async function fixture(run: (f: any) => Promise<void>, explicit = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), "ownership-execute-"));
  const agentDir = join(dir, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir; // Explicit, isolated user configuration for this fixture.
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
  const commands = new Map<string, any>();
  const branch: any[] = [];
  const handlers = new Map<string, any>();
  const subscribers = new Map<string, (data: unknown) => void>();
  const events = {
    on: (event: string, fn: (data: unknown) => void) => { subscribers.set(event, fn); return () => subscribers.delete(event); },
    emit: (event: string, data: unknown) => subscribers.get(event)?.(data),
  };
  const api: any = new Proxy({}, { get: (_target, key) => key === "events" ? events
    : key === "registerTool" ? (tool: any) => tools.set(tool.name, tool)
    : key === "on" ? (event: string, handler: any) => handlers.set(event, handler)
    : key === "registerCommand" ? (name: string, command: any) => commands.set(name, command)
    : key === "getAllTools" ? () => []
    : key === "appendEntry" ? (customType: string, data: any) => branch.push({ id: "fixture-custody", type: "custom", customType, data })
    : key === "sendMessage" ? (message: any) => { if (failNotifications) throw new Error("offline"); handoffs.push(message); }
    : key === "getThinkingLevel" ? () => "off" : () => {} });
  const oldMode = process.env.PI_SUBAGENT_COMPLETION_MODE;
  if (explicit) process.env.PI_SUBAGENT_COMPLETION_MODE = "explicit";
  extension(api);
  const ctx = {
    hasUI: false, scopedModels: [], cwd: dir, isProjectTrusted: () => true, model: { provider: "test", id: "model" },
    modelRegistry: { find: () => ({ provider: "test", id: "model", reasoning: true }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => session, getSessionDir: () => dir, getSessionId: () => "parent" },
  };
  const resume = (params = {}) => tools.get("subagent_resume").execute("call", { sessionPath: session, ...params }, undefined, undefined, ctx);
  const interrupt = (id: string) => tools.get("subagent_interrupt").execute("interrupt", { id }, undefined, undefined, ctx);
  try { await run({ dir, session, ctx, branch, tools, commands, resume, interrupt, handoffs, events,
    canWait: () => canWaitForDelegation(api, ctx),
    start: () => handlers.get("session_start")({ reason: "reload" }, ctx),
    shutdown: () => handlers.get("session_shutdown")({ reason: "reload" }, ctx),
    reload: () => { extension(api); handlers.get("session_start")({ reason: "reload" }, ctx); },
    failNotifications: (value: boolean) => { failNotifications = value; } }); } finally {
    for (const stop of childShutdowns.splice(0)) stop();
    prepareFails = false;
    readFailureFile = undefined;
    powershellResponder = undefined;
    processEnumerationFails = false;
    sendFails = false;
    onRun = () => {};
    inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } });
    handlers.get("session_shutdown")({ reason: "exit" }, ctx);
    for (const [path, owner] of sessionOwners) if (!existingOwners.has(path)) releaseSession(path, owner.runId);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldMode === undefined) delete process.env.PI_SUBAGENT_COMPLETION_MODE; else process.env.PI_SUBAGENT_COMPLETION_MODE = oldMode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "condition timed out"); await pause(); }
}

test("isolated process enumeration is clear, but denied enumeration blocks resume before dispatch", { skip: !["linux", "win32"].includes(process.platform) }, async () => fixture(async ({ session, resume }: any) => {
  const { auditSession } = await import("../pi-extension/subagents/session-audit.ts");
  assert.equal(auditSession(session).status, "clear");
  const surfacesBefore = serial;
  const sendsBefore = sent.length;
  processEnumerationFails = true;
  const audit = auditSession(session);
  assert.equal(audit.status, "uncertain");
  assert.equal(audit.ownerCount, 0);
  assert.equal(audit.uncertainCount, 1);
  await assert.rejects(resume(), /Session process audit is uncertain/);
  assert.equal(serial, surfacesBefore, "no pane created on uncertain enumeration");
  assert.equal(sent.length, sendsBefore, "no terminal writes on uncertain enumeration");
  assert.equal(sessionOwners.has(session), false, "no ownership retained before dispatch");
  processEnumerationFails = false;
  assert.equal(auditSession(session).status, "clear");
  const started = await resume();
  assert.ok(__test__.runningSubagents.has(started.details.id));
}));

test("Windows missing launcher ancestry needs independent strict birth ordering, never PID-only permission", { skip: process.platform !== "win32" }, async () => fixture(async () => {
  const { isProtectedProcess } = await import("../pi-extension/subagents/process-identity.ts");
  const targetPid = 98765432;
  let birth: string | undefined = "2";
  powershellResponder = (command: string) => {
    if (command.includes("Get-CimInstance")) return JSON.stringify([{ pid: process.pid, parent: 98765431 }, { pid: targetPid, parent: 98765430 }]);
    if (command.includes(`-Id ${targetPid} `)) return birth ? JSON.stringify({ pid: targetPid, birth }) : "denied";
    return JSON.stringify({ pid: process.pid, birth: "1" });
  };
  assert.equal(isProtectedProcess(targetPid), false, "a verified younger process cannot be an ancestor despite missing MSYS parents");
  for (const uncertain of ["1", "0", undefined]) { birth = uncertain; assert.equal(isProtectedProcess(targetPid), undefined); }
  assert.equal(isProtectedProcess(process.pid), true); assert.equal(isProtectedProcess(process.ppid), true);
}));

for (const scenario of ["watcher-cleanup", "wrong-branch-live", "replacement-live", "wrong-branch-after-exit", "replacement-after-exit"]) {
test(`registered close ${scenario} preserves phase-specific ownership fences (Windows OS boundary)`, { skip: process.platform !== "win32" }, async () => fixture(async ({ tools, ctx, session, resume, reload }: any) => {
  // Keep the independent pane supervisor idle. Only this test's explicit map
  // removal models cleanup; unrelated pane-missing cleanup must not race it.
  inspect = async pane => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  const started = await resume();
  const child = __test__.runningSubagents.get(started.details.id)!;
  const targetPid = 98765432;
  const identity = { schema: 1, runId: child.id, sessionFile: session, headerId: "child", nonce: "test-nonce", process: { pid: targetPid, birth: "windows:2" } };
  fs.writeFileSync(`${runCompletionFile(session, child.id)}.identity.json`, JSON.stringify(identity));
  const { closeDir, CLOSE_CAPABILITY } = await import("../pi-extension/subagents/close-control.ts");
  const dir = closeDir(child.activityFile!); fs.mkdirSync(dir);
  const token = "00000000-0000-0000-0000-000000000001";
  fs.writeFileSync(join(dir, `${token}.idle.json`), JSON.stringify({ ...identity, capability: CLOSE_CAPABILITY, idleToken: token }));
  fs.writeFileSync(join(dir, "current.json"), JSON.stringify({ file: `${token}.idle.json` }));
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  let targetGone = false;
  powershellResponder = (command: string) => {
    if (command.includes("Where-Object")) return JSON.stringify(targetGone ? [] : [{ pid: targetPid, parentPid: process.pid, command: `node.exe "${cli}" --session "${session}"` }]);
    if (command.includes("Get-CimInstance")) return JSON.stringify([{ pid: process.pid, parent: 0 }, { pid: targetPid, parent: process.pid }]);
    if (command.includes(`-Id ${targetPid} `)) return targetGone ? "null" : JSON.stringify({ pid: targetPid, birth: "2" });
    return JSON.stringify({ pid: process.pid, birth: "1" });
  };
  const targetCloses = () => closed.filter(surface => surface === child.surface).length;
  const before = targetCloses();
  const closing = tools.get("subagent_close").execute("close", { id: child.id }, undefined, undefined, ctx);
  assert.ok(sessionOwners.get(session), "request itself never releases ownership");
  if (scenario === "watcher-cleanup") {
    // Normal supervision removes both records during closeOwnedChild's OS wait.
    __test__.runningSubagents.delete(child.id);
    sessionOwners.delete(session);
    targetGone = true;
  } else {
    const replacement = { runId: child.id, dispatched: true };
    if (scenario.startsWith("wrong-branch")) ctx.sessionManager.getSessionFile = () => join(dirname(session), "other-branch.jsonl");
    else sessionOwners.set(session, replacement);
    targetGone = scenario.endsWith("after-exit");
    await assert.rejects(closing, /branch|ownership/);
    if (scenario.startsWith("replacement")) assert.equal(sessionOwners.get(session), replacement);
    assert.equal(targetCloses(), before, "no terminal action on failed custody for this owned child");
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith(".request.json")).length, 1);
    return;
  }
  const result = await closing;
  assert.equal(result.details.status, "closed");
  assert.equal(sessionOwners.has(session), false);
  assert.equal(targetCloses(), before, "explicit close never operates this child's terminal locator");
  child.abortController.abort(); // Test removed the map, so fixture shutdown cannot find this watcher.
  reload();
  assert.deepEqual((await tools.get("subagent_close").execute("again", { id: child.id }, undefined, undefined, ctx)).details, result.details);
}));
}

for (const code of ["ENOSPC", "EACCES", "EIO"]) {
  test(`active completion ${code} pauses without closing or losing the child; explicit retry delivers once`, async () => fixture(async ({ resume, commands, ctx, branch, start, session, handoffs }: any) => {
    ctx.sessionManager.getHeader = () => ({ id: "child" });
    ctx.sessionManager.getBranch = () => branch;
    await start();
    const started = await resume();
    const child = __test__.runningSubagents.get(started.details.id)!;
    const events = `${runCompletionFile(session, child.id)}.events`;
    fs.mkdirSync(events, { recursive: true });
    const file = join(events, "io.json");
    fs.writeFileSync(file, JSON.stringify({ type: "done", runId: child.id, eventId: "io", summary: "Recovered result", keepOpen: true }));
    readFailureFile = file; readFailureCode = code;
    const before = closed.filter(pane => pane === child.surface).length;
    await until(() => !!child.observationError);
    assert.ok(__test__.runningSubagents.has(child.id));
    assert.equal(closed.filter(pane => pane === child.surface).length, before);
    assert.equal(handoffs.length, 0, "a read error is not a completion");
    readFailureFile = undefined;
    await commands.get("subagents-reconcile").handler("", ctx);
    await until(() => handoffs.length === 1);
    assert.equal(handoffs[0].details.response, "Recovered result");
    assert.equal(child.observationError, undefined);
    assert.equal(closed.filter(pane => pane === child.surface).length, before);
  }));
}

test("registered discovery/dispatch honors exact project grants and host denial", async () => fixture(async ({ tools, ctx, dir }: any) => {
  const base = process.env.PI_CODING_AGENT_DIR!;
  const source = join(dir, ".pi", "agents");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(join(base, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "role.md"), "---\nname: trust-role\nauto-exit: true\n---\nPROJECT ROLE");
  fs.writeFileSync(join(base, "agents", "role.md"), "---\nname: trust-role\nauto-exit: true\n---\nGLOBAL ROLE");
  const list = () => tools.get("subagents_list").execute("list", {}, undefined, undefined, ctx);
  assert.equal((await list()).details.agents.find((agent: any) => agent.name === "trust-role").source, "global");
  fs.writeFileSync(join(base, "subagent-trust.json"), JSON.stringify({ projectAgentDirectories: [source] }));
  assert.equal((await list()).details.agents.find((agent: any) => agent.name === "trust-role").source, "project");
  ctx.isProjectTrusted = () => false;
  assert.equal((await list()).details.agents.find((agent: any) => agent.name === "trust-role").source, "global");
  const started = await tools.get("subagent").execute("launch", { name: "Trust", task: "test", agent: "trust-role" }, undefined, undefined, ctx);
  const profile = (await import("../pi-extension/subagents/launch-profile.ts")).readPiLaunchProfile(started.details.sessionFile);
  assert.equal(profile.identity, "GLOBAL ROLE", "denied project cannot override even a same-name user definition");
}));

test("dispatch revalidates project source after asynchronous preparation", async () => fixture(async ({ tools, ctx, dir }: any) => {
  const base = process.env.PI_CODING_AGENT_DIR!;
  const source = join(dir, ".pi", "agents"), file = join(source, "role.md");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(file, "---\nname: changing-role\n---\nORIGINAL");
  fs.writeFileSync(join(base, "subagent-trust.json"), JSON.stringify({ projectAgentDirectories: [source] }));
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "25";
  const before = sent.length;
  try {
    const launching = tools.get("subagent").execute("launch", { name: "Change", task: "test", agent: "changing-role" }, undefined, undefined, ctx);
    fs.writeFileSync(file, "---\nname: changing-role\n---\nREPLACEMENT");
    await assert.rejects(launching, /definition.*changed/);
    assert.equal(sent.length, before);
  } finally { process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0"; }
}));

test("closed resume rejects revoked local agentDir authorization before dispatch", async () => fixture(async ({ resume, dir }: any) => {
  const old = process.env.PI_CODING_AGENT_DIR;
  const base = join(dir, "another-user-profile"); fs.mkdirSync(base);
  process.env.PI_CODING_AGENT_DIR = base;
  const before = sent.length;
  try {
    await assert.rejects(resume(), /not explicitly authorized/);
    assert.equal(sent.length, before);
  } finally { process.env.PI_CODING_AGENT_DIR = old; }
}));

test("already aborted spawn/resume never prepare or dispatch", async () => fixture(async ({ tools, ctx, session }: any) => {
  const signal = AbortSignal.abort();
  const before = sent.length;
  await assert.rejects(tools.get("subagent").execute("abort", { name: "Abort", task: "never run" }, signal, undefined, ctx), /abort/i);
  await assert.rejects(tools.get("subagent_resume").execute("abort", { sessionPath: session }, signal, undefined, ctx), /abort/i);
  assert.equal(sent.length, before);
}));

test("abort during shell preparation cancels delay and never dispatches", async () => fixture(async ({ tools, ctx }: any) => {
  const controller = new AbortController();
  const before = sent.length;
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "60000";
  try {
    const launch = tools.get("subagent").execute("abort", { name: "Abort", task: "never run" }, controller.signal, undefined, ctx);
    controller.abort();
    await assert.rejects(launch, /abort/i);
    assert.equal(sent.length, before);
  } finally { process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0"; }
}));

test("close is parent-owned, honors lifecycle denial and is not a child completion allowlist tool", async () => fixture(async ({ tools, ctx, session, resume }: any) => {
  const close = tools.get("subagent_close");
  assert.ok(close);
  assert.ok(__test__.resolveDenyTools({ spawning: false } as any).has("subagent_close"));
  assert.ok(__test__.resolveDenyTools({ denyTools: "subagent_close" } as any).has("subagent_close"));
  const { buildSubagentToolAllowlist } = await import("../pi-extension/subagents/harness/drivers/pi.ts");
  assert.equal(buildSubagentToolAllowlist("read")!.includes("subagent_close"), false);
  await assert.rejects(close.execute("close", { id: "untracked" }, undefined, undefined, ctx), /No running subagent/);
  const started = await resume();
  await assert.rejects(close.execute("close", { id: started.details.id }, undefined, undefined, ctx), /lacks verified process identity/);
  assert.equal(sessionOwners.get(session)!.runId, started.details.id);
  const child = __test__.runningSubagents.get(started.details.id)!;
  child.terminalActionsAllowed = false;
  await assert.rejects(close.execute("close", { id: started.details.id }, undefined, undefined, ctx), /custody/);
  const denied = new Map<string, any>();
  const previous = [process.env.PI_SUBAGENT_ID, process.env.PI_DENY_TOOLS];
  process.env.PI_SUBAGENT_ID = "restricted-child";
  process.env.PI_DENY_TOOLS = "subagent_close";
  try {
    extension(new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: any) => denied.set(tool.name, tool) : key === "getAllTools" ? () => [] : () => {} }) as any);
    assert.equal(denied.has("subagent_close"), false);
    assert.equal(denied.has("subagent_audit"), true);
  } finally {
    for (const [i, key] of ["PI_SUBAGENT_ID", "PI_DENY_TOOLS"].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
  }
}));

test("recovered release fails closed on writers, uncertainty, custody loss and replacement tokens (Windows OS boundary)", { skip: process.platform !== "win32" }, async () => fixture(async ({ dir, session }: any) => {
  const { RuntimeStore } = await import("../pi-extension/subagents/runtime-store.ts");
  const { releaseRecoveredSession } = await import("../pi-extension/subagents/runtime-recovery.ts");
  const store = new RuntimeStore(join(dir, "runtime"), { sessionFile: "parent", headerId: "parent", branchToken: "branch", checkpoint: "checkpoint" });
  const targetPid = 98765432;
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  store.prepare({ id: "recovered", sessionFile: session, name: "Recovered", task: "task", startTime: 1, cli: "pi" });
  const original = reserveSession(session, "recovered"); original.dispatched = true;
  fs.writeFileSync(`${runCompletionFile(session, original.runId)}.identity.json`, JSON.stringify({
    schema: 1, runId: original.runId, sessionFile: session, headerId: "child", nonce: "original",
    process: { pid: targetPid, birth: "windows:2" },
  }));
  let scenario = "live";
  const replacement = { runId: original.runId, dispatched: true };
  powershellResponder = (command: string) => {
    if (command.includes("Where-Object")) {
      if (scenario === "uncertain") return "denied";
      if (scenario === "replacement") sessionOwners.set(session, replacement);
      if (scenario === "custody-loss") store.isCurrent = () => false;
      return JSON.stringify(scenario === "writer" ? [{ pid: targetPid + 1, parentPid: 0, command: `node.exe "${cli}" --session "${session}"` }] : []);
    }
    if (command.includes(`-Id ${targetPid} `)) {
      if (scenario === "denied") return "denied";
      if (scenario === "live") return JSON.stringify({ pid: targetPid, birth: "2" });
      // PID reuse is proof of the original's death, not whole-session closure.
      if (scenario === "reused") return JSON.stringify({ pid: targetPid, birth: "3" });
      return "null";
    }
    return JSON.stringify({ pid: targetPid + 1, birth: "3" });
  };
  try {
    for (scenario of ["live", "denied"]) {
      releaseRecoveredSession(store, session);
      assert.equal(sessionOwners.get(session), original);
    }
    for (scenario of ["writer", "uncertain"]) {
      assert.throws(() => releaseRecoveredSession(store, session), /audit is single|audit is uncertain/);
      assert.equal(sessionOwners.get(session), original);
    }
    scenario = "custody-loss";
    assert.throws(() => releaseRecoveredSession(store, session), /custody/);
    assert.equal(sessionOwners.get(session), original);
    store.isCurrent = () => true;
    scenario = "replacement";
    assert.throws(() => releaseRecoveredSession(store, session), /ownership changed/);
    assert.equal(sessionOwners.get(session), replacement, "same-run replacement token cannot be released");
    sessionOwners.set(session, original);
    scenario = "reused";
    releaseRecoveredSession(store, session);
    assert.equal(sessionOwners.has(session), false);
  } finally { store.close(); }
}));

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
  // Guarded interrupt now yields to the real watcher. This synthetic terminal
  // exists throughout setup; the fixture's default missing-pane response would
  // otherwise retire its custody under load before the control test begins.
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "active" } } });
  const owner = sessionOwners.get(session)!;
  const abort = child.abortController;
  const activityFile = child.activityFile;
  const launchScript = child.launchScriptFile;
  const surfacesBefore = serial;
  const sendsBefore = sent.length;
  const escapesBefore = escapes.length;
  const events = new Map<string, Function>();
  const on = (event: string, handler: Function) => {
    const previous = events.get(event);
    events.set(event, (...args: any[]) => { previous?.(...args); handler(...args); });
  };
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const identity = { schema: 1, runId: child.id, sessionFile: session, headerId: "child", nonce: "test", process: { pid: process.pid, birth: "test" } };
  fs.writeFileSync(`${runCompletionFile(session, child.id)}.identity.json`, JSON.stringify(identity));
  const env = { PI_SUBAGENT_ID: child.id, PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ACTIVITY_FILE: activityFile };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    registerLiveContinuation({ on,
      registerCommand: (name: string, command: any) => commands.set(name, command),
      sendUserMessage: (...args: any[]) => messages.push(args) } as any);
    registerInterruptControl({ on } as any, () => ({ kind: "present", identity: identity.process }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  let childIdle = false, turnAborts = 0;
  const childCtx = { isIdle: () => childIdle, hasPendingMessages: () => false, abort: () => { turnAborts++; },
    sessionManager: { getSessionFile: () => session, getHeader: () => ({ id: "child" }) } };
  events.get("session_start")!({}, childCtx);
  events.get("before_agent_start")!({}, childCtx);
  childShutdowns.push(() => events.get("session_shutdown")!({}, childCtx));
  fs.writeFileSync(activityFile, JSON.stringify({ version: 1, runningChildId: child.id,
    createdAt: Date.now(), updatedAt: Date.now(), sequence: 1, latestEvent: "agent_start",
    phase: "active", activeScope: "agent", agentActive: true, turnActive: true, providerActive: false, toolActive: false }));
  assert.equal((await interrupt(child.id)).details.status, "interrupt_requested");
  assert.equal(turnAborts, 1);
  assert.equal(escapes.length, escapesBefore, "guarded interrupt never sends terminal keys");
  assert.equal(child.lifecycle.process.kind, "running");
  assert.equal(child.lifecycle.turn.kind, "interrupted");
  assert.equal(abort.signal.aborted, false);
  assert.equal(sessionOwners.get(session), owner);
  assert.equal(__test__.runningSubagents.get(child.id), child);
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  const message = "  /subagent_done\n!echo unsafe\n@private.txt\n/skill:secret\n${shell}; ' \"\n\r\n ";
  await assert.rejects(resume({ message }), /not confirmed settled/);
  assert.equal(messages.length, 0, "acknowledgement alone is not child settlement evidence");
  assert.equal(sent.length, sendsBefore);
  childIdle = true;
  events.get("agent_settled")!({ aborted: true }, childCtx);
  for (const message of [undefined, "", " \n\t"]) {
    await assert.rejects(resume({ message }), /nonempty message/);
    assert.equal(fs.readdirSync(`${activityFile}.continuation`).some(name => name.endsWith(".request.json")), false);
    assert.equal(messages.length, 0, "raw empty messages without a contract do not start a turn");
    assert.equal(serial, surfacesBefore);
  }
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

test("explicit wait tracks accepted keepOpen follow-ups, not old results, rejected requests or replay", { timeout: 15_000 }, async () => fixture(async (f: any) => {
  const { session, resume, handoffs, canWait, ctx, branch, events } = f;
  ctx.sessionManager.getHeader = () => ({ id: "coordinator" });
  ctx.sessionManager.getBranch = () => branch;
  inspect = async pane => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "idle" } } });
  await f.start();
  const started = await resume();
  const child = __test__.runningSubagents.get(started.details.id)!;
  const owner = sessionOwners.get(session)!;
  const dir = continuationDir(child.activityFile!);
  const pauses: any[] = [];
  events.on(DELEGATION_PAUSED, (entry: unknown) => pauses.push(entry));
  fs.mkdirSync(dir);
  const artifacts = `${runCompletionFile(session, child.id)}.events`;
  fs.mkdirSync(artifacts);
  const result = async (eventId: string) => {
    const prior = handoffs.length;
    fs.writeFileSync(join(artifacts, `${eventId}.json`), JSON.stringify({ type: "done", runId: child.id, eventId, summary: eventId, keepOpen: true }));
    await until(() => handoffs.length > prior);
    assert.equal(handoffs.length, prior + 1);
    assert.equal(handoffs.at(-1).details.response, eventId);
  };
  const begin = async (message: string) => {
    fs.writeFileSync(join(dir, "state.json"), JSON.stringify({ runId: child.id, sessionFile: session,
      idleToken: randomUUID(), transport: CONTINUATION_TRANSPORT, state: "settled-idle" }));
    const pending = resume({ message });
    // Attach immediately: tests below deliberately exercise negative receipts.
    void pending.catch(() => {});
    const artifact = (ext: string) => join(dir, `${owner.continuationRequestId}.${ext}.json`);
    await until(() => !!owner.continuationRequestId && fs.existsSync(artifact("request")));
    const request = JSON.parse(fs.readFileSync(artifact("request"), "utf8"));
    const receiptPath = artifact("result");
    const claimPath = artifact("claim");
    return { pending, requestId: request.requestId,
      receipt: (status: string) => fs.writeFileSync(receiptPath, JSON.stringify({ ...request, status })),
      claim: () => fs.writeFileSync(claimPath, JSON.stringify({ runId: child.id, requestId: request.requestId, status: "dispatching" })) };
  };

  assert.equal(canWait(), true, "initial launch is still a wake source");
  await result("first");
  assert.equal(canWait(), false, "an idle keepOpen pane is not delegated work");

  const rejected = await begin("rejected");
  assert.equal(canWait(), false, "a published request without receipt is uncertain");
  rejected.receipt("rejected");
  await assert.rejects(rejected.pending, /Child rejected/);
  assert.equal(canWait(), false);
  assert.equal(owner.continuationRequestId, undefined);

  const accepted = await begin("accepted");
  accepted.receipt("accepted");
  assert.equal(canWait(), false, "acceptance without the durable claim is not proof");
  accepted.claim();
  assert.equal(canWait(), true, "the read-only query can use an authenticated receipt");
  assert.equal(owner.continuationRequestId, accepted.requestId, "query never consumes the ownership fence");
  assert.equal((await accepted.pending).details.status, "continued");
  assert.equal(canWait(), true, "a confirmed follow-up remains a wake source after reconciliation");
  assert.equal(child.hasTurnResult, true, "historical keepOpen evidence is preserved");
  sessionOwners.set(session, { ...owner });
  try { assert.equal(canWait(), false, "a replacement owner cannot inherit the wake source"); }
  finally { sessionOwners.set(session, owner); }
  await result("second");
  assert.equal(canWait(), false, "a handed-off continuation result retires the wake source");

  const fast = await begin("fast result, delayed receipt");
  fast.claim();
  await result("fast");
  fast.receipt("accepted");
  assert.equal((await fast.pending).details.status, "continued");
  assert.equal(canWait(), false, "a late acknowledgement cannot resurrect a delivered follow-up");

  const late = await begin("late acceptance");
  assert.equal((await late.pending).details.status, "pending");
  assert.equal(owner.continuationRequestId, late.requestId);
  assert.equal(canWait(), false, "a timed-out request is not a wake source");
  late.claim();
  late.receipt("accepted");
  assert.equal((await resume({ message: "recheck only, never send" })).details.requestId, late.requestId);
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith(".request.json")).length, 4);
  assert.equal(canWait(), true, "reconciliation can confirm the original outstanding request");
  inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } });
  await until(() => !__test__.runningSubagents.has(child.id));
  assert.equal(canWait(), false);
  assert.equal(handoffs.length, 3, "do not re-send the last result as a process-exit result");
  assert.equal(pauses.length, 1);
  assert.match(pauses[0].reason, /exited without a retained continuation result/);
}, true));
