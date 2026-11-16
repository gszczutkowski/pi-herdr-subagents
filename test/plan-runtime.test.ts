import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as store from "../pi-extension/subagents/plan-store.ts";
import { PlanPersistence, PLAN_ENTRY } from "../pi-extension/subagents/plan-persistence.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { RuntimeStore, readRuntimeManifest } from "../pi-extension/subagents/runtime-store.ts";
import { releaseSession } from "../pi-extension/subagents/ownership.ts";
import { registerLiveContinuation } from "../pi-extension/subagents/live-continuation.ts";
import { contractTask, resolveAssignmentContract } from "../pi-extension/subagents/contracts.ts";

// Real native persistence, registered execute, launch builder, completion adapter
// and durable outbox. Only the Pi API host and terminal transport are mocked.
test("registered task-bound spawn, live/closed resume, failure isolation and restored canonical imports", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "plan-runtime-"));
  const savedEnv = { ...process.env };
  const originalExec = childProcess.execFile;
  let serial = 0; let dispatches = 0; let failAppend = false; let failSend = false;
  let liveSends = 0; let failPrepare = false;
  const originalWrite = fs.writeFileSync;
  mock.method(fs, "writeFileSync", (path: any, ...args: any[]) => {
    if (failPrepare && String(path).endsWith(".sh")) {
      failPrepare = false; failAppend = true;
      throw new Error("preparation failed");
    }
    return (originalWrite as any)(path, ...args);
  });
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const tools = new Map<string, any>(); const events = new Map<string, any[]>();
  const sent: any[] = []; const widgets = new Map<string, any>();
  const manifestDir = join(dir, "artifacts", sm.getSessionId(), "subagent-runtime");
  const continuationEvents = new Map<string, Function>();
  const children: any[] = [];
  let savedContract: any;
  mock.method(childProcess, "execSync", () => "herdr");
  mock.method(childProcess, "execFileSync", (_command: any, args: string[]) => {
    if (_command === "powershell.exe") return "[]";
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { root_pane: { pane_id: `pane-${++serial}` } } });
    if (args[1] === "run" && !args.some(a => a.includes("/_subagent_continue"))) {
      dispatches++;
      const manifest = readRuntimeManifest(manifestDir)!;
      const run = Object.values(manifest.runs).findLast(r => r.surface === args[2])!;
      assert.ok(run.planTask);
      assert.ok(read().tasks[0].attempts.some(a => a.runIds.includes(run.id)), "native append precedes dispatch");
      assert.equal(run.phase, "dispatch-intent");
      if (failSend) { failAppend = true; throw new Error("ambiguous transport"); }
    }
    return "";
  });
  childProcess.execFile = Object.assign(() => { throw new Error("unexpected transport"); }, {
    [promisify.custom]: async (_command: string, args: string[]) => ({ stdout: args[1] === "get" ? JSON.stringify({ result: { pane: { pane_id: args[2], agent_status: "idle" } } }) : "" }),
  }) as any;
  syncBuiltinESMExports();
  process.env.HERDR_ENV = "1"; process.env.HERDR_WORKSPACE_ID = "test";
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT"]) delete process.env[key];
  const pi: any = new Proxy({}, { get: (_, key) => key === "registerTool" ? (t: any) => tools.set(t.name, t)
    : key === "on" ? (name: string, fn: any) => events.set(name, [...(events.get(name) ?? []), fn])
    : key === "getAllTools" ? () => [] : key === "getThinkingLevel" ? () => "off"
    : key === "appendEntry" ? (type: string, data: any) => { if (type === PLAN_ENTRY && failAppend) { failAppend = false; throw new Error("injected append"); } sm.appendCustomEntry(type, data); }
    : key === "sendMessage" ? (message: any) => sent.push(message) : () => {} });
  const ctx: any = { hasUI: true, mode: "tui", scopedModels: [], cwd: dir, model: { provider: "test", id: "model" },
    ui: { setWidget: (name: string, value: any) => widgets.set(name, value), notify: () => {} },
    modelRegistry: { find: () => ({ provider: "test", id: "model", reasoning: true }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true }, sessionManager: sm };
  const { default: extension, __test__, enqueueSubagentCompletion } = await import("../pi-extension/subagents/index.ts");
  const emit = async (name: string, event = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const execute = (name: string, params: any) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  const p = new PlanPersistence((type, data) => pi.appendEntry(type, data), false);
  const read = () => p.read(sm).snapshot!;
  const mutate = (fn: any) => p.mutate(sm, read().planId, read().revision, fn);
  const selection = () => ({ planId: read().planId, taskId: read().tasks[0].taskId, attemptId: read().tasks[0].attempts.at(-1)!.attemptId, expectedRevision: read().revision });
  const result = (child: any, eventId: string) => ({ eventId, name: child.name, task: child.task, sessionFile: child.sessionFile, summary: "Tests reported", exitCode: 0, elapsed: 1 });
  extension(pi);
  try {
    await emit("session_start", { reason: "startup" });
    p.create(sm, 0, "Bound work");
    const criterionId = randomUUID();
    mutate((p: any, c: any) => store.addTask(p, c, "Implement", { criteria: [{ criterionId, text: "Verified" }] }));
    mutate((p: any, c: any) => store.startAttempt(p, c, p.tasks[0].taskId));
    await assert.rejects(execute("subagent", { name: "Stale", task: "one", cwd: dir, planTask: { ...selection(), expectedRevision: 0 } }), /Revision conflict/);
    assert.equal(dispatches, 0);
    savedContract = { ...resolveAssignmentContract(undefined, read().tasks[0]),
      files: ["src/worker.ts"], decisions: ["Keep the public API"], changeConstraints: ["Do not modify generated files"] };
    const spawned = await execute("subagent", { name: "Bound", task: "one", cwd: dir, planTask: selection(), assignmentContract: savedContract });
    const child = __test__.runningSubagents.get(spawned.details.id)!;
    children.push(child);
    assert.deepEqual(child.planTask.authority, read().authority);
    const assignmentFile = join(dir, "artifacts", sm.getSessionId(), "context", `subagent-assignment-${child.id}.json`);
    const assignment = JSON.parse(fs.readFileSync(assignmentFile, "utf8"));
    assert.deepEqual(assignment.planTask, child.planTask);
    assert.deepEqual(assignment.assignmentContract.criteria, [{ criterionId, text: "Verified" }]);
    assert.match(assignment.task, /Assignment contract/);
    assert.ok(assignment.task.includes(criterionId), "criteria reach actual model task, not only display metadata");
    const launchProfile = JSON.parse(fs.readFileSync(`${child.sessionFile}.launch-profile.json`, "utf8"));
    assert.deepEqual(launchProfile.assignmentContract, assignment.assignmentContract);
    const taskFiles = fs.readdirSync(join(dir, "artifacts", sm.getSessionId(), "context")).filter(f => f.endsWith('.md'));
    assert.ok(taskFiles.some(f => fs.readFileSync(join(dir, "artifacts", sm.getSessionId(), "context", f), "utf8").includes(criterionId)));
    assert.deepEqual(readRuntimeManifest(manifestDir)!.runs[child.id].profile?.assignmentContract, assignment.assignmentContract);
    const beforeLive = read().revision;
    child.lifecycle.process = { kind: "running", since: Date.now() } as any;
    child.lifecycle.turn = { kind: "interrupted", since: Date.now() } as any;
    const previousChildEnv = { ...process.env };
    Object.assign(process.env, { PI_SUBAGENT_ID: child.id, PI_SUBAGENT_SESSION: child.sessionFile, PI_SUBAGENT_ACTIVITY_FILE: child.activityFile });
    registerLiveContinuation({ on: (name: string, handler: Function) => continuationEvents.set(name, handler), registerCommand: () => {},
      sendUserMessage: (message: string) => { liveSends++; assert.equal(message, contractTask("follow-up", savedContract)); } } as any);
    for (const key of Object.keys(process.env)) if (!(key in previousChildEnv)) delete process.env[key];
    Object.assign(process.env, previousChildEnv);
    const continuationCtx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => child.sessionFile } };
    continuationEvents.get("session_start")!({}, continuationCtx);
    continuationEvents.get("agent_settled")!({ aborted: true }, continuationCtx);
    const liveSnapshot = structuredClone(read());
    const liveDispatches = dispatches;
    const requestFiles = () => fs.readdirSync(`${child.activityFile}.continuation`).filter(name => name.endsWith(".request.json"));
    for (const message of [undefined, "", " \n\t"]) {
      await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message }), /nonempty message/);
      assert.deepEqual(requestFiles(), [], "raw empty message never publishes a contract-only request");
      assert.equal(liveSends, 0);
      assert.equal(dispatches, liveDispatches);
      assert.deepEqual(read(), liveSnapshot);
    }
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message: "stale", planTask: { ...selection(), expectedRevision: 0 } }), /Revision conflict/);
    assert.deepEqual(read(), liveSnapshot);
    assert.equal(dispatches, liveDispatches);
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message: "redirect", planTask: { ...selection(), attemptId: randomUUID() } }), /redirect/);
    assert.deepEqual(read(), liveSnapshot);
    assert.equal(dispatches, liveDispatches);
    const profilePath = `${child.sessionFile}.launch-profile.json`;
    const assertSavedContract = (runId: string) => {
      assert.deepEqual(JSON.parse(fs.readFileSync(profilePath, "utf8")).assignmentContract, savedContract);
      assert.deepEqual(readRuntimeManifest(manifestDir)!.runs[runId].profile?.assignmentContract, savedContract);
    };
    const staleProfile = { ...launchProfile, assignmentContract: { ...savedContract, scope: "Stale scope" } };
    fs.writeFileSync(profilePath, JSON.stringify(staleProfile));
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message: "stale contract", planTask: selection() }), /scope disagrees/);
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message: "stale inherited contract" }), /scope disagrees/);
    assert.deepEqual(read(), liveSnapshot, "contract validation never fails the healthy attempt");
    assert.equal(liveSends, 0);
    fs.writeFileSync(profilePath, JSON.stringify(launchProfile));
    const continued = await execute("subagent_resume",  { sessionPath: `${dirname(child.sessionFile)}/./${basename(child.sessionFile)}`, message: "follow-up", planTask: selection() });
    assert.equal(continued.details.id, child.id);
    assert.equal(continued.details.status, "continued");
    assert.equal(read().revision, beforeLive, "idempotent attach does not append");
    assert.equal(liveSends, 1, "rejected live bindings never reach transport");
    assertSavedContract(child.id);
    continuationEvents.get("session_shutdown")!();
    const structuredResult = { status: "complete" as const, summary: "Implementation proposal", artifacts: ["report.txt"],
      checks: [{ criterionIds: [criterionId], ref: "report.txt#check", outcome: "passed" as const }], unmetCriterionIds: [], risks: [] };
    const { runCompletionFile } = await import("../pi-extension/subagents/run-artifacts.ts");
    fs.writeFileSync(runCompletionFile(child.sessionFile, child.id), JSON.stringify({ type: "done", runId: child.id,
      eventId: "turn-a", summary: "Detailed immutable assistant final text", structuredResult, keepOpen: true }));
    const deliveryDeadline = Date.now() + 5000;
    while (sent.length < 1 && Date.now() < deliveryDeadline) await new Promise(r => setTimeout(r, 25));
    assert.equal(sent.length, 1, "real watcher delivers the structured completion");
    assert.equal(sent[0].details.response, "Detailed immutable assistant final text");
    assert.match(sent[0].content, /Detailed immutable assistant final text/);
    assert.deepEqual(sent[0].details.structuredResult, structuredResult);
    assert.match(sent[0].content, /proposal, requires parent review/);
    assert.equal(read().tasks[0].evidence.length, 0);
    assert.deepEqual((readRuntimeManifest(manifestDir)!.outbox[sent[0].details.eventId].envelope.message.details as any).structuredResult, structuredResult);
    assert.equal(read().tasks[0].status, "in_review");
    assert.equal(read().tasks[0].attempts[0].results[0].eventId, sent[0].details.eventId);
    const rev = read().revision;
    enqueueSubagentCompletion(child, { ...result(child, "turn-a"), keepOpen: true });
    assert.equal(read().revision, rev);
    // A plan append fault must not suppress the actual dispatched task's result.
    failAppend = true;
    enqueueSubagentCompletion(child, { ...result(child, "turn-b"), keepOpen: true });
    assert.equal(sent.length, 2);
    assert.match(sent[1].details.resultDiagnostic, /Unstructured.*requires parent review/);
    assert.equal(readRuntimeManifest(manifestDir)!.outbox[sent[1].details.eventId].status, "handedOff");
    assert.equal(read().tasks[0].attempts[0].results.length, 1);
    p.reconcile(sm);
    await emit("before_agent_start", { systemPromptOptions: { toolGuidelines: {} } } as any);
    assert.equal(read().tasks[0].attempts[0].results.length, 2, "handed-off outbox retries task import");
    // Closed resume canonical aliases add a run, not a task/attempt.
    child.lifecycle.delivery = "suppressed";
    child.abortController?.abort();
    await new Promise(r => setTimeout(r, 50));
    child.lifecycle.delivery = "pending";
    releaseSession(child.sessionFile, child.id);
    __test__.runningSubagents.delete(child.id);
    fs.writeFileSync(child.sessionFile, JSON.stringify({ type: "session", version: 3, id: "child", cwd: dir }) + "\n");
    const beforeClosed = structuredClone(read());
    fs.writeFileSync(profilePath, JSON.stringify(staleProfile));
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message: "stale contract", planTask: selection() }), /scope disagrees/);
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, message: "stale inherited contract" }), /scope disagrees/);
    assert.deepEqual(read(), beforeClosed, "rejected contract never attaches/fails a closed run");
    fs.writeFileSync(profilePath, JSON.stringify(launchProfile));
    const resumed = await execute("subagent_resume", { sessionPath: child.sessionFile, message: "again", planTask: selection() });
    const resumedChild = __test__.runningSubagents.get(resumed.details.id)!;
    children.push(resumedChild);
    assertSavedContract(resumedChild.id);
    const resumedAssignment = JSON.parse(fs.readFileSync(join(dir, "artifacts", sm.getSessionId(), "context", `subagent-assignment-${resumedChild.id}.json`), "utf8"));
    assert.equal(resumedAssignment.task, contractTask("again", savedContract));
    assert.deepEqual(resumedAssignment.assignmentContract, savedContract);
    const resumedTaskFile = fs.readdirSync(join(dir, "artifacts", sm.getSessionId(), "context")).find(f => f.endsWith(`${resumedChild.id}.md`))!;
    assert.equal(fs.readFileSync(join(dir, "artifacts", sm.getSessionId(), "context", resumedTaskFile), "utf8"),
      contractTask("again", savedContract) + `\n\nCorrelation (report only; do not mutate the parent plan): planId=${resumedChild.planTask.planId}, taskId=${resumedChild.planTask.taskId}, attemptId=${resumedChild.planTask.attemptId}, runId=${resumedChild.id}`);
    assert.notEqual(resumedChild.id, child.id);
    assert.equal(read().tasks.length, 1); assert.equal(read().tasks[0].attempts.length, 1);
    assert.equal(read().tasks[0].attempts[0].runIds.length, 2);
    // Execute the real child tool, then let the original parent watcher consume
    // its run-bound artifact. No direct task mutation stands in for caller_ping.
    const childTools = new Map<string, any>();
    const childEvents = new Map<string, Function[]>();
    const childApi: any = new Proxy({}, { get: (_, key) => key === "registerTool" ? (t: any) => childTools.set(t.name, t)
      : key === "on" ? (name: string, fn: Function) => childEvents.set(name, [...(childEvents.get(name) ?? []), fn])
      : key === "getAllTools" ? () => [] : () => {} });
    const { default: childExtension } = await import("../pi-extension/subagents/subagent-done.ts");
    const reason = "Choose schema A or B; migration approval needed.";
    let shutdown = false;
    const childEnv = { ...process.env };
    try {
      process.env.PI_SUBAGENT_SESSION = resumedChild.sessionFile;
      process.env.PI_SUBAGENT_ID = resumedChild.id;
      process.env.PI_SUBAGENT_NAME = resumedChild.name;
      process.env.PI_SUBAGENT_ACTIVITY_FILE = resumedChild.activityFile;
      childExtension(childApi);
      const childCtx: any = { shutdown: () => { shutdown = true; }, sessionManager: SessionManager.open(resumedChild.sessionFile),
        isIdle: () => true, hasPendingMessages: () => false, hasUI: false, ui: {} };
      for (const handler of childEvents.get("before_agent_start") ?? []) await handler({}, childCtx);
      await childTools.get("caller_ping").execute("ping", { message: reason }, undefined, undefined, childCtx);
      assert.equal(shutdown, false, "a staged ping cannot close before settlement");
      for (const handler of childEvents.get("agent_settled") ?? []) await handler({ type: "agent_settled", aborted: false }, childCtx);
      for (const handler of childEvents.get("session_shutdown") ?? []) await handler({ reason: "quit" }, childCtx);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in childEnv)) delete process.env[key];
      Object.assign(process.env, childEnv);
    }
    assert.equal(shutdown, true);
    const pingDeadline = Date.now() + 5000;
    while (__test__.runningSubagents.has(resumedChild.id) && Date.now() < pingDeadline) await new Promise(r => setTimeout(r, 25));
    assert.equal(__test__.runningSubagents.has(resumedChild.id), false, "ping closes/removes the child");
    assert.equal(read().tasks[0].status, "blocked");
    assert.equal(read().tasks[0].statusReason, reason);
    const rendered = widgets.get("subagent-plan")({}, { fg: (_: string, text: string) => text }).render(200).join("\n");
    assert.match(rendered, /blocked/);
    assert.ok(rendered.includes(reason), "actual native panel retains the blocker after process removal");
    const reopenedPlan = new PlanPersistence(() => { throw new Error("read only"); }, false).restore(SessionManager.open(sm.getSessionFile()!)).snapshot!;
    assert.equal(reopenedPlan.tasks[0].statusReason, reason);
    assert.equal(reopenedPlan.tasks[0].status, "blocked");
    events.clear(); tools.clear();
    extension(pi); // Replace the parent persistence/adapter while keeping runtime custody.
    await emit("session_start", { reason: "reload" });
    assert.equal(read().tasks[0].statusReason, reason);
    const reloadedPanel = widgets.get("subagent-plan")({}, { fg: (_: string, text: string) => text }).render(200).join("\n");
    assert.ok(reloadedPanel.includes(reason), "fresh parent persistence restores the actual blocker panel");
    assert.equal(dispatches, 2, "reload never relaunches blocked work");
    const eventId = sent.at(-1).details.eventId;
    assert.equal(sent.at(-1).customType, "subagent_ping");
    assert.equal(read().tasks[0].attempts[0].results.at(-1)!.eventId, eventId);
    const pingRevision = read().revision;
    enqueueSubagentCompletion(resumedChild, { ...result(resumedChild, eventId.slice(`subagent:${resumedChild.id}:completion:`.length)), ping: { name: resumedChild.name, message: reason } });
    assert.equal(read().revision, pingRevision, "closed-child duplicate cannot clear its blocker");
    mutate((p: any, c: any) => store.submitReview(p, c, p.tasks[0].taskId, "Parent resolved schema choice; review evidence"));
    mutate((p: any, c: any) => store.addEvidence(p, c, p.tasks[0].taskId, { criterionId, ref: "Parent checked test report", resultEventId: eventId }));
    mutate((p: any, c: any) => store.accept(p, c, p.tasks[0].taskId, { [criterionId]: [p.tasks[0].evidence[0].evidenceId] }, "Verified by parent"));
    enqueueSubagentCompletion(child, { ...result(child, "late"), keepOpen: true });
    assert.equal(read().tasks[0].status, "accepted");
    enqueueSubagentCompletion(child, { ...result(child, "late-ping"), keepOpen: true, ping: { name: child.name, message: "Stale blocker" } });
    assert.equal(read().tasks[0].status, "accepted", "late ping cannot reopen an accepted task");
    const binding = child.planTask!;
    const originalLeaf = sm.getLeafId()!;
    const sourcePlan = read();
    p.detach(sm, sourcePlan.planId, sourcePlan.revision, "Wrong branch");
    const wrong = read();
    enqueueSubagentCompletion(child, { ...result(child, "wrong-branch"), keepOpen: true });
    assert.deepEqual(read(), wrong, "original authority cannot mutate detached task");
    const deferredEvent = sent.at(-1).details.eventId;
    assert.ok(readRuntimeManifest(manifestDir)!.outbox[deferredEvent]);
    sm.branch(originalLeaf);
    await emit("before_agent_start", { systemPromptOptions: { toolGuidelines: {} } } as any);
    assert.ok(read().tasks[0].attempts[0].results.some(r => r.eventId === deferredEvent));
    // Fresh persistence plus a reopened manifest retains original authority, no launch.
    const snapshot = readRuntimeManifest(manifestDir)!;
    assert.deepEqual(snapshot.runs[child.id].planTask, binding);
    const fresh = new PlanPersistence((type, data) => sm.appendCustomEntry(type, data), false);
    const beforeRestore = read().revision;
    importPlanEnvelope(fresh, ctx, snapshot.runs[child.id].planTask, child.id, snapshot.outbox[deferredEvent].envelope);
    assert.equal(read().revision, beforeRestore);
    assert.equal(dispatches, 2);
    await assert.rejects(execute("subagent_resume", { sessionPath: child.sessionFile, planTask: selection() }), /nonterminal|already owned|tracked/);
    // Failed append means no terminal dispatch. Explicit retry is parent-owned.
    mutate((p: any, c: any) => store.reopen(p, c, p.tasks[0].taskId, "Retry failure test"));
    mutate((p: any, c: any) => store.startAttempt(p, c, p.tasks[0].taskId));
    failAppend = true;
    await assert.rejects(execute("subagent", { name: "No append", task: "three", cwd: dir, planTask: selection() }), /append failed/);
    assert.equal(dispatches, 2);
    p.reconcile(sm);
    failPrepare = true;
    await assert.rejects(execute("subagent", { name: "Preparation fails", task: "four", cwd: dir, planTask: selection() }), /preparation failed/);
    assert.equal(read().tasks[0].status, "in_progress", "failed append leaves task import pending");
    assert.equal(dispatches, 2);
    p.reconcile(sm);
    await emit("before_agent_start", { systemPromptOptions: { toolGuidelines: {} } } as any);
    assert.equal(read().tasks[0].status, "failed");
    assert.match(read().tasks[0].statusReason, /before send/);
    const failureRevision = read().revision;
    await emit("before_agent_start", { systemPromptOptions: { toolGuidelines: {} } } as any);
    assert.equal(read().revision, failureRevision);
    mutate((p: any, c: any) => store.retry(p, c, p.tasks[0].taskId));
    failSend = true;
    await assert.rejects(execute("subagent", { name: "Send fails", task: "five", cwd: dir, planTask: selection() }), /ambiguous transport/);
    assert.equal(read().tasks[0].status, "in_progress");
    p.reconcile(sm);
    await emit("before_agent_start", { systemPromptOptions: { toolGuidelines: {} } } as any);
    assert.equal(read().tasks[0].status, "blocked", "ambiguous send cannot certify process failure");
    assert.match(read().tasks[0].statusReason, /Dispatch uncertain/);
  } finally {
    for (const child of children) { child.lifecycle.delivery = "suppressed"; child.abortController?.abort(); releaseSession(child.sessionFile, child.id); }
    await emit("session_shutdown", { reason: "quit" });
    for (const child of __test__.runningSubagents.values()) releaseSession(child.sessionFile, child.id);
    await new Promise(r => setTimeout(r, 50));
    childProcess.execFile = originalExec; mock.restoreAll(); syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native binding rejects wrong attempt/origin and attach is idempotent across disk restore", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "binding-restore-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
    const p = new PlanPersistence((t, d) => sm.appendCustomEntry(t, d), false);
    let plan = p.create(sm, 0, "Native");
    plan = p.mutate(sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Task"));
    plan = p.mutate(sm, plan.planId, plan.revision, (p, c) => store.startAttempt(p, c, p.tasks[0].taskId));
    const selection = { planId: plan.planId, taskId: plan.tasks[0].taskId, attemptId: plan.tasks[0].attempts[0].attemptId, expectedRevision: plan.revision };
    const binding = bindPlanRun(p, { sessionManager: sm } as any, "existing-runtime-id", selection)!;
    const disk = SessionManager.open(sm.getSessionFile()!);
    const fresh = new PlanPersistence((t, d) => disk.appendCustomEntry(t, d), false);
    const revision = fresh.read(disk).snapshot!.revision;
    assert.deepEqual(bindPlanRun(fresh, { sessionManager: disk } as any, "existing-runtime-id", undefined, binding), binding);
    assert.equal(fresh.read(disk).snapshot!.revision, revision);
    assert.throws(() => bindPlanRun(fresh, { sessionManager: disk } as any, "other", undefined, { ...binding, authority: { ...binding.authority, branchInstanceId: randomUUID() } }), /origin authority/);
    assert.throws(() => bindPlanRun(fresh, { sessionManager: disk } as any, "other", { ...selection, expectedRevision: revision, attemptId: randomUUID() }), /current nonterminal attempt/);
    // Runtime manifest survives writer close/reopen with original binding unchanged.
    const runtimeDir = join(dir, "runtime");
    const parent = { sessionFile: sm.getSessionFile()!, headerId: sm.getSessionId(), branchToken: randomUUID(), checkpoint: "test" };
    const runtime = new RuntimeStore(runtimeDir, parent);
    runtime.prepare({ id: "existing-runtime-id", sessionFile: join(dir, "child.jsonl"), name: "Child", task: "Task", startTime: Date.now(), planTask: binding });
    runtime.close();
    const reopened = new RuntimeStore(runtimeDir, parent);
    assert.deepEqual(reopened.snapshot().runs["existing-runtime-id"].planTask, binding);
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
