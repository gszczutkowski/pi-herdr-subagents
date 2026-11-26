import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, mock, test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureDispatchEvidence, dispatchIncidents, readDispatchEvidence, reconcileDispatchEvidence, type DispatchEvidence } from "../pi-extension/subagents/dispatch-recovery.ts";
import { enqueueDelivery } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { canonicalSessionPath, releaseSession, sessionOwners } from "../pi-extension/subagents/ownership.ts";
import { launchProfilePath, persistLaunchProfile, resolveLaunchProfile } from "../pi-extension/subagents/launch-profile.ts";
import { bindPlanRun, importPlanEnvelope, recordDispatchFailure, type PlanTaskBinding } from "../pi-extension/subagents/plan-runtime.ts";
import { addTask, startAttempt } from "../pi-extension/subagents/plan-store.ts";
import { RuntimeStore, dispatchFailureEventId, dispatchFailureSource, readRuntimeManifest, resumeIntentBinding, verifyResumeImages, type RuntimeManifest } from "../pi-extension/subagents/runtime-store.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";
import { probeProcess } from "../pi-extension/subagents/process-identity.ts";
import { readChildIdentity } from "../pi-extension/subagents/recovery-identity.ts";
import { auditSession, assertSessionWriters } from "../pi-extension/subagents/session-audit.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });
// The test is a synthetic parent even when run by an installed Pi worker.
const childMarkers = Object.fromEntries(["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION", "PI_DENY_TOOLS"].map(key => [key, process.env[key]]));
for (const key of Object.keys(childMarkers)) delete process.env[key];
after(() => { for (const [key, value] of Object.entries(childMarkers)) if (value !== undefined) process.env[key] = value; });

// herdr caches promisify(execFile) at import time; keep asynchronous watcher
// queries inert even when the unrelated-resume control launches a watcher.
const execFile = childProcess.execFile;
childProcess.execFile = Object.assign(() => { throw new Error("unexpected async transport"); }, {
  [promisify.custom]: async () => ({ stdout: JSON.stringify({ result: { pane: { pane_id: "synthetic", agent_status: "idle" } } }) }),
}) as typeof execFile;
syncBuiltinESMExports();
const { default: extension } = await (async () => {
  try { return await import("../pi-extension/subagents/index.ts"); }
  finally { childProcess.execFile = execFile; syncBuiltinESMExports(); }
})();

function mockResumeTerminal(t: TestContext, dir: string, absentPid?: number, onPaneCreated?: () => void) {
  const env = { ...process.env }, platform = process.platform;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "synthetic";
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_SUBAGENT_LAYOUT"]) delete process.env[key];
  // Pin the synthetic OS writer audit to a supported backend.
  if (platform !== "linux" && platform !== "win32") Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const counts = { panes: 0, sends: 0 };
  const readdir = fs.readdirSync;
  const audit = t.mock.method(fs, "readdirSync", (path: any, ...args: any[]) => String(path) === "/proc" ? [] : Reflect.apply(readdir, fs, [path, ...args]));
  const which = t.mock.method(childProcess, "execSync", () => "herdr");
  const command = t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    if (file === "powershell.exe") return args.some(arg => arg.includes(`Get-Process -Id ${absentPid} `)) ? "null" : "[]";
    if (file === "where.exe") return "herdr";
    assert.equal(file, "herdr");
    if (args[0] === "tab" && args[1] === "create") {
      const pane_id = `synthetic-${++counts.panes}`;
      onPaneCreated?.();
      return JSON.stringify({ result: { root_pane: { pane_id } } });
    }
    if (args[0] === "pane" && args[1] === "run") counts.sends++;
    return "";
  });
  syncBuiltinESMExports();
  return { counts, restore() {
    audit.mock.restore(); which.mock.restore(); command.mock.restore(); syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  } };
}

function savedSession(dir: string, name: string, planTask?: PlanTaskBinding): string {
  const sessionFile = canonicalSessionPath(join(dir, `${name}.jsonl`));
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: name, cwd: dir }) + "\n");
  const profile = resolveLaunchProfile({ params: { id: name, name }, effectiveCwd: dir, subagentSessionFile: sessionFile,
    runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
    effectiveAutoExit: false, effectiveInteractive: true, taskDelivery: "artifact", denySet: new Set(), localAgentDir: dir } as any, "pi", "read");
  persistLaunchProfile({ ...profile, ...(planTask ? { planTask } : {}) });
  return sessionFile;
}

function fixture(nested = false) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-recovery-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Synthetic parent", timestamp: 1 });
  const token = randomUUID();
  const checkpoint = sm.appendCustomEntry("subagent-custody", { branchToken: token });
  const parent = { sessionFile: canonicalSessionPath(sm.getSessionFile()!), headerId: sm.getSessionId(), branchToken: token, checkpoint };
  const directory = join(dir, "artifacts", parent.headerId, "subagent-runtime");
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any[]>();
  const messages: unknown[] = [], messageOptions: unknown[] = [], notices: string[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    on(name: string, handler: any) { events.set(name, [...events.get(name) ?? [], handler]); },
    appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
    registerMessageRenderer() {}, registerShortcut() {}, getAllTools: () => [], getThinkingLevel: () => "off", sendMessage(message: unknown, options: unknown) {
      messages.push(message); messageOptions.push(options);
    },
  };
  const model = { provider: "test", id: "model" };
  const ctx: any = { sessionManager: sm, cwd: dir, hasUI: true, scopedModels: [], model,
    modelRegistry: { getAll: () => [], find: () => model, hasConfiguredAuth: () => true }, ui: {
      notify: (message: string) => notices.push(message), setWidget() {}, setStatus() {},
    } };
  if (nested) {
    process.env.PI_SUBAGENT_ID = "nested-coordinator";
    process.env.PI_SUBAGENT_SESSION = "ancestor-launch-marker";
  }
  try { extension(pi); } finally {
    if (nested) { delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION; }
  }
  const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
  const plans = runtime.plans;
  const emit = async (name: string, event: object, eventCtx = ctx) => { for (const handler of events.get(name) ?? []) await handler(event, eventCtx); };
  const endTurn = () => emit("turn_end", { context: { contextMessages: [] }, entries: [] });
  const execute = (name: string, args: unknown = {}, callCtx = ctx) => tools.get(name).execute("call", args, undefined, undefined, callCtx);
  const reconcileCommand = async (callCtx = ctx) => { await commands.get("subagents-reconcile").handler("", callCtx); return notices.at(-1)!; };
  const current = () => plans.read(sm).snapshot;
  if (!nested) {
    let plan = plans.create(sm, 0, "Synthetic plan");
    plan = plans.mutate(sm, plan.planId, plan.revision, (p: any, c: any) => addTask(p, c, "Synthetic task"));
    plans.mutate(sm, plan.planId, plan.revision, (p: any, c: any) => startAttempt(p, c, p.tasks[0].taskId));
  }
  const attach = (id: string) => {
    const p = current();
    return bindPlanRun(plans, ctx, id, { planId: p.planId, taskId: p.tasks[0].taskId, attemptId: p.tasks[0].attempts[0].attemptId, expectedRevision: p.revision });
  };
  const run = (id: string, binding = attach(id)) => ({ id, planTask: binding, sessionFile: canonicalSessionPath(join(dir, "child.jsonl")), name: "Worker", task: "Do not copy prompt", startTime: 1 });
  const reload = async () => {
    await emit("session_shutdown", { reason: "reload" });
    tools.clear(); commands.clear(); events.clear();
    const { default: freshExtension } = await import(new URL("../pi-extension/subagents/index.ts?dispatch-recovery-reload", import.meta.url).href);
    freshExtension({ ...pi });
    await emit("session_start", { reason: "reload" });
  };
  return { dir, directory, sm, parent, runtime, plans, ctx, tools, commands, messages, messageOptions, notices, emit, endTurn, execute, reconcileCommand, current, attach, run, reload,
    async clean(...ids: string[]) {
      await emit("session_shutdown", { reason: "quit" });
      for (const [path, owner] of sessionOwners) if (ids.includes(owner.runId)) releaseSession(path, owner.runId);
      rmSync(dir, { force: true, recursive: true });
    } };
}

for (const supervisor of [false, true]) test(`metadata repair imports an exact unsent failure once (supervisor=${supervisor})`, async () => {
  const f = fixture();
  const id = randomUUID();
  try {
    if (supervisor) {
      new RuntimeStore(f.directory, f.parent).close();
      await f.emit("session_start", { reason: "startup" });
      assert.ok(f.runtime.stopRecovery);
    } else {
      await f.emit("session_start", { reason: "startup" });
      f.runtime.store = new RuntimeStore(f.directory, f.parent);
      f.runtime.delivery.store = f.runtime.store;
      assert.equal(f.runtime.stopRecovery, undefined);
    }
    const active: RuntimeStore = f.runtime.store;
    const run = f.run(id);
    const memory: Map<string, DispatchEvidence> = f.runtime.dispatchEvidence ??= new Map();
    const { retained } = captureDispatchEvidence(memory, active, { runId: id, sessionFile: run.sessionFile, startedAt: 1, binding: run.planTask, dispatched: false }, errno("EPERM"), errno("EPERM"));
    assert.equal(retained, "file");
    assert.doesNotMatch(readFileSync(join(f.directory, "dispatch-evidence", `${id}.json`), "utf8"), /Do not copy prompt/);
    const persist = active.recordDispatchFailure.bind(active);
    active.recordDispatchFailure = () => { throw errno("EPERM"); };
    assert.match((await f.execute("subagents_reconcile")).content[0].text, new RegExp(`${id}: still-blocked \\(EPERM\\)`));
    assert.equal(f.current().tasks[0].attempts[0].results.length, 0);
    assert.equal(active.getRun(id), undefined);
    assert.match((await f.execute("subagents_recovery", { runId: id })).content[0].text, /before-send/);
    active.recordDispatchFailure = persist;
    assert.match(await f.reconcileCommand(), new RegExp(`${id}: resolved`));
    const revision = active.snapshot().revision;
    assert.match((await f.execute("subagents_reconcile")).content[0].text, new RegExp(`${id}: resolved`));
    assert.equal(active.snapshot().revision, revision);
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    assert.equal(f.current().tasks[0].status, "failed");
    assert.equal(memory.has(id), false);
    assert.equal(sessionOwners.has(run.sessionFile), false, "known unsent failure cannot reserve a writer");
    assert.deepEqual(f.messages, []);
    active.prepare({ ...run, id: randomUUID(), planTask: undefined });
  } finally { await f.clean(id); }
});

for (const surface of ["tool", "command"]) test(`untracked supervision failure blocks ${surface} reconciliation with a distinct Pi context`, async () => {
  const f = fixture(), id = randomUUID();
  try {
    new RuntimeStore(f.directory, f.parent).close();
    await f.emit("session_start", { reason: "startup" });
    const active: RuntimeStore = f.runtime.store;
    const supervisor = f.runtime.stopRecovery;
    active.prepare({ ...f.run(id), planTask: undefined });
    assert.equal(supervisor.tracks(id), false);
    const pending = `pending:${id}`;
    active.enqueue(pending, id, { message: { customType: "test", content: "Must not flush during failed recovery",
      details: { eventId: pending } }, options: { triggerTurn: true, deliverAs: "steer" } });
    const blocked = mock.method(active, "reconcileRun", () => { throw new Error("synthetic supervision restoration failure"); });
    try {
      const callCtx = { ...f.ctx };
      assert.notEqual(callCtx, f.runtime.latestCtx);
      assert.equal(callCtx.sessionManager, f.runtime.latestCtx.sessionManager);
      if (surface === "tool") {
        const result = await f.execute("subagents_reconcile", {}, callCtx);
        assert.equal(result.details.status, "still-blocked");
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /synthetic supervision restoration failure/);
      } else {
        assert.match(await f.reconcileCommand(callCtx), /Reconciliation still-blocked[\s\S]*synthetic supervision restoration failure/);
      }
      assert.equal(blocked.mock.callCount(), 1);
      assert.match(f.runtime.recoveryError, /synthetic supervision restoration failure/);
      assert.equal(f.runtime.delivery.api, undefined);
      assert.equal(active.getEvent(pending)?.status, "pending");
      assert.deepEqual(f.messages, []);
    } finally { blocked.mock.restore(); }
    await f.execute("subagents_reconcile", {}, { ...f.ctx });
    assert.equal(active.getEvent(pending)?.status, "handedOff", "the pending event is real and flushes after successful recovery");
    assert.equal(f.messages.length, 1);
  } finally { await f.clean(id); }
});

test("command and tool share one supervisor restoration during a delayed child probe", async t => {
  const f = fixture(), id = randomUUID(), pid = 12345, birth = "1234567890";
  const platform = process.platform;
  const probes: Array<() => void> = [];
  let childProcessChecks = 0, trackedRecoveryTimers = 0;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
  const originalExec = childProcess.execFileSync;
  const processProbe = t.mock.method(childProcess, "execFileSync", (command: string, args: string[], options: any) => {
    if (command === "powershell.exe" && args.some(arg => arg.includes(`Get-Process -Id ${pid} `))) {
      childProcessChecks++;
      return JSON.stringify({ pid, birth });
    }
    return originalExec(command, args, options);
  });
  const delayed = t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
    if (ms === 50) { probes.push(fn); return undefined; }
    return originalTimeout(fn, ms);
  });
  t.mock.method(globalThis, "setInterval", (fn: () => void, ms: number) => {
    const timer = originalInterval(fn, ms);
    if (ms === 250) { trackedRecoveryTimers++; timers.add(timer); }
    return timer;
  });
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  syncBuiltinESMExports();
  const calls: Promise<unknown>[] = [];
  try {
    new RuntimeStore(f.directory, f.parent).close();
    await f.emit("session_start", { reason: "startup" });
    const active: RuntimeStore = f.runtime.store;
    const run = { id, sessionFile: canonicalSessionPath(join(f.dir, "child.jsonl")), name: "Worker", task: "Synthetic task", startTime: 1, cli: "pi" };
    const identityFile = runCompletionFile(run.sessionFile, id);
    writeFileSync(run.sessionFile, JSON.stringify({ type: "session", id: "child" }) + "\n");
    writeFileSync(`${identityFile}.identity.json`, JSON.stringify({ schema: 1, runId: id, sessionFile: run.sessionFile,
      headerId: "child", nonce: id, process: { pid, birth: `windows:${birth}` } }));
    active.prepare(run);
    active.phase(id, "dispatch-intent");

    const command = f.reconcileCommand({ ...f.ctx }); calls.push(command);
    assert.equal(probes.length, 1, "first restoration waits on the challenge response");
    const challenge = readFileSync(`${identityFile}.challenge.json`, "utf8");
    const tool = f.execute("subagents_reconcile", {}, { ...f.ctx }); calls.push(tool);
    assert.equal(probes.length, 1, "second interface joins instead of issuing a new challenge");
    assert.equal(readFileSync(`${identityFile}.challenge.json`, "utf8"), challenge);
    assert.equal(childProcessChecks, 1);
    writeFileSync(`${identityFile}.response.json`, challenge);
    probes.shift()!();
    assert.match(await command, /Reconciliation resolved/);
    assert.equal((await tool).details.status, "resolved");
    assert.equal(childProcessChecks, 2, "one initial and one post-response process check");
    assert.equal(trackedRecoveryTimers, 1);
    const installed = f.runtime.stopRecovery;
    assert.equal(installed.tracks(id), true);
    assert.equal(installed.status().state, "active");
    await f.emit("session_shutdown", { reason: "quit" });
    assert.equal(installed.status().state, "stopped");
  } finally {
    delayed.mock.restore();
    for (const probe of probes) probe();
    await Promise.allSettled(calls);
    for (const timer of timers) clearInterval(timer);
    processProbe.mock.restore();
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    syncBuiltinESMExports();
    await f.clean(id);
  }
});

for (const hasManifest of [true, false]) test(`plan-only startup incident can be reviewed and acknowledged (manifest=${hasManifest})`, async () => {
  const f = fixture(), id = randomUUID();
  try {
    if (hasManifest) new RuntimeStore(f.directory, f.parent).close();
    f.attach(id);
    const startup = async (reason: string) => {
      f.notices.length = 0;
      await f.emit("session_start", { reason });
      return f.notices.some(notice => notice.includes("Unresolved subagent dispatch incidents"));
    };
    assert.equal(await startup("startup"), true, "plan-only evidence must warn even with no recorded runs");
    assert.match((await f.execute("subagents_recovery")).content[0].text, new RegExp(`${id}: dispatch-unknown \\(NO_DURABLE_RUN\\)`));
    assert.deepEqual(f.runtime.store?.listRuns() ?? [], []);
    const ack = () => f.commands.get("subagents-recovery-ack").handler("", f.ctx);
    const revision = f.runtime.store?.snapshot().revision;
    await ack();
    assert.match(f.notices.at(-1)!, /Recovery notice acknowledged/);
    assert.equal(f.runtime.store?.snapshot().revision, revision, "acknowledgement is session-only");
    await f.emit("session_shutdown", { reason: "reload" });
    assert.equal(await startup("reload"), false, "the saved acknowledgement silences unchanged evidence");
    assert.match((await f.execute("subagents_recovery")).content[0].text, /NO_DURABLE_RUN/);
    f.attach(randomUUID());
    assert.equal(await startup("reload"), true, "new unresolved evidence invalidates the old acknowledgement");
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(id); }
});

for (const historical of [false, true]) test(`resume rejects a related ${historical ? "historical plan" : "plan-only ambiguity"} before any side effects, without a manifest`, async t => {
  const f = fixture(), id = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  const launched: string[] = [];
  try {
    const binding = f.attach(id);
    if (historical) {
      const selected = f.sm.getLeafId()!;
      f.attach(randomUUID()); // Extend the same authority's plan on the newer path.
      f.sm.branch(selected);
      assert.equal(f.plans.read(f.sm).detachRequired, "historical");
      assert.deepEqual(f.current().authority, binding.authority);
    }
    const related = savedSession(f.dir, "related", binding);
    const unbound = savedSession(f.dir, "unbound");
    const manifest = join(f.directory, "manifest.json");
    await f.emit("session_start", { reason: "startup" });
    if (!historical) {
      const report = await f.execute("subagents_recovery", { runId: id });
      assert.match(report.content[0].text, new RegExp(`${id}: dispatch-unknown \\(NO_DURABLE_RUN\\)`));
    }
    const plan = f.current(), entries = f.sm.getEntries(), leaf = f.sm.getLeafId();
    const selection = { planId: binding.planId, taskId: binding.taskId, attemptId: binding.attemptId, expectedRevision: plan.revision };
    for (const params of [{ sessionPath: related }, { sessionPath: related, planTask: selection }, { sessionPath: unbound, planTask: selection }]) {
      const profile = readFileSync(launchProfilePath(params.sessionPath));
      await assert.rejects(() => f.execute("subagent_resume", { ...params, message: "Do not resend" }), historical
        ? /Historical plan is read-only/ : new RegExp(`${id}: dispatch-unknown.*Do not retry`));
      assert.deepEqual(f.current(), plan, "a refused resume cannot attach a replacement run");
      assert.deepEqual(f.sm.getEntries(), entries, "no new plan or custody entries");
      assert.equal(f.sm.getLeafId(), leaf);
      assert.deepEqual(readFileSync(launchProfilePath(params.sessionPath)), profile);
      assert.equal(f.runtime.store, undefined);
      assert.equal(fs.existsSync(f.directory), false);
      assert.equal(fs.existsSync(manifest), false);
      assert.equal(sessionOwners.has(params.sessionPath), false);
      assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    }
    const unrelated = await f.execute("subagent_resume", { sessionPath: unbound, message: "Independent turn" });
    launched.push(unrelated.details.id);
    assert.equal(unrelated.details.status, "started");
    assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });
    assert.deepEqual(f.current(), plan);
    assert.equal(readRuntimeManifest(f.directory)?.runs[unrelated.details.id]?.planTask, undefined);
  } finally { try { await f.clean(...launched); } finally { terminal.restore(); } }
});

for (const supervisor of [false, true]) for (const journal of [false, true]) {
  test(`closed resume recovers a failed final image check (journal=${journal}, supervisor=${supervisor})`, async t => {
    const f = fixture();
    const terminal = mockResumeTerminal(t, f.dir);
    const launched: string[] = [];
    const sessionPath = savedSession(f.dir, "final-image-check");
    const independent = savedSession(f.dir, "independent-after-repair");
    const manifest = join(f.directory, "manifest.json");
    const profile = launchProfilePath(sessionPath);
    const original = readFileSync(profile);
    const rename = fs.renameSync;
    let obstructWrite = journal;
    let faultArmed = true;
    let intent: RuntimeManifest["runs"][string] | undefined;
    let refusedWrites = 0;
    const fault = t.mock.method(fs, "renameSync", (from: string, to: string) => {
      if (to !== manifest) return rename(from, to);
      const next: RuntimeManifest = JSON.parse(readFileSync(from, "utf8"));
      if (obstructWrite && intent && next.outbox[dispatchFailureEventId(intent.id)]) {
        refusedWrites++;
        throw Object.assign(errno("EIO"), { syscall: "rename" });
      }
      rename(from, to);
      const run = Object.values(next.runs).find(run => run.phase === "dispatch-intent" && run.sessionFile === sessionPath);
      if (faultArmed && run) {
        intent = run;
        faultArmed = false;
        // Change the exact image only after the intent was durably replaced.
        fs.appendFileSync(profile, " ");
      }
    });
    syncBuiltinESMExports();
    try {
      if (supervisor) new RuntimeStore(f.directory, f.parent).close();
      await f.emit("session_start", { reason: "startup" });
      const priorSupervisor = f.runtime.stopRecovery;
      assert.equal(!!priorSupervisor, supervisor);
      const resume = (path: string) => f.execute("subagent_resume", { sessionPath: path, message: "Explicit turn" });
      await assert.rejects(() => resume(sessionPath), /Queue provenance could not be verified/);
      assert.ok(intent, "the refused resume committed an intent");
      const { id, startTime } = intent;
      const eventId = dispatchFailureEventId(id);
      const active: RuntimeStore = f.runtime.store;
      assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });
      assert.equal(sessionOwners.has(sessionPath), false);
      writeFileSync(profile, original);

      const pending = join(f.directory, "dispatch-evidence", `${id}.json`);
      if (journal) {
        assert.deepEqual(readRuntimeManifest(f.directory)?.runs[id], intent);
        assert.equal(active.getEvent(eventId), undefined);
        const record: DispatchEvidence = JSON.parse(readFileSync(pending, "utf8"));
        assert.equal(record.runId, id);
        assert.equal(record.eventId, eventId);
        assert.equal(record.startedAt, startTime);
        assert.equal(record.sessionFile, sessionPath);
        assert.equal(record.phase, "before-send");
        assert.equal(record.operation, verifyResumeImages);
        assert.equal(refusedWrites, 1);
        // Exercise disk import, not a duplicate of the in-memory fallback.
        assert.equal(f.runtime.dispatchEvidence.delete(id), true);
        assert.equal((await f.execute("subagents_reconcile")).details.status, "still-blocked");
        assert.equal(refusedWrites, 2);
        assert.equal(f.runtime.stopRecovery, undefined);
        if (supervisor) assert.equal(priorSupervisor.status().state, "stopped");
        assert.equal(f.runtime.delivery.api, undefined);
        await assert.rejects(() => resume(independent), /Dispatch metadata write paused \(EIO\)/);
        assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });
        obstructWrite = false;
      } else {
        assert.equal(active.getEvent(eventId)?.status, "handedOff");
        assert.equal(fs.existsSync(pending), false);
      }
      const repaired = await f.execute("subagents_reconcile");
      assert.equal(repaired.details.status, "resolved");
      assert.deepEqual(repaired.details.incidents.map(({ runId, status, phase, evidence }: any) => ({ runId, status, phase, evidence })),
        [{ runId: id, status: "resolved", phase: "before-send", evidence: "outbox" }]);
      const committed = readRuntimeManifest(f.directory)!;
      assert.deepEqual(Object.keys(committed.runs), [id]);
      assert.deepEqual(Object.keys(committed.outbox), [eventId]);
      assert.deepEqual(committed.runs[id], { ...intent, eventCursor: [eventId], reconciliation: "Dispatch ended with failure/uncertainty; never automatically relaunch" });
      assert.equal(committed.outbox[eventId].runId, id);
      assert.equal(committed.outbox[eventId].status, "handedOff");
      assert.equal(fs.existsSync(pending), false);
      assert.equal(sessionOwners.has(sessionPath), false);
      if (journal) {
        assert.notEqual(f.runtime.stopRecovery, priorSupervisor, "only a clean explicit pass restores supervision after a write fault");
        assert.equal(f.runtime.stopRecovery?.status().state, "active");
      } else assert.equal(f.runtime.stopRecovery, priorSupervisor);
      assert.equal(f.runtime.stopRecovery?.tracks(id) ?? false, false, "never supervise the proven-unsent run");
      assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
      assert.deepEqual(readRuntimeManifest(f.directory), committed, "repeat reconciliation has no effects");
      assert.deepEqual(f.messages, []);
      assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });

      if (supervisor) {
        await f.emit("session_shutdown", { reason: "quit" });
        await f.emit("session_start", { reason: "startup" });
        assert.notEqual(f.runtime.store.generation, committed.generation);
        assert.equal(f.runtime.stopRecovery.tracks(id), false);
        assert.equal(sessionOwners.has(sessionPath), false);
        assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });
      }
      for (const path of [independent, sessionPath]) {
        const explicit = await resume(path);
        launched.push(explicit.details.id);
        assert.equal(explicit.details.status, "started");
        assert.notEqual(explicit.details.id, id);
        const fresh = readRuntimeManifest(f.directory)!;
        assert.equal(fresh.runs[explicit.details.id]?.phase, "supervised");
        assert.equal(fresh.runs[explicit.details.id]?.sessionFile, path);
        assert.deepEqual(fresh.runs[id], committed.runs[id]);
        assert.deepEqual(fresh.outbox[eventId], committed.outbox[eventId]);
        assert.deepEqual(terminal.counts, { panes: 1 + launched.length, sends: launched.length });
      }
      assert.equal(new Set([id, ...launched]).size, 3);
    } finally {
      try { await f.clean(...launched, ...(intent ? [intent.id] : [])); }
      finally { fault.mock.restore(); terminal.restore(); }
    }
  });
}

test("a tracked intent loses its artifact-only reservation only after exact before-send evidence is imported", async t => {
  const f = fixture(), id = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  try {
    const binding = f.attach(id);
    const sessionPath = savedSession(f.dir, "tracked-intent", binding);
    const run = { ...f.run(id, binding), sessionFile: sessionPath };
    const store = new RuntimeStore(f.directory, f.parent);
    store.prepare(run);
    store.commitFreshDispatch(id, sessionPath, binding);
    const { record, retained } = captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: sessionPath,
      startedAt: run.startTime, binding, operation: verifyResumeImages, dispatched: false }, errno("EIO"), errno("EIO"));
    assert.equal(retained, "file");
    const file = join(f.directory, "dispatch-evidence", `${id}.json`);
    for (const change of [{ startedAt: run.startTime + 1 }, { binding: undefined }, { sessionFile: sessionPath + ".other" }]) {
      writeFileSync(file, JSON.stringify({ ...record, ...change }));
      const before = store.snapshot();
      const repaired = reconcileDispatchEvidence(store, readDispatchEvidence(f.directory, before, new Map()), f.current(), new Map());
      assert.equal(repaired.storeError, undefined);
      assert.deepEqual(repaired.incidents.map(({ runId, code, attempts }) => ({ runId, code, attempts })),
        [{ runId: id, code: "EVIDENCE_CONFLICT", attempts: 0 }]);
      assert.deepEqual(store.snapshot(), before);
    }
    writeFileSync(file, JSON.stringify(record));
    store.close();
    const branch = f.sm.getLeafId()!;
    f.sm.branch(f.parent.checkpoint); // Writer custody survives, plan selection does not.
    await f.emit("session_start", { reason: "startup" });
    const active: RuntimeStore = f.runtime.store;
    const supervisor = f.runtime.stopRecovery;
    assert.equal(supervisor.tracks(id), true);
    assert.equal(sessionOwners.get(sessionPath)?.runId, id);
    assert.deepEqual(active.snapshot().retainedDispatchEvidence, { [id]: record });
    assert.equal(active.getEvent(record.eventId), undefined);

    f.sm.branch(branch);
    const repaired = await f.execute("subagents_reconcile");
    assert.equal(repaired.details.status, "resolved");
    assert.equal(repaired.details.incidents[0].runId, id);
    assert.equal(f.runtime.stopRecovery, supervisor);
    assert.equal(sessionOwners.has(sessionPath), false);
    assert.equal(active.getRun(id)?.phase, "dispatch-intent");
    assert.deepEqual(active.getRun(id)?.planTask, binding);
    assert.deepEqual(active.outboxIds(), [record.eventId]);
    assert.equal(active.getEvent(record.eventId)?.runId, id);
    assert.equal(active.getEvent(record.eventId)?.status, "handedOff");
    const saved = active.snapshot();
    const altered = structuredClone(saved);
    altered.runs[id].startTime++;
    const changed = dispatchIncidents(altered, f.current(), f.directory, readDispatchEvidence(f.directory, altered, new Map()));
    assert.equal(changed.find(item => item.runId === id)?.status, "still-blocked", "canonical proof cannot move to a different run identity");
    assert.equal(f.current().tasks[0].attempts[0].results[0]?.runId, id);
    assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
    assert.deepEqual(active.snapshot(), saved);
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    assert.deepEqual(f.messages, []);
  } finally { try { await f.clean(id); } finally { terminal.restore(); } }
});

function resumeIntentFailure(run: Parameters<typeof resumeIntentBinding>[0]) {
  const error = "Final image check failed";
  return { message: { customType: "subagent_result", content: error, details: {
    eventId: dispatchFailureEventId(run.id), error, beforeSendAfterIntent: resumeIntentBinding(run),
  } }, options: { triggerTurn: true, deliverAs: "steer" } as const };
}

test("canonical after-intent publication requires a nonempty failure string", async () => {
  const f = fixture(), id = randomUUID();
  const store = new RuntimeStore(f.directory, f.parent);
  try {
    const run = f.run(id);
    store.prepare(run);
    store.commitFreshDispatch(id, run.sessionFile, run.planTask);
    const before = store.snapshot(), plan = f.current();
    const manifest = join(f.directory, "manifest.json"), disk = readFileSync(manifest);
    const valid = resumeIntentFailure(run), empty = structuredClone(valid);
    empty.message.details.error = "";
    assert.throws(() => store.recordDispatchFailure(run, empty), /conflicts with before-send evidence/);
    assert.deepEqual(store.snapshot(), before, "refusal must not add the event or advance the revision");
    assert.deepEqual(readFileSync(manifest), disk);
    assert.deepEqual(f.current(), plan);

    store.recordDispatchFailure(run, valid);
    const eventId = valid.message.details.eventId;
    assert.deepEqual(store.getRun(id)?.eventCursor, [eventId]);
    assert.deepEqual(store.getEvent(eventId), { runId: id, envelope: valid, status: "handedOff" });
  } finally { store.close(); await f.clean(id); }
});

test("mixed canonical after-intent metadata is rejected at publication and remains blocked if already persisted", async t => {
  const f = fixture(), id = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  try {
    const sessionPath = savedSession(f.dir, "mixed-canonical");
    const run = { id, sessionFile: sessionPath, name: "Resume", task: "Explicit turn", startTime: 1, cli: "pi" };
    const initial = new RuntimeStore(f.directory, f.parent);
    initial.prepare(run);
    initial.commitFreshDispatch(id, sessionPath, undefined);
    const envelope = resumeIntentFailure(run);
    const dispatch = { source: dispatchFailureSource, recordedAt: 2, phase: "before-send", operation: verifyResumeImages,
      cause: "EIO", writeOperation: "rename", writeCode: "EIO" };
    const before = initial.snapshot();
    for (const changed of [{ phase: "send-possible" }, { operation: "send-to-terminal" }, { recordedAt: -1 }, { source: "foreign" }]) {
      const mixed = { ...envelope, message: { ...envelope.message, details: { ...envelope.message.details, dispatch: { ...dispatch, ...changed } } } };
      assert.throws(() => initial.recordDispatchFailure(run, mixed), /conflicts with before-send evidence/);
      assert.deepEqual(initial.snapshot(), before);
    }
    // Model a manifest written by the previous version, not the repaired API.
    initial.recordDispatchFailure(run, envelope);
    const persisted = initial.snapshot();
    const eventId = envelope.message.details.eventId;
    Object.assign(persisted.outbox[eventId].envelope.message.details as object,
      { dispatch: { ...dispatch, phase: "send-possible", operation: "send-to-terminal" } });
    initial.close();
    writeFileSync(join(f.directory, "manifest.json"), JSON.stringify(persisted));
    await f.emit("session_start", { reason: "startup" });
    const active: RuntimeStore = f.runtime.store;
    const supervisor = f.runtime.stopRecovery;
    const owner = sessionOwners.get(sessionPath);
    assert.equal(owner?.runId, id);
    assert.equal(supervisor.tracks(id), true);
    assert.equal(active.getEvent(eventId)?.status, "handedOff");
    assert.deepEqual(active.getEvent(eventId), persisted.outbox[eventId]);
    const reconciled = await f.execute("subagents_reconcile");
    assert.equal(reconciled.details.status, "still-blocked");
    assert.match(reconciled.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
    assert.doesNotMatch(reconciled.content[0].text, /Storage\/custody:/);
    assert.equal(sessionOwners.get(sessionPath), owner);
    assert.equal(active.getRun(id)?.phase, "dispatch-intent");
    await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: still-blocked`));
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    assert.deepEqual(f.messages, []);
  } finally { try { await f.clean(id); } finally { terminal.restore(); } }
});

for (const atStartup of [true, false]) test(`same-run possible-send journal keeps the artifact reservation (startup=${atStartup})`, async t => {
  const f = fixture(), id = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  const launched: string[] = [];
  try {
    const sessionPath = savedSession(f.dir, "side-conflict");
    const run = { id, sessionFile: sessionPath, name: "Resume", task: "Explicit turn", startTime: 1, cli: "pi" };
    const initial = new RuntimeStore(f.directory, f.parent);
    initial.prepare(run);
    initial.commitFreshDispatch(id, sessionPath, undefined);
    const envelope = resumeIntentFailure(run);
    const publishConflict = (store: RuntimeStore) => {
      store.recordDispatchFailure(run, envelope);
      const { retained } = captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: sessionPath,
        startedAt: run.startTime, dispatched: true, operation: "send-to-terminal" }, errno("EIO"), errno("EIO"));
      assert.equal(retained, "file");
    };
    if (atStartup) publishConflict(initial);
    initial.close();
    await f.emit("session_start", { reason: "startup" });
    const active: RuntimeStore = f.runtime.store;
    const supervisor = f.runtime.stopRecovery;
    const owner = sessionOwners.get(sessionPath)!;
    assert.equal(owner?.runId, id, "startup must supervise rather than skip the conflicted intent");
    assert.equal(owner.surface, undefined);
    assert.equal(supervisor.tracks(id), true);
    if (!atStartup) publishConflict(active);
    const result = await f.execute("subagents_reconcile");
    assert.equal(result.details.status, "still-blocked");
    assert.match(result.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
    assert.doesNotMatch(result.content[0].text, /Storage\/custody:/);
    assert.equal(f.runtime.stopRecovery, supervisor);
    assert.equal(sessionOwners.get(sessionPath), owner, "explicit verification cannot clear an equivocal reservation");
    assert.equal(active.getRun(id)?.phase, "dispatch-intent");
    const eventId = envelope.message.details.eventId;
    assert.deepEqual(active.getRun(id)?.eventCursor, [eventId]);
    assert.equal(active.getEvent(eventId)?.status, "handedOff");
    await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: still-blocked`));
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    const independent = savedSession(f.dir, "unrelated-while-conflicted");
    const fresh = await f.execute("subagent_resume", { sessionPath: independent });
    launched.push(fresh.details.id);
    assert.equal(fresh.details.status, "started", "a run-local conflict does not pause unrelated transport");
    assert.notEqual(fresh.details.id, id);
    assert.equal(active.getRun(fresh.details.id)?.sessionFile, independent);
    assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });

    rmSync(join(f.directory, "dispatch-evidence", `${id}.json`));
    for (const key of ["surface", "continuationRequestId", "closeRequestId"] as const) {
      owner[key] = "protected";
      assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
      assert.equal(sessionOwners.get(sessionPath), owner, `a clean proof must not clear ${key}`);
      delete owner[key];
    }
    const repaired = await f.execute("subagents_reconcile");
    assert.equal(repaired.details.status, "resolved");
    assert.match(repaired.content[0].text, new RegExp(`${id}: resolved`));
    assert.equal(sessionOwners.has(sessionPath), false);
    assert.deepEqual(active.getRun(id)?.eventCursor, [eventId]);
    assert.equal(active.getEvent(eventId)?.runId, id);
    assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });
    assert.deepEqual(f.messages, []);
  } finally { try { await f.clean(id, ...launched); } finally { terminal.restore(); } }
});

for (const { atStartup, memoryConflict, field } of [
  { atStartup: false, field: "startedAt" }, { atStartup: true, field: "startedAt" },
  { atStartup: false, field: "sessionFile" }, { atStartup: true, field: "sessionFile" },
  { atStartup: false, field: "startedAt", memoryConflict: true },
]) {
  test(`side-only journal conflict is run-local and survives custody rotation (${field}, startup=${atStartup}, memory=${!!memoryConflict})`, async t => {
    const f = fixture(), id = randomUUID();
    const terminal = mockResumeTerminal(t, f.dir);
    const launched: string[] = [];
    try {
      const binding = f.attach(id);
      const sessionPath = savedSession(f.dir, "side-only-intent", binding);
      const run = { ...f.run(id, binding), sessionFile: sessionPath, cli: "pi" };
      let store = new RuntimeStore(f.directory, f.parent);
      store.prepare(run);
      store.commitFreshDispatch(id, sessionPath, binding);
      if (!atStartup) {
        store.close();
        await f.emit("session_start", { reason: "startup" });
        store = f.runtime.store;
      }
      const memory = memoryConflict ? (f.runtime.dispatchEvidence ??= new Map()) : new Map<string, DispatchEvidence>();
      const generation = store.snapshot().generation;
      const { record, retained } = captureDispatchEvidence(memory, store, { runId: id, sessionFile: sessionPath,
        binding, startedAt: run.startTime, operation: verifyResumeImages, dispatched: false }, errno("EIO"), errno("EIO"));
      assert.equal(retained, "file");
      const path = join(f.directory, "dispatch-evidence", `${id}.json`);
      const independent = savedSession(f.dir, "side-only-independent");
      const mismatch = JSON.stringify({ ...record, ...(field === "sessionFile"
        ? { sessionFile: independent } : { startedAt: record.startedAt + 1 }) });
      writeFileSync(path, mismatch);
      const before = f.current();
      if (atStartup) {
        store.close();
        await f.emit("session_start", { reason: "startup" });
        assert.ok(f.runtime.store, "readable mismatch must not block startup writer acquisition");
        assert.notEqual(f.runtime.store.generation, generation);
      }
      assert.match((await f.execute("subagents_recovery", { runId: id })).content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
      const checkBlocked = async () => {
        const result = await f.execute("subagents_reconcile");
        const item = result.details.incidents.find((item: any) => item.runId === id);
        assert.equal(result.details.status, "still-blocked");
        assert.equal(item?.code, "EVIDENCE_CONFLICT");
        assert.doesNotMatch(result.content[0].text, /Storage\/custody:|Task import pending/);
        assert.equal(f.runtime.store.getEvent(record.eventId), undefined);
        assert.equal(sessionOwners.get(sessionPath)?.runId, id);
        assert.deepEqual(f.current(), before);
        assert.deepEqual(f.messages, []);
        assert.equal(readFileSync(path, "utf8"), mismatch);
        await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: still-blocked`));
        assert.deepEqual(terminal.counts, { panes: launched.length, sends: launched.length });
      };
      if (memoryConflict) {
        const failedPin = t.mock.method(store, "retainDispatchEvidence", () => { throw errno("ENOSPC"); });
        try {
          const result = await f.execute("subagents_reconcile");
          assert.match(result.content[0].text, /Storage\/custody:[\s\S]*Dispatch metadata write paused \(ENOSPC\)/);
          assert.equal(failedPin.mock.callCount(), 1);
          assert.equal(store.getEvent(record.eventId), undefined);
          assert.deepEqual(memory.get(id), record);
          assert.equal(readFileSync(path, "utf8"), mismatch);
        } finally { failedPin.mock.restore(); }
      }
      await checkBlocked();
      const current = f.runtime.store.snapshot();
      assert.deepEqual(current.retainedDispatchEvidence?.[id], memoryConflict ? record : undefined);
      await checkBlocked();
      assert.deepEqual(f.runtime.store.snapshot(), current, "metadata retries do not advance the manifest");
      assert.ok(!Object.values(current.runs).some(run => run.sessionFile === independent));
      assert.equal(sessionOwners.has(independent), false);
      const launch = await f.execute("subagent_resume", { sessionPath: independent });
      assert.equal(launch.details.status, "started");
      assert.notEqual(launch.details.id, id);
      launched.push(launch.details.id);
      assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });
      await checkBlocked();
      if (field === "sessionFile" && !atStartup) {
        const fresh = await f.execute("subagent", { name: "Independent fresh", task: "Synthetic work" });
        launched.push(fresh.details.id);
        assert.equal(fresh.details.status, "started");
        await checkBlocked();
      }

      const preRestart = f.runtime.store.snapshot();
      await f.emit("session_shutdown", { reason: "quit" });
      f.runtime.dispatchEvidence?.clear();
      await f.emit("session_start", { reason: "startup" });
      assert.notEqual(f.runtime.store.generation, preRestart.generation);
      await checkBlocked();
      // Fix the side file's identity. Only the exact original independently
      // retained in the manifest may be proof in the replacement generation.
      writeFileSync(path, JSON.stringify(record));
      const result = await f.execute("subagents_reconcile");
      if (memoryConflict) {
        assert.equal(f.runtime.store.getEvent(record.eventId)?.status, "handedOff");
        assert.equal(f.current().tasks[0].attempts[0].results[0]?.kind, "failure");
      } else {
        assert.match(result.content[0].text, new RegExp(`${id}: still-blocked \\(WRITER_GENERATION_CONFLICT\\)`));
        assert.equal(f.runtime.store.getEvent(record.eventId), undefined);
        assert.deepEqual(f.current(), before);
        assert.equal(readFileSync(path, "utf8"), JSON.stringify(record));
      }
      assert.deepEqual(f.messages, []);
      assert.deepEqual(terminal.counts, { panes: launched.length, sends: launched.length });
    } finally { try { await f.clean(id, ...launched); } finally { terminal.restore(); } }
  });
}

test("an ownerless after-intent journal still blocks the session it claims", async t => {
  const f = fixture(), id = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  try {
    const sessionPath = savedSession(f.dir, "ownerless-claim");
    const binding = f.attach(id);
    const store = new RuntimeStore(f.directory, f.parent);
    const { record, retained } = captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: sessionPath,
      binding, startedAt: 1, operation: verifyResumeImages, dispatched: false }, errno("EIO"), errno("EIO"));
    assert.equal(retained, "file");
    store.close();
    const before = f.current();
    await f.emit("session_start", { reason: "startup" });
    const result = await f.execute("subagents_reconcile");
    assert.match(result.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
    assert.doesNotMatch(result.content[0].text, /Storage\/custody:/);
    await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: still-blocked`));
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    assert.equal(f.runtime.store.getRun(id), undefined);
    assert.equal(f.runtime.store.getEvent(record.eventId), undefined);
    assert.deepEqual(f.current(), before);
    assert.deepEqual(f.messages, []);
  } finally { try { await f.clean(id); } finally { terminal.restore(); } }
});

for (const [status, branchAck] of [["pending", false], ["pending", true], ["dispatching", true]] as const) {
  test(`restart cannot notify or promote an import-only marker (${status}, branchAck=${branchAck})`, async t => {
    const f = fixture(), id = randomUUID(), canonicalId = randomUUID(), ordinaryId = randomUUID();
    const terminal = mockResumeTerminal(t, f.dir);
    const launched: string[] = [];
    try {
      const run = { id, sessionFile: savedSession(f.dir, "untrusted-handoff"), name: "Resume", task: "Explicit turn", startTime: 1, cli: "pi" };
      const canonical = { ...run, id: canonicalId, sessionFile: savedSession(f.dir, "canonical-handoff") };
      const ordinary = { ...run, id: ordinaryId, sessionFile: savedSession(f.dir, "ordinary-handoff") };
      const initial = new RuntimeStore(f.directory, f.parent);
      for (const item of [run, canonical, ordinary]) {
        initial.prepare(item);
        initial.commitFreshDispatch(item.id, item.sessionFile, undefined);
      }
      const envelope = resumeIntentFailure(run), eventId = envelope.message.details.eventId;
      const canonicalEnvelope = resumeIntentFailure(canonical), canonicalEventId = canonicalEnvelope.message.details.eventId;
      const ordinaryEventId = `subagent:${ordinaryId}:completion:normal`;
      const ordinaryMessage = { customType: "subagent_result", content: "Ordinary run finished", details: {
        eventId: ordinaryEventId, sessionFile: ordinary.sessionFile, exitCode: 0,
      } };
      const beforeEnqueue = initial.snapshot();
      assert.throws(() => initial.enqueue(eventId, id, envelope), /import-only/);
      assert.deepEqual(initial.snapshot(), beforeEnqueue);
      initial.recordDispatchFailure(canonical, canonicalEnvelope);
      initial.enqueue(ordinaryEventId, ordinaryId, { message: ordinaryMessage, options: envelope.options });
      if (branchAck) f.sm.appendCustomMessageEntry(envelope.message.customType, envelope.message.content, false, envelope.message.details);
      // Simulate old/corrupt storage without relying on the now-fenced APIs.
      const persisted = initial.snapshot();
      persisted.outbox[eventId] = { runId: id, envelope, status };
      persisted.runs[id].eventCursor.push(eventId);
      initial.close();
      writeFileSync(join(f.directory, "manifest.json"), JSON.stringify(persisted));

      await f.emit("session_start", { reason: "startup" });
      const active: RuntimeStore = f.runtime.store;
      const owner = sessionOwners.get(run.sessionFile);
      assert.equal(owner?.runId, id);
      assert.equal(f.runtime.stopRecovery.tracks(id), true);
      assert.equal(sessionOwners.has(canonical.sessionFile), false);
      assert.equal(f.runtime.stopRecovery.tracks(canonicalId), false);
      assert.equal(f.runtime.delivery.pending.has(eventId), false);
      assert.equal(f.runtime.delivery.handedOff.has(eventId), false);
      assert.deepEqual(active.getEvent(eventId), persisted.outbox[eventId]);
      assert.equal(active.getEvent(canonicalEventId)?.status, "handedOff");
      assert.equal(active.getEvent(ordinaryEventId)?.status, "handedOff");
      assert.deepEqual(f.messages, [ordinaryMessage], "only the ordinary event may notify/wake the parent");
      assert.deepEqual(f.messageOptions, [{ triggerTurn: true, deliverAs: "steer" }]);
      assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
      const unchanged = active.snapshot();
      for (const next of ["pending", "dispatching", "handedOff"] as const) assert.throws(() => active.delivery(eventId, next), /import-only/);
      assert.throws(() => active.recordDispatchFailure(run, envelope), /conflicts with before-send evidence/);
      for (let n = 0; n < 2; n++) {
        const result = await f.execute("subagents_reconcile");
        assert.equal(result.details.status, "still-blocked");
        assert.match(result.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
        assert.match(result.content[0].text, new RegExp(`${canonicalId}: resolved`));
        assert.doesNotMatch(result.content[0].text, /Storage\/custody:/);
        assert.equal(sessionOwners.get(run.sessionFile), owner);
        assert.deepEqual(active.snapshot(), unchanged);
        await assert.rejects(() => f.execute("subagent_resume", { sessionPath: run.sessionFile }), new RegExp(`${id}: still-blocked`));
        assert.deepEqual(f.messages, [ordinaryMessage], "no extra notification or model wake");
        assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
      }
      const fresh = await f.execute("subagent_resume", { sessionPath: canonical.sessionFile });
      launched.push(fresh.details.id);
      assert.equal(fresh.details.status, "started");
      assert.notEqual(fresh.details.id, canonicalId);
      assert.equal(active.getRun(fresh.details.id)?.sessionFile, canonical.sessionFile);
      assert.equal(active.getRun(fresh.details.id)?.phase, "supervised");
      assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });
      assert.equal(sessionOwners.get(run.sessionFile), owner);
      assert.equal(active.getEvent(eventId)?.status, status);
      assert.deepEqual(f.messages, [ordinaryMessage]);
    } finally { try { await f.clean(id, canonicalId, ordinaryId, ...launched); } finally { terminal.restore(); } }
  });
}

for (const scenario of ["pending", "dispatching", "mixed-handedOff", "empty-error-handedOff", "side-conflict"] as const) {
  test(`plan-bound ${scenario} after-intent evidence is deferred on restart and retries`, async t => {
    const f = fixture(), id = randomUUID();
    const terminal = mockResumeTerminal(t, f.dir);
    try {
      const binding = f.attach(id);
      const sessionFile = savedSession(f.dir, `bound-${scenario}`, binding);
      const run = { ...f.run(id, binding), sessionFile, cli: "pi" };
      const initial = new RuntimeStore(f.directory, f.parent);
      initial.prepare(run);
      initial.commitFreshDispatch(id, sessionFile, binding);
      const envelope = resumeIntentFailure(run), eventId = envelope.message.details.eventId;
      const file = join(f.directory, "dispatch-evidence", `${id}.json`);
      let side: DispatchEvidence | undefined;
      if (scenario === "side-conflict") {
        initial.recordDispatchFailure(run, envelope);
        const evidence = captureDispatchEvidence(new Map(), initial, { runId: id, sessionFile, startedAt: run.startTime, binding,
          dispatched: true, operation: "send-to-terminal" }, errno("EIO"), errno("EIO"));
        assert.equal(evidence.retained, "file");
        side = evidence.record;
      }
      const persisted = initial.snapshot();
      initial.close();
      if (scenario !== "side-conflict") {
        if (scenario === "mixed-handedOff") Object.assign(envelope.message.details, { dispatch: {
          source: dispatchFailureSource, phase: "send-possible", operation: "send-to-terminal",
          recordedAt: 2, cause: "EIO", writeOperation: "rename", writeCode: "EIO",
        } });
        // Keep the exact binding and cursor; only the failure string is invalid.
        if (scenario === "empty-error-handedOff") envelope.message.details.error = "";
        const status = scenario === "pending" || scenario === "dispatching" ? scenario : "handedOff";
        persisted.runs[id].eventCursor.push(eventId);
        persisted.outbox[eventId] = { runId: id, envelope, status };
        writeFileSync(join(f.directory, "manifest.json"), JSON.stringify(persisted));
      }
      const before = f.current();
      assert.equal(before.tasks[0].status, "in_progress");
      assert.deepEqual(before.tasks[0].attempts[0].results, []);
      await f.emit("session_start", { reason: "startup" });
      const active: RuntimeStore = f.runtime.store;
      assert.deepEqual(f.current(), before, "startup must not mutate the attempt or its revision");
      const owner = sessionOwners.get(sessionFile);
      assert.equal(owner?.runId, id);
      assert.equal(f.runtime.stopRecovery.tracks(id), true);
      assert.equal(importPlanEnvelope(f.plans, f.ctx, binding, id, envelope), false, "direct marked import needs proof context");
      assert.equal(importPlanEnvelope(f.plans, f.ctx, binding, id, envelope, { store: active, memory: new Map() }), false);
      f.runtime.delivery.onEnvelope(id, envelope);
      await f.endTurn();
      const blocked = await f.execute("subagents_reconcile");
      assert.equal(blocked.details.status, "still-blocked");
      assert.match(blocked.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
      assert.doesNotMatch(blocked.content[0].text, /Storage\/custody:|Task import pending/);
      assert.equal(f.runtime.planImportErrors.has(eventId), false);
      assert.equal(f.runtime.planImportErrors.has(id), false);
      assert.deepEqual(f.current(), before, "callback, turn and explicit projection must also defer");
      assert.equal(sessionOwners.get(sessionFile), owner);
      assert.deepEqual(active.getEvent(eventId), persisted.outbox[eventId]);
      if (scenario === "empty-error-handedOff") {
        const manifest = active.snapshot();
        assert.match(await f.reconcileCommand(), new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
        assert.deepEqual(active.snapshot(), manifest);
        assert.deepEqual(f.current(), before);
      }
      await assert.rejects(() => f.execute("subagent_resume", { sessionPath: sessionFile }), new RegExp(`${id}: still-blocked`));
      assert.deepEqual(f.messages, []);
      assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });

      if (side) {
        // Disk repair alone cannot hide a contradictory in-process record.
        const memory: Map<string, DispatchEvidence> = f.runtime.dispatchEvidence;
        memory.set(id, side);
        rmSync(file);
        await f.endTurn();
        assert.equal((await f.execute("subagents_reconcile")).details.status, "still-blocked");
        assert.deepEqual(f.current(), before);
        assert.equal(sessionOwners.get(sessionFile), owner);
        memory.delete(id);
        const repair = await f.execute("subagents_reconcile");
        assert.equal(repair.details.status, "resolved");
        const savedPlan = f.current();
        assert.equal(savedPlan.revision, before.revision + 1);
        assert.equal(savedPlan.tasks[0].status, "failed");
        const [result] = savedPlan.tasks[0].attempts[0].results;
        assert.deepEqual({ runId: result.runId, eventId: result.eventId, kind: result.kind }, { runId: id, eventId, kind: "failure" });
        assert.equal(savedPlan.tasks[0].attempts[0].results.length, 1);
        assert.equal(sessionOwners.has(sessionFile), false);
        await f.endTurn();
        assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
        assert.deepEqual(f.current(), savedPlan, "verified deferred import is idempotent");
        assert.deepEqual(f.messages, []);
        assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
      }
    } finally { try { await f.clean(id); } finally { terminal.restore(); } }
  });
}

for (const withSibling of [false, true]) {
  test(`completion-shaped marker quarantines its entire cursor on restart (sibling=${withSibling})`, async t => {
    const f = fixture(), id = randomUUID();
    const pid = 2147483647;
    const terminal = mockResumeTerminal(t, f.dir, pid);
    try {
      const binding = f.attach(id), name = "invalid-completion-marker";
      const sessionPath = savedSession(f.dir, name, binding);
      const run = { ...f.run(id, binding), sessionFile: sessionPath, cli: "pi" };
      const initial = new RuntimeStore(f.directory, f.parent);
      initial.prepare(run);
      initial.commitFreshDispatch(id, sessionPath, binding);
      const saved = initial.snapshot();
      initial.close();
      const eventId = `subagent:${id}:completion:marker`;
      const ordinaryId = `subagent:${id}:completion:sibling`;
      const ordinaryEnvelope = { message: { customType: "subagent_result", content: "Ordinary-shaped sibling",
        details: { eventId: ordinaryId, sessionFile: sessionPath, exitCode: 0 } }, options: { triggerTurn: true, deliverAs: "steer" } as const };
      const envelope = resumeIntentFailure(run);
      Object.assign(envelope.message.details, { eventId, sessionFile: sessionPath, exitCode: 0 });
      saved.runs[id].eventCursor.push(eventId);
      saved.outbox[eventId] = { runId: id, envelope, status: "handedOff" };
      if (withSibling) {
        saved.runs[id].eventCursor.push(ordinaryId);
        saved.outbox[ordinaryId] = { runId: id, envelope: ordinaryEnvelope, status: "pending" };
      }
      writeFileSync(join(f.directory, "manifest.json"), JSON.stringify(saved));
      writeFileSync(`${runCompletionFile(sessionPath, id)}.identity.json`, JSON.stringify({ schema: 1, runId: id, sessionFile: sessionPath,
        headerId: name, nonce: id, process: { pid, birth: "synthetic-absent" } }));
      assert.equal(readChildIdentity(sessionPath, id)?.process.pid, pid);
      assert.deepEqual(probeProcess(pid), { kind: "absent" });
      assert.doesNotThrow(() => assertSessionWriters(auditSession(sessionPath)));

      const before = f.current();
      await f.emit("session_start", { reason: "startup" });
      const active: RuntimeStore = f.runtime.store;
      const owner = sessionOwners.get(sessionPath);
      assert.equal(owner?.runId, id);
      assert.equal(f.runtime.stopRecovery.tracks(id), true);
      assert.deepEqual(active.getRun(id), saved.runs[id], "no liveness attestation of a quarantined cursor");
      const projection = { store: active, memory: new Map() };
      assert.equal(importPlanEnvelope(f.plans, f.ctx, binding, id, envelope, projection), false);
      if (withSibling) {
        assert.equal(importPlanEnvelope(f.plans, f.ctx, binding, id, ordinaryEnvelope, projection), false);
        assert.throws(() => active.delivery(ordinaryId, "handedOff"), /Conflicting after-intent event cursor/);
      }
      f.runtime.delivery.onEnvelope(id, { ...envelope, message: { ...envelope.message, details: { eventId, sessionFile: sessionPath, exitCode: 0 } } });
      await f.endTurn();
      for (let retry = 0; retry < 2; retry++) {
        const result = await f.execute("subagents_reconcile");
        assert.equal(result.details.status, "still-blocked");
        assert.match(result.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
        assert.doesNotMatch(result.content[0].text, /Storage\/custody:|Task import pending/);
        await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: still-blocked`));
        assert.equal(sessionOwners.get(sessionPath), owner);
        assert.deepEqual(active.snapshot().outbox, saved.outbox);
        assert.deepEqual(f.current(), before);
        assert.deepEqual(f.messages, []);
        assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
      }
    } finally { try { await f.clean(id); } finally { terminal.restore(); } }
  });
}

for (const conflict of [false, true]) test(`immediate marked failure uses the same plan import gate (conflict=${conflict})`, async () => {
  const f = fixture(), id = randomUUID();
  try {
    await f.emit("session_start", { reason: "startup" });
    const store = new RuntimeStore(f.directory, f.parent);
    f.runtime.store = store;
    f.runtime.delivery.store = store;
    const run = f.run(id);
    store.prepare(run);
    store.commitFreshDispatch(id, run.sessionFile, run.planTask);
    const memory = new Map<string, DispatchEvidence>();
    if (conflict) captureDispatchEvidence(memory, store, { runId: id, sessionFile: run.sessionFile, startedAt: run.startTime,
      binding: run.planTask, dispatched: true, operation: "send-to-terminal" }, errno("EIO"), errno("EIO"));
    const before = f.current();
    recordDispatchFailure(f.plans, f.ctx, run.planTask, id, new Error("Final image check failed"), store, run,
      false, resumeIntentBinding(run), { memory });
    const canonical = store.getEvent(dispatchFailureEventId(id))!;
    assert.equal(canonical.status, "handedOff");
    assert.equal(canonical.runId, id);
    if (conflict) assert.deepEqual(f.current(), before);
    else {
      assert.equal(f.current().revision, before.revision + 1);
      assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
      assert.equal(f.current().tasks[0].attempts[0].results[0].runId, id);
      assert.equal(f.current().tasks[0].status, "failed");
    }
    const projected = f.current();
    await f.endTurn();
    assert.deepEqual(f.current(), projected);
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(id); }
});

test("ordinary bound pending results still project independently of notification handoff", async () => {
  const f = fixture(), id = randomUUID();
  try {
    await f.emit("session_start", { reason: "startup" });
    const run = f.run(id);
    const store = new RuntimeStore(f.directory, f.parent);
    f.runtime.store = store;
    f.runtime.delivery.store = store;
    store.prepare(run);
    store.commitFreshDispatch(id, run.sessionFile, run.planTask);
    const eventId = `subagent:${id}:completion:ordinary`;
    store.enqueue(eventId, id, { message: { customType: "subagent_result", content: "Completed", details: { eventId, exitCode: 0 } },
      options: { triggerTurn: true, deliverAs: "steer" } });
    const before = f.current();
    await f.endTurn();
    assert.equal(store.getEvent(eventId)?.status, "pending");
    const imported = f.current();
    assert.equal(imported.revision, before.revision + 1);
    assert.equal(imported.tasks[0].status, "in_review");
    assert.equal(imported.tasks[0].attempts[0].results[0]?.eventId, eventId);
    await f.endTurn();
    assert.deepEqual(f.current(), imported);
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(id); }
});

test("memory-only launch evidence crosses /reload and imports once without dispatch", async t => {
  const f = fixture();
  const terminal = mockResumeTerminal(t, f.dir);
  const manifest = join(f.directory, "manifest.json"), journal = join(f.directory, "dispatch-evidence");
  const rename = fs.renameSync, link = fs.linkSync;
  const failed: Array<{ kind: "prepare" | "outbox"; runId: string }> = [];
  const publish: string[] = [];
  let unavailable = true;
  // Fail the actual prepared and failure-event manifest commits and the journal
  // publication. Do not manufacture memory by inserting a record in the map.
  const renameFault = t.mock.method(fs, "renameSync", (from: string, to: string) => {
    if (unavailable && to === manifest && fs.existsSync(to)) {
      const candidate: RuntimeManifest = JSON.parse(readFileSync(from, "utf8"));
      const prior = readRuntimeManifest(f.directory)!;
      const outbox = Object.entries(candidate.outbox).find(([id]) => !prior.outbox[id])?.[1];
      const prepared = Object.values(candidate.runs).find(run => !prior.runs[run.id]);
      if (outbox || prepared) {
        failed.push(outbox ? { kind: "outbox", runId: outbox.runId } : { kind: "prepare", runId: prepared!.id });
        throw Object.assign(errno("EIO"), { syscall: "rename" });
      }
    }
    rename(from, to);
  });
  const linkFault = t.mock.method(fs, "linkSync", (from: string, to: string) => {
    if (unavailable && dirname(to) === journal) {
      publish.push(to);
      throw errno("EIO");
    }
    link(from, to);
  });
  syncBuiltinESMExports();
  try {
    await f.emit("session_start", { reason: "startup" });
    const plan = f.current();
    const binding = { planId: plan.planId, authority: plan.authority, taskId: plan.tasks[0].taskId, attemptId: plan.tasks[0].attempts[0].attemptId };
    const path = savedSession(f.dir, "memory-only", binding);
    await assert.rejects(() => f.execute("subagent_resume", { sessionPath: path, message: "Synthetic attempt" }), /failure evidence memory-only \(EIO\)/);
    const [runId] = f.current().tasks[0].attempts[0].runIds;
    const store: RuntimeStore = f.runtime.store;
    const memory: Map<string, DispatchEvidence> = f.runtime.dispatchEvidence;
    const record = memory.get(runId)!;
    assert.deepEqual(failed, [{ kind: "prepare", runId }, { kind: "outbox", runId }]);
    assert.deepEqual(publish, [join(journal, `${runId}.json`)]);
    assert.deepEqual(fs.readdirSync(journal), []);
    assert.equal(record.phase, "before-send");
    assert.equal(record.operation, "persist-prepared");
    assert.deepEqual(record.binding, binding);
    assert.deepEqual(readRuntimeManifest(f.directory)?.runs, {});
    assert.deepEqual(readRuntimeManifest(f.directory)?.outbox, {});
    assert.equal(f.current().tasks[0].attempts[0].results.length, 0);

    await f.reload();
    assert.equal(f.runtime.store, store, "reload preserves the actual writer, unlike a fresh process");
    assert.equal(f.runtime.dispatchEvidence, memory);
    assert.equal(memory.get(runId), record, "exact memory-only evidence survives the lifecycle");
    const report = await f.execute("subagents_recovery", { runId });
    assert.match(report.content[0].text, /still-blocked \(EIO\).*before-send.*memory-only/);
    assert.deepEqual(failed.at(-1), { kind: "outbox", runId }, "reloaded startup attempts metadata repair, not prepare");
    assert.equal(failed.length, 3);
    assert.deepEqual(readRuntimeManifest(f.directory)?.outbox, {});
    assert.equal(f.current().tasks[0].attempts[0].results.length, 0);
    assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });

    unavailable = false;
    const reconcile = () => f.execute("subagents_reconcile");
    assert.equal((await reconcile()).details.status, "resolved");
    const repaired = readRuntimeManifest(f.directory)!;
    const imported = f.current();
    assert.deepEqual(Object.keys(repaired.outbox), [record.eventId]);
    assert.equal(repaired.outbox[record.eventId].status, "handedOff");
    assert.deepEqual(repaired.runs[runId].eventCursor, [record.eventId]);
    assert.deepEqual(repaired.runs[runId].planTask, binding);
    assert.deepEqual(imported.tasks[0].attempts[0].results.map((result: { eventId: string }) => result.eventId), [record.eventId]);
    assert.equal(imported.tasks[0].status, "failed");
    assert.equal(memory.has(runId), false);
    assert.equal(sessionOwners.has(path), false);
    assert.equal((await reconcile()).details.status, "resolved");
    assert.deepEqual(f.current(), imported);
    assert.deepEqual(readRuntimeManifest(f.directory), repaired);
    assert.deepEqual(terminal.counts, { panes: 1, sends: 0 }, "reload and repair neither open a pane nor send a terminal command");
    assert.deepEqual(f.messages, []);
  } finally {
    renameFault.mock.restore(); linkFault.mock.restore(); syncBuiltinESMExports();
    try { await f.clean(); } finally { terminal.restore(); }
  }
});

test("late supervision failure is reported to the old tool without mutating the new branch", async () => {
  const f = fixture(), id = randomUUID();
  try {
    new RuntimeStore(f.directory, f.parent).close();
    await f.emit("session_start", { reason: "startup" });
    const active: RuntimeStore = f.runtime.store;
    active.prepare(f.run(id));
    const blocked = mock.method(active, "reconcileRun", () => { throw new Error("old branch restoration failure"); });
    try {
      const recovering = f.execute("subagents_reconcile", {}, { ...f.ctx });
      assert.equal(blocked.mock.callCount(), 1);
      const treeCtx = { ...f.ctx };
      // Switch in the gap between the rejected supervisor promise and its
      // awaiting continuation, with the same SessionManager but a new lineage.
      f.sm.branch(f.sm.getEntry(f.parent.checkpoint)!.parentId!);
      const noticeCount = f.notices.length;
      const navigation = f.emit("session_tree", {}, treeCtx);
      const result = await recovering;
      await navigation;
      assert.equal(result.details.status, "still-blocked");
      assert.match(result.content[0].text, /old branch restoration failure/);
      assert.equal(f.runtime.latestCtx, treeCtx);
      assert.match(f.runtime.recoveryError, /changed active lineage/);
      assert.deepEqual(f.notices.slice(noticeCount), []);
      assert.equal(f.runtime.store, undefined);
      assert.equal(f.runtime.stopRecovery, undefined);
      assert.equal(f.runtime.delivery.api, undefined);
      assert.deepEqual(f.messages, []);
    } finally { blocked.mock.restore(); }
  } finally { await f.clean(id); }
});

test("legacy plan run without manifest evidence stays dispatch-unknown after successful writes and both interfaces", async () => {
  const f = fixture();
  const prior = randomUUID(), missing = randomUUID(), secondMissing = randomUUID();
  try {
    const store = new RuntimeStore(f.directory, f.parent);
    store.prepare(f.run(prior));
    store.phase(prior, "supervised");
    store.reconcileRun(prior, "exited: decision required before another writer");
    f.attach(missing);
    f.attach(secondMissing);
    store.close();
    await f.emit("session_start", { reason: "startup" });
    f.runtime.store.reconcileRun(prior, "exited: another manifest write succeeded");
    const legacyError = "Dispatch failed/uncertain; task import pending: Error: Failure evidence NOT persisted; explicit reconciliation required: Error: EPERM: operation not permitted, rename manifest.tmp";
    f.runtime.planImportErrors.set(missing, legacyError);
    f.runtime.planImportErrors.set(secondMissing, legacyError);
    const result = await f.execute("subagents_reconcile");
    const text = `${missing}: dispatch-unknown (NO_DURABLE_RUN)`;
    assert.equal(result.details.status, "dispatch-unknown");
    assert.ok(result.content[0].text.includes(text));
    assert.match(result.content[0].text, new RegExp(`${secondMissing}: dispatch-unknown`));
    assert.match(result.content[0].text, /Historical dispatch diagnostic.*not a current storage check.*EPERM/);
    assert.match(await f.reconcileCommand(), /Reconciliation dispatch-unknown/);
    const report = await f.execute("subagents_recovery");
    assert.ok(report.content[0].text.includes(text));
    assert.ok(report.content[0].text.includes(prior));
    assert.match(report.content[0].text, /Do not retry the resume/);
    assert.match(report.content[0].text, /Historical dispatch diagnostic/);
    f.runtime.planImportErrors.set(missing, "Dispatch task import pending (IMPORT_REFUSED)");
    const blocked = await f.execute("subagents_reconcile");
    assert.equal(blocked.details.status, "still-blocked", "do not demote a current diagnostic based just on run ID");
    assert.match(blocked.content[0].text, /IMPORT_REFUSED/);
    assert.equal(f.current().tasks[0].attempts[0].results.length, 0);
    assert.equal(f.runtime.store.getRun(missing), undefined);
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(prior, missing, secondMissing); }
});

test("independent evidence survives process state loss, but generation conflicts and bad files do not import", async () => {
  const f = fixture();
  const id = randomUUID(), conflict = randomUUID(), memoryOnly = randomUUID();
  try {
    let store = new RuntimeStore(f.directory, f.parent);
    const memory = new Map<string, DispatchEvidence>();
    const info = (runId: string) => ({ runId, sessionFile: f.run(runId).sessionFile, startedAt: 1, dispatched: false, binding: f.attach(runId) });
    const capture = (runId: string) => captureDispatchEvidence(memory, store, { ...info(runId), operation: "persist-prepared" },
      Object.assign(new Error("potential prompt or credential"), { code: "EPERM" }), Object.assign(errno("ENOSPC"), { syscall: "write" }));
    assert.equal(capture(id).retained, "file");
    assert.doesNotMatch(readFileSync(join(f.directory, "dispatch-evidence", `${id}.json`), "utf8"), /potential prompt or credential/);
    assert.equal(capture(conflict).retained, "file");
    const path = join(f.directory, "dispatch-evidence", `${conflict}.json`);
    writeFileSync(path, JSON.stringify({ ...memory.get(conflict), generation: randomUUID() }));
    // Block the exclusive publication target. No partial record is imported.
    const inaccessible = join(f.directory, "dispatch-evidence", `${memoryOnly}.json`);
    writeFileSync(inaccessible, "invalid");
    assert.equal(capture(memoryOnly).retained, "memory-only");
    rmSync(inaccessible);
    assert.equal(readDispatchEvidence(f.directory, { parent: { ...f.parent, branchToken: "other" } }, memory).records.size, 0);
    const originalGeneration = store.snapshot().generation;
    store.close();
    memory.clear();
    const blocked = mock.method(RuntimeStore.prototype, "recordDispatchFailure", () => { throw errno("ENOSPC"); });
    try {
      await f.emit("session_start", { reason: "startup" });
      assert.equal(f.runtime.store, undefined);
      assert.equal(readRuntimeManifest(f.directory)?.generation, originalGeneration, "failed startup repair does not strand evidence under an old generation");
      assert.match((await f.execute("subagents_recovery")).content[0].text, /Dispatch evidence write blocked \(ENOSPC\)/);
    } finally { blocked.mock.restore(); }
    await f.emit("session_start", { reason: "startup" });
    store = f.runtime.store;
    const saved = readRuntimeManifest(f.directory)!;
    assert.match(String(saved.outbox[`subagent:${id}:dispatch-failure:launch`]?.envelope.message.content), /persist-prepared \(EPERM\); failure evidence write \(ENOSPC\)/);
    assert.equal(saved.runs[conflict], undefined);
    assert.equal(saved.runs[memoryOnly], undefined);
    const report = await f.execute("subagents_recovery");
    assert.match(report.content[0].text, new RegExp(`${conflict}: still-blocked \\(WRITER_GENERATION_CONFLICT\\)`));
    assert.match(report.content[0].text, new RegExp(`${memoryOnly}: dispatch-unknown`));
    const [result] = f.current().tasks[0].attempts[0].results;
    assert.match(result.reason, /persist-prepared \(EPERM\); failure evidence write \(ENOSPC\)/);
    assert.deepEqual(f.messages, []);
    assert.equal(reconcileDispatchEvidence(store, readDispatchEvidence(f.directory, store.snapshot(), memory), f.current(), memory).storeError, undefined);
  } finally { await f.clean(id, conflict, memoryOnly); }
});

for (const when of ["before spawn", "before resume", "during pane setup"] as const) {
  test(`live journal EIO fences fresh dispatch (${when}) until explicit metadata repair`, async t => {
    const f = fixture(), id = randomUUID();
    const launched: string[] = [];
    let unavailable = when !== "during pane setup", arm = when === "during pane setup";
    const terminal = mockResumeTerminal(t, f.dir, undefined, () => {
      if (arm) { arm = false; unavailable = true; }
    });
    const path = join(f.directory, "dispatch-evidence", `${id}.json`);
    const open = fs.openSync;
    const fault = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (unavailable && args[0] === path) throw errno("EIO");
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      const binding = f.attach(id);
      const sessionPath = savedSession(f.dir, "eio-intent", binding);
      const run = { ...f.run(id, binding), sessionFile: sessionPath, cli: "pi" };
      const previous = new RuntimeStore(f.directory, f.parent);
      previous.prepare(run);
      previous.commitFreshDispatch(id, sessionPath, binding);
      previous.close();
      await f.emit("session_start", { reason: "startup" });
      const store: RuntimeStore = f.runtime.store;
      const { record, retained } = captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: sessionPath,
        binding, startedAt: run.startTime, operation: verifyResumeImages, dispatched: false }, errno("EIO"), errno("EIO"));
      assert.equal(retained, "file");
      const independent = savedSession(f.dir, "eio-independent");
      const resume = () => f.execute("subagent_resume", { sessionPath: independent });
      const spawn = () => f.execute("subagent", { name: "Independent", task: "Synthetic work" });
      const before = f.current();
      const beforeRun = store.getRun(id);
      const panes = when === "during pane setup" ? 1 : 0;
      if (when === "before resume") await assert.rejects(resume, /EIO/);
      // No reconcile or diagnostic read is needed to discover the fault.
      await assert.rejects(spawn, /EIO/);
      assert.deepEqual(terminal.counts, { panes, sends: 0 });
      assert.equal(store.getEvent(record.eventId), undefined);
      assert.deepEqual(store.getRun(id), beforeRun);
      assert.deepEqual(f.current(), before);
      assert.equal(sessionOwners.get(sessionPath)?.runId, id);
      assert.deepEqual(f.messages, []);
      if (!panes) assert.deepEqual(store.outboxIds(), [], "preflight leaves no launch record");
      else {
        const refused = store.listRuns().filter(run => run.id !== id);
        assert.equal(refused.length, 1);
        assert.equal(refused[0].phase, "prepared", "failure in pane setup leaves no committed intent");
      }
      assert.match((await f.execute("subagents_recovery")).content[0].text, /EIO/);
      if (when === "before resume") {
        assert.match((await f.execute("subagents_reconcile")).content[0].text, /Storage\/custody:[\s\S]*EIO/);
        assert.equal(store.getEvent(record.eventId), undefined);
      }
      unavailable = false;
      if (when === "before spawn") {
        const fenced = store.snapshot();
        await f.reload();
        assert.equal(f.runtime.store, store);
        assert.deepEqual(store.snapshot(), fenced, "reload alone must not clear an observed read fault");
      }
      await assert.rejects(spawn, /Dispatch metadata write paused \(EIO\)/);
      await assert.rejects(resume, /Dispatch metadata write paused \(EIO\)/);
      assert.deepEqual(terminal.counts, { panes, sends: 0 });
      assert.equal(readFileSync(path, "utf8"), JSON.stringify(record));

      const reconciliation = await f.execute("subagents_reconcile");
      assert.equal(reconciliation.details.status, "resolved", reconciliation.content[0].text);
      assert.equal(store.getEvent(record.eventId)?.status, "handedOff");
      assert.deepEqual(store.getRun(id)?.eventCursor, [record.eventId]);
      assert.deepEqual(f.current().tasks[0].attempts[0].results.map((result: { eventId: string }) => result.eventId), [record.eventId]);
      assert.equal(sessionOwners.has(sessionPath), false);
      const repaired = store.snapshot(), imported = f.current();
      assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
      assert.deepEqual(store.snapshot(), repaired);
      assert.deepEqual(f.current(), imported);
      assert.deepEqual(terminal.counts, { panes, sends: 0 }, "repair must not replay either dispatch");
      assert.deepEqual(f.messages, []);

      const result = await spawn();
      launched.push(result.details.id);
      assert.equal(result.details.status, "started");
      assert.notEqual(result.details.id, id);
      assert.equal(store.getRun(result.details.id)?.phase, "supervised");
      assert.deepEqual(terminal.counts, { panes: panes + 1, sends: 1 });
    } finally {
      fault.mock.restore(); syncBuiltinESMExports();
      try { await f.clean(id, ...launched); } finally { terminal.restore(); }
    }
  });
}

for (const at of ["manifest proof during pane setup", "journal read at final dispatch"] as const) {
  test(`in-flight bound launch retains unsent evidence without projecting while fenced (${at})`, async t => {
    const f = fixture(), id = randomUUID();
    const proofFault = at === "manifest proof during pane setup";
    const manifest = join(f.directory, "manifest.json"), journal = join(f.directory, "dispatch-evidence", `${id}.json`);
    const prior = { id, sessionFile: savedSession(f.dir, "in-flight-prior"), name: "Prior", task: "Synthetic work", startTime: 1, cli: "pi" };
    const marked = resumeIntentFailure(prior);
    let store: RuntimeStore, runId: string | undefined, attached: ReturnType<typeof f.current>;
    let armed = false, hits = 0, initialJournalReads = 0, phaseAtJournalFault: string | undefined;
    const terminal = mockResumeTerminal(t, f.dir, undefined, () => {
      attached = f.current();
      runId = attached.tasks[0].attempts[0].runIds[0];
      armed = true;
      if (proofFault) {
        store.recordDispatchFailure(prior, marked); // A new event invalidates the manifest stamp after the initial gate.
        f.runtime.delivery.onEnvelope(id, marked);
      }
    });
    const read = fs.readFileSync, open = fs.openSync;
    const fault = proofFault
      ? t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
        if (armed && args[0] === manifest && new Error().stack?.includes("canImportAfterIntentFailure")) {
          armed = false; ++hits; throw errno("EIO");
        }
        return read(...args);
      }) as typeof fs.readFileSync)
      : t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (args[0] === journal && new Error().stack?.includes("assertFreshDispatchStorage")) {
          if (armed && runId) {
            phaseAtJournalFault = store.getRun(runId)?.phase;
            armed = false; ++hits; throw errno("EIO");
          }
          ++initialJournalReads;
        }
        return open(...args);
      });
    syncBuiltinESMExports();
    try {
      const previous = new RuntimeStore(f.directory, f.parent);
      previous.prepare(prior);
      previous.commitFreshDispatch(id, prior.sessionFile);
      previous.close();
      await f.emit("session_start", { reason: "startup" });
      store = f.runtime.store;
      if (!proofFault) assert.equal(captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: prior.sessionFile,
        startedAt: prior.startTime, operation: verifyResumeImages, dispatched: false }, errno("EPERM"), errno("ENOSPC")).retained, "file");

      const plan = f.current(), task = plan.tasks[0];
      const planTask = { planId: plan.planId, taskId: task.taskId, attemptId: task.attempts[0].attemptId, expectedRevision: plan.revision };
      await assert.rejects(() => f.execute("subagent", { name: "Bound", task: "Synthetic work", planTask }), /EIO/);
      assert.equal(hits, 1);
      if (!proofFault) {
        assert.equal(initialJournalReads, 1, "the initial fresh-dispatch gate read the journal successfully");
        assert.equal(phaseAtJournalFault, "prepared", "the one-shot read failed at the final gate, before intent");
      }
      assert.ok(runId);
      assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });
      assert.equal(f.runtime.dispatchRepair?.requiresExplicitReconcile, true);
      const eventId = dispatchFailureEventId(runId), persisted = readRuntimeManifest(f.directory)!;
      const failure = persisted.outbox[eventId];
      assert.equal(failure?.status, "handedOff", "the failure is durable and import-only");
      assert.match(String(failure.envelope.message.content), /Dispatch failed before send.*EIO/);
      assert.equal(persisted.runs[runId]?.phase, "prepared");
      assert.deepEqual(persisted.runs[runId]?.eventCursor, [eventId]);
      assert.deepEqual(f.current(), attached, "the launch catch must not project failure while storage is fenced");
      await f.endTurn();
      await f.reload();
      await f.endTurn();
      assert.equal(f.runtime.store, store);
      assert.equal(f.runtime.dispatchRepair?.requiresExplicitReconcile, true);
      assert.deepEqual(readRuntimeManifest(f.directory), persisted);
      assert.deepEqual(f.current(), attached);

      const clean = await f.execute("subagents_reconcile");
      assert.equal(clean.details.status, "resolved", clean.content[0].text);
      assert.equal(f.runtime.dispatchRepair?.requiresExplicitReconcile, undefined);
      const imported = f.current();
      assert.equal(imported.revision, attached.revision + 1);
      assert.equal(imported.tasks[0].status, "failed");
      assert.deepEqual(imported.tasks[0].attempts[0].results.map((r: any) => [r.runId, r.eventId, r.kind]), [[runId, eventId, "failure"]]);
      assert.deepEqual(store.getEvent(eventId), failure);
      await f.endTurn();
      assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
      assert.deepEqual(f.current(), imported, "retries cannot project the failure twice");
      assert.deepEqual(terminal.counts, { panes: 1, sends: 0 });
      assert.deepEqual(f.messages, []);
    } finally {
      fault.mock.restore(); syncBuiltinESMExports();
      try { await f.clean(id, ...(runId ? [runId] : [])); } finally { terminal.restore(); }
    }
  });
}

for (const at of ["reconcile disposition", "startup disposition", "read-only recovery"] as const) {
  test(`one-shot journal EIO fences this writer (${at}) until clean explicit reconciliation`, async t => {
    const f = fixture(), id = randomUUID();
    const terminal = mockResumeTerminal(t, f.dir);
    const launched: string[] = [];
    const path = join(f.directory, "dispatch-evidence", `${id}.json`);
    const site = at === "read-only recovery" ? "readRecoveryView" : "readDispatchDisposition";
    const open = fs.openSync;
    let armed = false, hits = 0;
    const fault = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (armed && args[0] === path && new Error().stack?.includes(site)) {
        armed = false;
        ++hits;
        throw errno("EIO");
      }
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      const binding = f.attach(id), sessionPath = savedSession(f.dir, "oneshot-intent", binding);
      const independent = savedSession(f.dir, "oneshot-independent");
      const run = { ...f.run(id, binding), sessionFile: sessionPath, cli: "pi" };
      const previous = new RuntimeStore(f.directory, f.parent);
      previous.prepare(run);
      previous.commitFreshDispatch(id, sessionPath, binding);
      let writer = previous;
      if (at !== "startup disposition") {
        previous.close();
        await f.emit("session_start", { reason: "startup" });
        writer = f.runtime.store;
      }
      // The metadata pass can read this journal and sees only a run-local
      // disagreement. Only the targeted authoritative reread fails.
      const { record, retained } = captureDispatchEvidence(new Map(), writer, { runId: id, sessionFile: sessionPath,
        binding, startedAt: run.startTime + 1, operation: verifyResumeImages, dispatched: false }, errno("EPERM"), errno("ENOSPC"));
      assert.equal(retained, "file");
      const priorPlan = f.current(), priorRun = writer.getRun(id), owner = sessionOwners.get(sessionPath);
      const supervisor = f.runtime.stopRecovery;
      const pass = supervisor && t.mock.method(supervisor, "reconcile");
      let report: string;
      armed = true;
      if (at === "startup disposition") {
        writer.close();
        await f.emit("session_start", { reason: "startup" });
        writer = f.runtime.store;
        report = f.notices.join("\n");
      } else {
        const result = await f.execute(at === "read-only recovery" ? "subagents_recovery" : "subagents_reconcile");
        report = result.content[0].text;
        assert.equal(pass.mock.callCount(), 0, "fault must not trigger an explicit supervisor pass");
      }
      assert.equal(hits, 1);
      assert.match(report, /EIO/);
      assert.equal(f.runtime.dispatchRepair?.storeError, "EIO");
      assert.equal(f.runtime.stopRecovery, undefined);
      assert.equal(f.runtime.delivery.api, undefined);
      assert.equal(sessionOwners.get(sessionPath), owner);
      const fenced = writer.snapshot();
      const checkNoReplay = () => {
        assert.equal(readFileSync(path, "utf8"), JSON.stringify(record));
        assert.deepEqual(writer.getRun(id), priorRun);
        assert.deepEqual(writer.outboxIds(), []);
        assert.deepEqual(f.current(), priorPlan);
        assert.deepEqual(f.messages, []);
        assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
      };
      checkNoReplay();
      // The journal opens successfully on incidental reads now; neither a
      // diagnostic read nor a reload may clear an already observed fault.
      assert.match((await f.execute("subagents_recovery")).content[0].text, /EIO/);
      await f.reload();
      assert.equal(f.runtime.store, writer);
      assert.deepEqual(writer.snapshot(), fenced);
      const spawn = () => f.execute("subagent", { name: "Independent", task: "Synthetic work" });
      const resume = () => f.execute("subagent_resume", { sessionPath: independent });
      await assert.rejects(spawn, /Dispatch metadata write paused \(EIO\)/);
      await assert.rejects(resume, /Dispatch metadata write paused \(EIO\)/);
      checkNoReplay();

      const clean = await f.execute("subagents_reconcile");
      assert.equal(clean.details.status, "still-blocked", "readable disagreement is still unresolved for the original run");
      assert.equal(clean.details.incidents.find((item: any) => item.runId === id)?.code, "EVIDENCE_CONFLICT");
      assert.doesNotMatch(clean.content[0].text, /Storage\/custody:/);
      assert.equal(hits, 1);
      assert.equal(f.runtime.dispatchRepair?.storeError, undefined);
      assert.equal(f.runtime.stopRecovery?.tracks(id), true);
      assert.ok(f.runtime.delivery.api);
      assert.equal(sessionOwners.get(sessionPath)?.runId, id);
      checkNoReplay();
      await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: still-blocked`));
      for (const launch of [spawn, resume]) {
        const result = await launch();
        assert.equal(result.details.status, "started");
        assert.notEqual(result.details.id, id);
        launched.push(result.details.id);
        assert.equal(writer.getRun(result.details.id)?.phase, "supervised");
        assert.deepEqual(terminal.counts, { panes: launched.length, sends: launched.length });
      }
    } finally {
      fault.mock.restore(); syncBuiltinESMExports();
      try { await f.clean(id, ...launched); } finally { terminal.restore(); }
    }
  });
}

test("one-shot journal EIO during plan proof fences delivery and defers the marked import", async t => {
  const f = fixture(), id = randomUUID(), conflict = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  const open = fs.openSync;
  const path = join(f.directory, "dispatch-evidence", `${conflict}.json`);
  let armed = false, hits = 0;
  const fault = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (armed && args[0] === path && new Error().stack?.includes("canImportAfterIntentFailure")) {
      armed = false;
      ++hits;
      throw errno("EIO");
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    const run = f.run(id);
    const independent = { ...run, id: conflict, planTask: undefined, sessionFile: savedSession(f.dir, "proof-conflict") };
    const previous = new RuntimeStore(f.directory, f.parent);
    for (const intent of [run, independent]) {
      previous.prepare(intent);
      previous.commitFreshDispatch(intent.id, intent.sessionFile, intent.planTask);
    }
    previous.close();
    await f.emit("session_start", { reason: "startup" });
    const store: RuntimeStore = f.runtime.store;
    const failure = resumeIntentFailure(run);
    store.recordDispatchFailure(run, failure);
    const { record, retained } = captureDispatchEvidence(new Map(), store, { runId: conflict, sessionFile: independent.sessionFile,
      startedAt: independent.startTime + 1, operation: verifyResumeImages, dispatched: false }, errno("EPERM"), errno("ENOSPC"));
    assert.equal(retained, "file");
    const plan = f.current(), disk = store.snapshot();
    armed = true;
    const blocked = await f.execute("subagents_reconcile");
    assert.equal(hits, 1);
    assert.match(blocked.content[0].text, /Storage\/custody:[\s\S]*EIO/);
    assert.equal(f.runtime.delivery.api, undefined);
    await f.endTurn(); // Retry with good reads must still honor the latch.
    assert.deepEqual(f.current(), plan);
    assert.deepEqual(store.snapshot(), disk);

    const clean = await f.execute("subagents_reconcile");
    assert.doesNotMatch(clean.content[0].text, /Storage\/custody:/);
    assert.equal(f.runtime.dispatchRepair?.storeError, undefined);
    assert.deepEqual(f.current().tasks[0].attempts[0].results.map((result: any) => [result.eventId, result.kind]),
      [[failure.message.details.eventId, "failure"]]);
    assert.deepEqual(store.snapshot(), disk);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(record));
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    assert.deepEqual(f.messages, []);
  } finally {
    fault.mock.restore(); syncBuiltinESMExports();
    try { await f.clean(id, conflict); } finally { terminal.restore(); }
  }
});

for (const pin of [false, true]) test(`dispatch writer stays fenced after ${pin ? "manifest pin ENOSPC" : "manifest proof EIO"} until explicit reconciliation`, async t => {
  const f = fixture(), id = randomUUID(), otherId = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  const manifest = join(f.directory, "manifest.json");
  const read = fs.readFileSync, rename = fs.renameSync;
  const code = pin ? "ENOSPC" : "EIO";
  let armed = false, hits = 0, pinAttempts = 0;
  const fault = pin
    ? t.mock.method(fs, "renameSync", (from: string, to: string) => {
      if (to === manifest && new Error().stack?.includes("retainDispatchEvidence")) {
        ++pinAttempts;
        if (armed) { armed = false; ++hits; throw errno(code); }
      }
      rename(from, to);
    })
    : t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
      if (armed && args[0] === manifest && new Error().stack?.includes("canImportAfterIntentFailure")) {
        armed = false;
        ++hits;
        throw errno(code);
      }
      return read(...args);
    }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  const launched: string[] = [];
  try {
    const binding = f.attach(id), sessionFile = savedSession(f.dir, "fault-intent", binding);
    const run = { ...f.run(id, binding), sessionFile, cli: "pi" };
    const other = { ...run, id: otherId, planTask: pin ? f.attach(otherId) : undefined, sessionFile: savedSession(f.dir, "ordinary") };
    const previous = new RuntimeStore(f.directory, f.parent);
    for (const intent of [run, other]) {
      previous.prepare(intent);
      previous.commitFreshDispatch(intent.id, intent.sessionFile, intent.planTask);
    }
    previous.phase(otherId, "supervised");
    previous.close();
    await f.emit("session_start", { reason: "startup" });
    const store: RuntimeStore = f.runtime.store;
    const supervisor = f.runtime.stopRecovery;
    const owner = sessionOwners.get(sessionFile);
    assert.equal(owner?.runId, id);
    assert.equal(supervisor.status().state, "active");
    assert.ok(f.runtime.delivery.api);
    const journal = join(f.directory, "dispatch-evidence", `${id}.json`);
    const failure = resumeIntentFailure(run), eventId = failure.message.details.eventId;
    const plan = f.current();
    let original: DispatchEvidence | undefined, mismatch: string | undefined;
    if (pin) {
      const memory: Map<string, DispatchEvidence> = f.runtime.dispatchEvidence;
      const { record, retained } = captureDispatchEvidence(memory, store, { runId: id, sessionFile,
        binding, startedAt: run.startTime, dispatched: false, operation: verifyResumeImages }, errno("EPERM"), errno(code));
      assert.equal(retained, "file");
      original = record;
      mismatch = JSON.stringify({ ...record, startedAt: record.startedAt + 1 });
      writeFileSync(journal, mismatch);
    } else store.recordDispatchFailure(run, failure); // Invalidates the cached manifest stamp before the live proof.
    const bytes = readFileSync(manifest);
    armed = true;
    const report = () => f.execute("subagents_recovery");
    const reconcile = () => f.execute("subagents_reconcile");
    const storageReport = new RegExp(`Storage uncertain;[^\\n]*: ${code}`);
    if (pin) assert.match((await reconcile()).content[0].text, /Storage\/custody:[\s\S]*ENOSPC/);
    else await f.endTurn();
    assert.equal(hits, 1);
    assert.deepEqual(readFileSync(manifest), bytes, "failed I/O cannot commit metadata");
    assert.deepEqual(f.current(), plan);
    assert.equal(f.runtime.dispatchRepair?.storeError, code);
    assert.equal(f.runtime.stopRecovery, undefined);
    assert.equal(supervisor.status().state, "stopped");
    assert.equal(f.runtime.delivery.api, undefined);
    assert.match((await report()).content[0].text, storageReport);

    const ordinary = { customType: "subagent_result", content: "Ordinary completion", display: true,
      details: { exitCode: 0, sessionFile: other.sessionFile } };
    const ordinaryId = `subagent:${otherId}:completion:storage-fence`;
    enqueueDelivery(f.runtime.delivery, { id: otherId, lifecycle: createLifecycle(1) }, ordinary, () => {}, "storage-fence");
    const queued = store.getEvent(ordinaryId)!;
    assert.equal(queued.status, "pending", "an ordinary completion is retained, not handed off while fenced");
    const fenced = store.snapshot();
    const independent = savedSession(f.dir, "fault-independent");
    const spawn = () => f.execute("subagent", { name: "Independent", task: "Synthetic work" });
    const resume = () => f.execute("subagent_resume", { sessionPath: independent });
    const checkFence = async () => {
      await f.endTurn();
      const paused = new RegExp(`Dispatch metadata write paused \\(${code}\\)`);
      await assert.rejects(spawn, paused);
      await assert.rejects(resume, paused);
      assert.deepEqual(f.current(), plan, "incidental import must not clear the fence or mutate the plan");
      assert.deepEqual(store.snapshot(), fenced);
      assert.equal(sessionOwners.get(sessionFile), owner);
      assert.deepEqual(f.messages, []);
      assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    };
    await checkFence();
    await f.reload();
    assert.equal(f.runtime.store, store);
    assert.equal(f.runtime.stopRecovery, undefined);
    assert.equal(f.runtime.delivery.api, undefined);
    assert.match((await report()).content[0].text, storageReport);
    await checkFence();
    if (pin) {
      assert.equal(pinAttempts, 1, "reload must not retry the pin while fenced");
      assert.equal(readFileSync(journal, "utf8"), mismatch);
      assert.deepEqual(f.runtime.dispatchEvidence.get(id), original);
    }

    const repaired = await reconcile();
    assert.doesNotMatch(repaired.content[0].text, /Storage\/custody:/);
    assert.equal(f.runtime.dispatchRepair?.storeError, undefined);
    assert.equal(f.runtime.stopRecovery?.status().state, "active");
    assert.equal(f.runtime.stopRecovery?.tracks(otherId), true);
    assert.ok(f.runtime.delivery.api);
    assert.equal(store.getEvent(ordinaryId)?.status, "handedOff");
    assert.deepEqual(f.messages, [queued.envelope.message]);
    if (pin) {
      assert.equal(pinAttempts, 2);
      assert.equal(repaired.details.incidents.find((item: any) => item.runId === id)?.code, "EVIDENCE_CONFLICT");
      assert.deepEqual(store.snapshot().retainedDispatchEvidence?.[id], original);
      assert.equal(readFileSync(journal, "utf8"), mismatch);
      assert.equal(store.getEvent(eventId), undefined);
      assert.equal(sessionOwners.get(sessionFile), owner);
      await assert.rejects(() => f.execute("subagent_resume", { sessionPath: sessionFile }), new RegExp(`${id}: still-blocked`));
    } else {
      assert.deepEqual(store.getEvent(eventId), fenced.outbox[eventId]);
      assert.equal(sessionOwners.has(sessionFile), false);
    }
    const imported = f.current();
    assert.deepEqual(imported.tasks[0].attempts[0].results.map((item: any) => [item.runId, item.eventId, item.kind]),
      [pin ? [otherId, ordinaryId, "result"] : [id, eventId, "failure"]]);
    await f.endTurn();
    await reconcile();
    assert.deepEqual(f.current(), imported);
    assert.deepEqual(f.messages, [queued.envelope.message]);
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });

    const fresh = await spawn();
    launched.push(fresh.details.id);
    assert.notEqual(fresh.details.id, id);
    assert.equal(store.getRun(fresh.details.id)?.phase, "supervised");
    assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });
    assert.equal(hits, 1);
  } finally {
    fault.mock.restore(); syncBuiltinESMExports();
    try { await f.clean(id, otherId, ...launched); } finally { terminal.restore(); }
  }
});

test("failed explicit supervisor restoration preserves the manifest proof fence through reload", async t => {
  const f = fixture(), id = randomUUID(), otherId = randomUUID(), pid = 12345, birth = "1234567890";
  const terminal = mockResumeTerminal(t, f.dir);
  const manifest = join(f.directory, "manifest.json");
  const read = fs.readFileSync, rename = fs.renameSync, exec = childProcess.execFileSync;
  const originalTimeout = globalThis.setTimeout;
  const probes: Array<() => void> = [], launched: string[] = [];
  let readFault = false, writeFault = false, reads = 0, writes = 0;
  let recovery: Promise<any> | undefined;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const readMock = t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (readFault && args[0] === manifest && new Error().stack?.includes("canImportAfterIntentFailure")) {
      readFault = false; ++reads; throw errno("EIO");
    }
    return read(...args);
  }) as typeof fs.readFileSync);
  const renameMock = t.mock.method(fs, "renameSync", (from: string, to: string) => {
    if (writeFault && to === manifest && new Error().stack?.includes("reconcileRun")) {
      writeFault = false; ++writes; throw errno("ENOSPC");
    }
    rename(from, to);
  });
  const processMock = t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    if (file === "powershell.exe" && args.some(arg => arg.includes(`Get-Process -Id ${pid} `))) return JSON.stringify({ pid, birth });
    return exec(file, args);
  });
  const delayed = t.mock.method(globalThis, "setTimeout", (fn: () => void, ms: number) => {
    if (ms === 50) { probes.push(fn); return undefined; }
    return originalTimeout(fn, ms);
  });
  syncBuiltinESMExports();
  try {
    const run = f.run(id);
    const other = { ...run, id: otherId, planTask: undefined, sessionFile: savedSession(f.dir, "restore-probe"), cli: "pi" };
    const previous = new RuntimeStore(f.directory, f.parent);
    for (const intent of [run, other]) {
      previous.prepare(intent);
      previous.commitFreshDispatch(intent.id, intent.sessionFile, intent.planTask);
    }
    previous.phase(otherId, "supervised");
    previous.close();
    await f.emit("session_start", { reason: "startup" });
    const store: RuntimeStore = f.runtime.store;
    assert.ok(f.runtime.stopRecovery);
    const plan = f.current(), failure = resumeIntentFailure(run);
    store.recordDispatchFailure(run, failure);
    readFault = true;
    await f.endTurn();
    assert.equal(reads, 1);
    assert.equal(f.runtime.stopRecovery, undefined);

    // Only explicit restoration should see this identity. Hold its challenge
    // open so ordinary turns and launch requests can run during the await.
    const identity = runCompletionFile(other.sessionFile, otherId);
    writeFileSync(`${identity}.identity.json`, JSON.stringify({ schema: 1, runId: otherId, sessionFile: other.sessionFile,
      headerId: "restore-probe", nonce: otherId, process: { pid, birth: `windows:${birth}` } }));
    const answerProbe = () => {
      assert.equal(probes.length, 1);
      writeFileSync(`${identity}.response.json`, readFileSync(`${identity}.challenge.json`));
      probes.shift()!();
    };
    const spawn = () => f.execute("subagent", { name: "Independent", task: "Synthetic work" });
    const reconcile = () => f.execute("subagents_reconcile");
    const ordinaryId = `subagent:${otherId}:completion:restore-fence`;
    const assertFenced = async () => {
      await f.endTurn();
      await assert.rejects(spawn, /EIO|ENOSPC/);
      assert.equal(f.runtime.delivery.api, undefined);
      assert.equal(store.getEvent(ordinaryId)?.status, "pending");
      assert.deepEqual(f.current(), plan);
      assert.deepEqual(f.messages, []);
      assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    };
    writeFault = true;
    recovery = reconcile();
    assert.equal(probes.length, 1, "metadata succeeded and explicit restoration reached the async probe");
    enqueueDelivery(f.runtime.delivery, { id: otherId, lifecycle: createLifecycle(1) }, {
      customType: "subagent_result", display: true, content: "Ordinary completion",
      details: { exitCode: 0, sessionFile: other.sessionFile },
    }, () => {}, "restore-fence");
    await assertFenced();
    answerProbe();
    const blocked = await recovery;
    assert.equal(writes, 1);
    assert.equal(blocked.details.status, "still-blocked");
    assert.match(blocked.content[0].text, /Storage\/custody:[\s\S]*ENOSPC/);
    assert.equal(f.runtime.stopRecovery, undefined);
    await assertFenced();
    const fenced = store.snapshot();
    await f.reload();
    assert.equal(f.runtime.store, store);
    assert.equal(f.runtime.stopRecovery, undefined);
    assert.deepEqual(store.snapshot(), fenced, "reload must not retry the failed explicit restoration");
    await assertFenced();

    recovery = reconcile();
    await assertFenced();
    answerProbe();
    const clean = await recovery;
    assert.equal(clean.details.status, "resolved");
    assert.equal(f.runtime.stopRecovery?.status().state, "active");
    assert.equal(store.getEvent(ordinaryId)?.status, "handedOff");
    const results = f.current().tasks[0].attempts[0].results;
    assert.deepEqual(results.map((result: any) => [result.eventId, result.kind]), [[failure.message.details.eventId, "failure"]]);
    assert.equal(f.messages.length, 1);
    await f.endTurn();
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    assert.equal(f.messages.length, 1);
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    const fresh = await spawn();
    launched.push(fresh.details.id);
    assert.notEqual(fresh.details.id, id);
    assert.equal(store.getRun(fresh.details.id)?.phase, "supervised");
    assert.deepEqual(terminal.counts, { panes: 1, sends: 1 });
  } finally {
    delayed.mock.restore();
    for (const probe of probes) probe();
    await recovery?.catch(() => {});
    processMock.mock.restore(); renameMock.mock.restore(); readMock.mock.restore(); syncBuiltinESMExports();
    try { await f.clean(id, otherId, ...launched); } finally { terminal.restore(); }
  }
});

for (const target of ["directory", "record"]) test(`journal ${target} EPERM preserves generation and recovers after process-state loss`, async () => {
  const f = fixture(), id = randomUUID();
  try {
    const store = new RuntimeStore(f.directory, f.parent);
    const run = f.run(id);
    captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: run.sessionFile, startedAt: 1, binding: run.planTask, dispatched: false }, errno("EPERM"), errno("EPERM"));
    const generation = store.snapshot().generation;
    store.close();
    const original = target === "directory" ? fs.readdirSync : fs.openSync;
    const method = target === "directory" ? "readdirSync" : "openSync";
    const blocked = mock.method(fs, method, ((...args: any[]) => {
      const path = String(args[0]);
      if (target === "directory" ? path.endsWith("dispatch-evidence") : path.endsWith(`${id}.json`)) throw errno("EPERM");
      return (original as any)(...args);
    }) as any);
    syncBuiltinESMExports();
    try {
      await f.emit("session_start", { reason: "startup" });
      assert.equal(f.runtime.store, undefined);
      assert.equal(readRuntimeManifest(f.directory)?.generation, generation);
      assert.match((await f.execute("subagents_recovery")).content[0].text, /EPERM/);
    } finally { blocked.mock.restore(); syncBuiltinESMExports(); }
    await f.emit("session_start", { reason: "startup" });
    assert.ok(f.runtime.store.getRun(id));
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    const revision = f.runtime.store.snapshot().revision;
    await f.execute("subagents_reconcile");
    assert.equal(f.runtime.store.snapshot().revision, revision);
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(id); }
});

for (const kind of ["JSON", "SCHEMA"]) test(`invalid journal ${kind} is sanitized and retains the writer generation until repaired`, async () => {
  const f = fixture(), id = randomUUID();
  const marker = "nonsecret-journal-marker";
  const code = `EVIDENCE_INVALID_${kind}`;
  try {
    const store = new RuntimeStore(f.directory, f.parent), run = f.run(id);
    const { record, retained } = captureDispatchEvidence(new Map(), store, {
      runId: id, sessionFile: run.sessionFile, startedAt: run.startTime, binding: run.planTask, dispatched: false,
    }, errno("EPERM"), errno("EPERM"));
    assert.equal(retained, "file");
    const path = join(f.directory, "dispatch-evidence", `${id}.json`);
    const original = readFileSync(path);
    store.close();
    f.runtime.dispatchEvidence?.clear();
    writeFileSync(path, kind === "JSON" ? marker : JSON.stringify({ ...record, schema: marker }));
    await f.emit("session_start", { reason: "startup" });
    assert.equal(f.runtime.store, undefined);
    assert.match(f.notices.join("\n"), new RegExp(code));
    assert.equal(readRuntimeManifest(f.directory)?.generation, record.generation);
    assert.deepEqual(readRuntimeManifest(f.directory)?.outbox, {});
    const report = await f.execute("subagents_recovery", { runId: id });
    const blocked = await f.execute("subagents_reconcile", {}, { ...f.ctx });
    assert.equal(blocked.details.status, "still-blocked");
    for (const text of [report.content[0].text, blocked.content[0].text]) {
      assert.match(text, new RegExp(`${id}: ${code}`));
      assert.ok(!text.includes(marker));
    }
    assert.ok(!f.notices.join("\n").includes(marker));
    assert.equal(readRuntimeManifest(f.directory)?.generation, record.generation);

    writeFileSync(path, original);
    assert.match(await f.reconcileCommand({ ...f.ctx }), new RegExp(`${id}: resolved`));
    const repaired = readRuntimeManifest(f.directory)!;
    assert.notEqual(repaired.generation, record.generation);
    assert.deepEqual(Object.keys(repaired.outbox), [record.eventId]);
    assert.deepEqual(repaired.runs[id].eventCursor, [record.eventId]);
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    await f.execute("subagents_reconcile");
    assert.deepEqual(readRuntimeManifest(f.directory), repaired);
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(id); }
});

test("unselected binding retains only exact evidence across successive generations", async () => {
  const f = fixture(), id = randomUUID(), wrongRun = randomUUID();
  try {
    const store = new RuntimeStore(f.directory, f.parent), run = f.run(id);
    store.prepare(run);
    f.attach(wrongRun); // Also belongs to this attempt, but has no adopted evidence.
    const originalBranch = f.sm.getLeafId()!;
    const { record } = captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: run.sessionFile, startedAt: 1, binding: run.planTask, dispatched: false }, errno("EPERM"), errno("EPERM"));
    const journal = (runId: string) => join(f.directory, "dispatch-evidence", `${runId}.json`);
    store.close();
    f.sm.branch(f.parent.checkpoint); // Checkpoint custody is intact; original plan is not selected.
    const blocked = mock.method(RuntimeStore.prototype, "retainDispatchEvidence", () => { throw errno("ENOSPC"); });
    try {
      await f.emit("session_start", { reason: "startup" });
      assert.equal(f.runtime.store, undefined);
      assert.equal(readRuntimeManifest(f.directory)?.generation, record.generation);
      assert.match((await f.execute("subagents_recovery")).content[0].text, /ENOSPC/);
    } finally { blocked.mock.restore(); }
    await f.emit("session_start", { reason: "startup" });
    const first = readRuntimeManifest(f.directory)!;
    assert.notEqual(first.generation, record.generation);
    assert.deepEqual(first.retainedDispatchEvidence, { [id]: record });
    assert.deepEqual(first.outbox, {});
    const result = await f.execute("subagents_reconcile");
    assert.match(result.content[0].text, new RegExp(`${id}: still-blocked \\(BINDING_MISMATCH\\)`));
    assert.doesNotMatch(result.content[0].text, /Storage\/custody:/);
    assert.throws(() => store.retainDispatchEvidence(record), /writer lost custody/i);

    await f.emit("session_shutdown", { reason: "quit" });
    f.runtime.dispatchEvidence?.clear();
    // An altered same-run record and an unadopted old-generation record from
    // the right plan/attempt cannot use the retained record as authorization.
    writeFileSync(journal(id), JSON.stringify({ ...record, cause: "OTHER" }));
    const foreign = { ...record, runId: wrongRun, eventId: `subagent:${wrongRun}:dispatch-failure:launch` };
    writeFileSync(journal(wrongRun), JSON.stringify(foreign));
    f.sm.branch(originalBranch);
    await f.emit("session_start", { reason: "startup" });
    const second = readRuntimeManifest(f.directory)!;
    assert.notEqual(second.generation, first.generation);
    assert.deepEqual(second.retainedDispatchEvidence, { [id]: record });
    assert.deepEqual(second.outbox, {});
    assert.equal(f.current().tasks[0].attempts[0].results.length, 0);
    const refused = await f.execute("subagents_reconcile");
    assert.match(refused.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
    assert.match(refused.content[0].text, new RegExp(`${wrongRun}: still-blocked \\(WRITER_GENERATION_CONFLICT\\)`));
    assert.equal(f.runtime.store.getRun(wrongRun), undefined);

    rmSync(journal(id)); // The exact adopted copy is durable without the side file.
    await f.execute("subagents_reconcile");
    const repaired = readRuntimeManifest(f.directory)!;
    assert.equal(repaired.retainedDispatchEvidence, undefined);
    assert.equal(repaired.outbox[record.eventId]?.status, "handedOff");
    assert.equal(repaired.outbox[foreign.eventId], undefined);
    assert.equal(f.current().tasks[0].attempts[0].results.length, 1);
    await f.execute("subagents_reconcile");
    assert.equal(readRuntimeManifest(f.directory)?.revision, repaired.revision);
    assert.deepEqual(f.messages, []);
  } finally { await f.clean(id, wrongRun); }
});

test("Pi child deny-tools omits subagents_reconcile at registration, not the user command", async () => {
  process.env.PI_DENY_TOOLS = " subagents_reconcile ";
  const f = fixture(true);
  try {
    assert.equal(f.tools.has("subagents_reconcile"), false);
    assert.ok(f.tools.has("subagent"));
    assert.ok(f.commands.has("subagents-reconcile"));
  } finally {
    delete process.env.PI_DENY_TOOLS;
    await f.clean();
  }
});

test("nested coordinator reconciles only its own session under branch custody", async () => {
  const f = fixture(true), id = randomUUID();
  process.env.PI_SUBAGENT_ID = randomUUID();
  process.env.PI_SUBAGENT_SESSION = "ancestor-launch-marker";
  try {
    assert.ok(f.tools.has("subagents_reconcile"));
    const store = new RuntimeStore(f.directory, f.parent);
    captureDispatchEvidence(new Map(), store, { runId: id, sessionFile: canonicalSessionPath(join(f.dir, "nested-child.jsonl")), startedAt: 1, dispatched: false }, errno("EPERM"), errno("EPERM"));
    store.close();
    await f.emit("session_start", { reason: "startup" });
    assert.match(await f.reconcileCommand(), new RegExp(`${id}: resolved`));
    assert.equal((await f.execute("subagents_reconcile")).details.status, "resolved");
    const revision = f.runtime.store.snapshot().revision;
    const branch = mock.method(f.sm, "getBranch", () => []);
    try {
      assert.equal((await f.execute("subagents_reconcile")).details.status, "still-blocked");
      assert.match(await f.reconcileCommand(), /custody/);
      assert.equal(f.runtime.store.snapshot().revision, revision);
    } finally { branch.mock.restore(); }
    const session = mock.method(f.sm, "getSessionFile", () => join(f.dir, "ancestor-session.jsonl"));
    try {
      assert.equal((await f.execute("subagents_reconcile")).details.status, "still-blocked");
      assert.match(await f.reconcileCommand(), /custody/);
      assert.equal(f.runtime.store.snapshot().revision, revision);
    } finally { session.mock.restore(); }
    assert.deepEqual(f.messages, []);
  } finally {
    await f.clean(id);
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_SESSION;
  }
});

test("restart with only dispatch intent reports unknown", async t => {
  const f = fixture(), id = randomUUID();
  const terminal = mockResumeTerminal(t, f.dir);
  try {
    const store = new RuntimeStore(f.directory, f.parent), binding = f.attach(id);
    const sessionPath = savedSession(f.dir, "bare-intent", binding);
    const run = { ...f.run(id, binding), sessionFile: sessionPath };
    store.prepare(run);
    store.commitFreshDispatch(id, sessionPath, binding);
    const before = store.snapshot();
    store.close();
    await f.emit("session_start", { reason: "startup" });
    const result = await f.execute("subagents_reconcile");
    assert.equal(result.details.status, "dispatch-unknown");
    assert.match(result.content[0].text, new RegExp(`${id}: dispatch-unknown \\(DISPATCH_INTENT\\)`));
    assert.notEqual(f.runtime.store.generation, before.generation);
    assert.deepEqual(f.runtime.store.getRun(id), { ...before.runs[id], reconciliation: "unverified: decision required; no terminal controls or automatic launch" });
    assert.deepEqual(f.runtime.store.outboxIds(), []);
    assert.equal(f.runtime.stopRecovery.tracks(id), true);
    assert.equal(sessionOwners.get(sessionPath)?.runId, id);
    await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: dispatch-unknown`));
    assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    const active: RuntimeStore = f.runtime.store;
    active.reconcileRun(id, "verified-live: artifact-only supervision; terminal controls disabled");
    const eventId = `subagent:${id}:dispatch-failure:launch`;
    active.enqueue(eventId, id, { message: { customType: "subagent_result", content: "contradictory unsent event",
      details: { eventId, error: "unsent" } }, options: { triggerTurn: true, deliverAs: "steer" } });
    for (const status of ["pending", "dispatching", "handedOff"] as const) {
      active.delivery(eventId, status);
      const report = await f.execute("subagents_recovery", { runId: id });
      assert.match(report.content[0].text, /dispatch-unknown \(DISPATCH_INTENT\)/, "stale label and contradictory dispatch event are not proof");
      await assert.rejects(() => f.execute("subagent_resume", { sessionPath }), new RegExp(`${id}: dispatch-unknown`));
      assert.deepEqual(terminal.counts, { panes: 0, sends: 0 });
    }
  } finally { try { await f.clean(id); } finally { terminal.restore(); } }
});

for (const dispatched of [false, true]) test(`canonical outbox wins over identical ${dispatched ? "send-possible" : "before-send"} residue, but not mismatches`, async () => {
  const f = fixture(), id = randomUUID();
  try {
    new RuntimeStore(f.directory, f.parent).close();
    await f.emit("session_start", { reason: "startup" });
    const store: RuntimeStore = f.runtime.store, run = f.run(id);
    if (dispatched) {
      store.prepare(run);
      store.phase(id, "dispatch-intent");
    }
    const memory: Map<string, DispatchEvidence> = f.runtime.dispatchEvidence ??= new Map();
    const { record, retained } = captureDispatchEvidence(memory, store, {
      runId: id, sessionFile: run.sessionFile, startedAt: run.startTime, binding: run.planTask, dispatched,
    }, errno("EPERM"), errno("EPERM"));
    assert.equal(retained, "file");
    const path = join(f.directory, "dispatch-evidence", `${id}.json`);
    const original = readFileSync(path);
    const remove = fs.rmSync;
    const blocked = mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
      if (args[0] === path) throw errno("EPERM");
      remove(...args);
    });
    syncBuiltinESMExports();
    try {
      const expected = dispatched ? "dispatch-unknown" : "resolved";
      const classify = async () => {
        const response = await f.execute("subagents_reconcile");
        const report = await f.execute("subagents_recovery", { runId: id });
        return { response, report: report.content[0].text };
      };
      const first = await classify();
      assert.equal(first.response.details.status, expected);
      assert.match(first.report, new RegExp(`${id}: ${expected} \\(EPERM\\)`));
      assert.equal(first.response.details.incidents[0].evidence, "outbox");
      const saved = store.snapshot();
      assert.ok(blocked.mock.calls.some(call => call.arguments[0] === path));
      assert.deepEqual(readFileSync(path), original);
      assert.equal(memory.has(id), false);
      assert.equal(saved.outbox[record.eventId]?.status, "handedOff");
      assert.deepEqual(Object.keys(saved.outbox), [record.eventId]);
      assert.deepEqual(saved.runs[id].eventCursor, [record.eventId]);
      assert.equal((await classify()).response.details.status, expected);
      assert.deepEqual(store.snapshot(), saved);
      if (dispatched) {
        store.reconcileRun(id, "same-run verification", true);
        const verified = await classify();
        assert.equal(verified.response.details.status, "resolved");
        assert.match(verified.report, new RegExp(`${id}: resolved \\(RUN_BOUND_VERIFICATION\\)`));
      }
      const current = store.snapshot();
      for (const changed of [{ ...record, cause: "OTHER" }, { ...record, startedAt: record.startedAt + 1 }]) {
        writeFileSync(path, JSON.stringify(changed));
        // Check the read-only view before reconciliation can install its override.
        const report = await f.execute("subagents_recovery", { runId: id });
        assert.match(report.content[0].text, new RegExp(`${id}: still-blocked \\(EVIDENCE_CONFLICT\\)`));
        assert.equal((await f.execute("subagents_reconcile")).details.status, "still-blocked");
        assert.deepEqual(store.snapshot(), current);
      }
      assert.deepEqual(f.current().tasks[0].attempts[0].results.map((result: { kind: string }) => result.kind), [dispatched ? "ping" : "failure"]);
      assert.deepEqual(f.messages, []);
    } finally { blocked.mock.restore(); syncBuiltinESMExports(); }
  } finally { await f.clean(id); }
});

test("run-bound error completion resolves dispatch proof, not task success", async () => {
  const f = fixture(), id = randomUUID();
  try {
    const store = new RuntimeStore(f.directory, f.parent), run = f.run(id);
    store.prepare(run);
    store.phase(id, "dispatch-intent");
    const memory = new Map<string, DispatchEvidence>();
    captureDispatchEvidence(memory, store, { runId: id, sessionFile: run.sessionFile, startedAt: 1, binding: run.planTask, dispatched: true }, errno("EPERM"), errno("EPERM"));
    assert.equal(reconcileDispatchEvidence(store, readDispatchEvidence(f.directory, store.snapshot(), memory), f.current(), memory).storeError, undefined);
    const base = store.snapshot(), completionId = `subagent:${id}:completion:child-entry`;
    const check = (eventId: string, owner = id, sessionFile = run.sessionFile, customType = "subagent_result", detailsId = eventId) => {
      const manifest = structuredClone(base);
      manifest.runs[id].eventCursor.push(eventId);
      manifest.outbox[eventId] = { runId: owner, status: "pending", envelope: { message: { customType, display: true, content: "Provider failed", details: { eventId: detailsId, sessionFile, exitCode: 1, errorMessage: "Provider failed" } }, options: { triggerTurn: true } } };
      return dispatchIncidents(manifest, f.current(), f.directory, readDispatchEvidence(f.directory, manifest, memory)).find(item => item.runId === id)!;
    };
    assert.equal(check(completionId).code, "RUN_BOUND_COMPLETION");
    assert.equal(check(completionId).status, "resolved");
    for (const negative of [check(`subagent:${id}:exit`), check(completionId, randomUUID()), check(completionId, id, "other-session"), check(completionId, id, run.sessionFile, "unrelated"), check(completionId, id, run.sessionFile, "subagent_result", "other-event")]) {
      assert.equal(negative.status, "dispatch-unknown");
    }
    assert.equal(f.current().tasks[0].attempts[0].results.length, 0);
    assert.notEqual(f.current().tasks[0].status, "accepted");
    assert.deepEqual(f.messages, []);
    store.close();
  } finally { await f.clean(id); }
});
