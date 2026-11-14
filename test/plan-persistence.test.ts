import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PlanPersistence, PLAN_ENTRY } from "../pi-extension/subagents/plan-persistence.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "plan-persistence-"));
  const sm = SessionManager.create(dir, dir);
  const persistence = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
  return { dir, sm, persistence, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function conversation(sm: SessionManager) { return sm.appendMessage({ role: "user", content: "Plan work", timestamp: Date.now() }); }
function add(p: PlanPersistence, sm: SessionManager, plan: store.PlanSnapshot, title = "Task") {
  return p.mutate(sm, plan.planId, plan.revision, (current, ctx) => store.addTask(current, ctx, title));
}

test("native session close/reopen, reload, compaction and resume preserve immutable task snapshots", () => {
  const { sm, persistence: p, cleanup } = fixture();
  try {
    assert.throws(() => p.create(sm, 0, "Unflushed"), /durable session/);
    conversation(sm);
    let plan = p.create(sm, 0, "Plan");
    plan = add(p, sm, plan);
    const taskId = plan.tasks[0].taskId;
    plan = p.mutate(sm, plan.planId, plan.revision, (current, ctx) => store.startAttempt(current, ctx, taskId));
    const snapshotEntry = sm.getLeafId()!;
    const reopened = SessionManager.open(sm.getSessionFile()!);
    const reload = new PlanPersistence((type, data) => { reopened.appendCustomEntry(type, data); }, false);
    assert.deepEqual(reload.restore(reopened).snapshot, plan);
    assert.deepEqual(reload.read(reopened).recoveryUncertain, [taskId]);
    assert.equal(reload.read(reopened).snapshot?.tasks[0].status, "in_progress");
    assert.ok(Object.isFrozen(reload.read(reopened).snapshot?.tasks[0]));
    assert.throws(() => reload.mutate(reopened, plan.planId, plan.revision, (s, c) => store.accept(s, c, taskId, {}, "No proof")), /in_review/);
    reopened.appendCompaction("Compacted", snapshotEntry, 1000);
    assert.deepEqual(reload.restore(reopened).snapshot, plan);
    assert.deepEqual(new PlanPersistence(() => {}, false).restore(SessionManager.open(reopened.getSessionFile()!)).snapshot, plan);
    assert.ok(readFileSync(sm.getSessionFile()!, "utf8").includes(PLAN_ENTRY));
  } finally { cleanup(); }
});

test("ephemeral/setup-only sessions cannot promise persistence; unknown schema never resets", () => {
  const { sm, persistence: p, cleanup } = fixture();
  try {
    const ephemeral = SessionManager.inMemory();
    conversation(ephemeral);
    assert.throws(() => p.create(ephemeral, 0, "Ephemeral"), /durable session/);
    sm.appendCustomEntry("setup", {});
    assert.equal(existsSync(sm.getSessionFile()!), false);
    assert.throws(() => p.create(sm, 0, "Setup only"), /durable session/);
    conversation(sm);
    const plan = p.create(sm, 0, "Plan");
    sm.appendCustomEntry("pi-subagents-plan/v99", { future: true });
    assert.match(p.restore(sm).error!, /Unsupported.*schema/);
    assert.throws(() => p.create(sm, 0, "Must not reset"), /schema/);
    assert.throws(() => add(p, sm, plan), /schema/);
    assert.throws(() => p.reconcile(sm), /schema/);
  } finally { cleanup(); }
});

test("revision and trusted child authority prevent writes; result origin is branch bound", () => {
  const { sm, persistence: p, cleanup } = fixture();
  try {
    conversation(sm);
    let plan = p.create(sm, 0, "Plan");
    const old = plan;
    plan = add(p, sm, plan);
    assert.throws(() => add(p, sm, old), /Revision conflict/);
    const child = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, true);
    assert.throws(() => add(child, sm, plan), /Child/);
    assert.throws(() => p.mutate(sm, plan.planId, plan.revision, s => s, { ...plan.authority, branchInstanceId: "another" }), /origin authority/);
    assert.equal(p.read(sm).snapshot?.revision, 1);
  } finally { cleanup(); }
});

test("real native disk append failure latches writes across reload until reopened reconciliation", () => {
  const { sm, persistence: p, cleanup } = fixture();
  try {
    conversation(sm);
    const plan = p.create(sm, 0, "Plan");
    const file = sm.getSessionFile()!;
    const backup = `${file}.backup`;
    renameSync(file, backup);
    mkdirSync(file); // appendFileSync fails on a directory, after advancing Pi's memory.
    assert.throws(() => add(p, sm, plan), /append failed/);
    rmSync(file, { recursive: true });
    renameSync(backup, file);
    const reload = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
    assert.throws(() => add(reload, sm, plan), /writes disabled/);
    assert.throws(() => reload.reconcile(sm), /ahead of disk/);
    const reopened = SessionManager.open(file);
    const clean = new PlanPersistence((type, data) => { reopened.appendCustomEntry(type, data); }, false);
    assert.equal(clean.read(reopened).writable, false);
    assert.equal(clean.reconcile(reopened).writable, true);
    assert.equal(add(clean, reopened, plan).revision, 1);
  } finally { cleanup(); }
});

test("registered tools execute bounded command API, not snapshot replacement", async () => {
  const { sm, cleanup } = fixture();
  const prior = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  try {
    conversation(sm);
    const tools = new Map<string, any>();
    const events = new Map<string, Function>();
    registerPlanTools({ registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => events.set(name, fn), appendEntry: (type, data) => sm.appendCustomEntry(type, data) } as any);
    const ctx = { sessionManager: sm };
    const invoke = async (command: any, expectedRevision: number) => (await tools.get("plan_update").execute("call", { command, expectedRevision }, undefined, undefined, ctx)).details;
    const created = await invoke({ action: "create", title: "Plan" }, 0);
    const criterion = store.createCriterion("Verified");
    let result = await invoke({ action: "add", planId: created.planId, title: "Task", details: { criteria: [criterion] } }, 0);
    const taskId = result.tasks[0].taskId;
    const update = async (cmd: any) => { result = await invoke({ planId: created.planId, taskId, ...cmd }, result.revision); };
    await update({ action: "edit", patch: { scope: "Bounded" } });
    await update({ action: "attempt", mode: "start" });
    const attemptId = result.tasks[0].attempts[0].attemptId;
    await update({ action: "run", attemptId, runId: "run" });
    await update({ action: "result", attemptId, origin: result.authority, result: { eventId: "event", runId: "run", ref: "report" } });
    await update({ action: "evidence", evidence: { criterionId: criterion.criterionId, ref: "Proof", resultEventId: "event" } });
    await update({ action: "accept", criteria: { [criterion.criterionId]: [result.tasks[0].evidence[0].evidenceId] }, reason: "Checked" });
    assert.equal(result.tasks[0].status, "accepted");
    await update({ action: "status", transition: "reopen", reason: "New work" });
    await assert.rejects(() => invoke({ action: "edit", planId: created.planId, taskId, patch: { status: "accepted" } }, result.revision), /bounded/);
    await assert.rejects(() => invoke({ action: "add", planId: created.planId, title: "x".repeat(8193) }, result.revision), /bounded/);
    events.get("session_start")!({ reason: "reload" }, ctx);
    const read = await tools.get("plan_read").execute("read", { taskId }, undefined, undefined, ctx);
    assert.equal(read.details.snapshot.revision, result.revision);
  } finally {
    for (const [i, name] of ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"].entries()) { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; }
    cleanup();
  }
});

test("actual Pi lifecycle bindings and model-issued plan tools persist through a real session", async () => {
  const { dir, sm, cleanup } = fixture();
  const prior = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const errors: unknown[] = [];
    let requests = 0;
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [registerPlanTools, pi => {
        pi.registerProvider("plan-test", {
          baseUrl: "https://example.invalid", apiKey: "test", api: "plan-test-api",
          models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model) {
            const first = requests++ === 0;
            const message: any = {
              role: "assistant", content: first ? [{ type: "toolCall", id: "create-plan", name: "plan_update", arguments: { expectedRevision: 0, command: { action: "create", title: "Runtime plan" } } }] : [{ type: "text", text: "Persisted" }],
              provider: model.provider, model: model.id, api: model.api, stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: sm }));
    const model = session.extensionRunner!.getModelRegistry().find("plan-test", "model");
    assert.ok(model);
    await session.setModel(model);
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.prompt("Create a durable plan");
    assert.equal(requests, 2);
    assert.deepEqual(errors, []);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    const view = new PlanPersistence(() => {}, false).restore(reopened);
    assert.equal(view.snapshot?.title, "Runtime plan");
    assert.equal(view.snapshot?.authority.sessionId, sm.getSessionId());
  } finally {
    session?.dispose();
    for (const [i, name] of ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"].entries()) { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; }
    cleanup();
  }
});
