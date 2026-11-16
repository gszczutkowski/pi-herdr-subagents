import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { registerPlanTools, planMutationReceipt } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_CONTEXT_BYTES, PLAN_CONTEXT_TYPE, planContext, registerPlanContext, summarizePlan } from "../pi-extension/subagents/plan-context.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "plan-context-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Plan work", timestamp: 1 });
  const p = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
  const events = new Map<string, Function>();
  registerPlanContext({ on: (name, handler) => events.set(name, handler) } as any, p);
  const ctx = { sessionManager: sm };
  const publication = () => events.get("before_agent_start")!({}, ctx)?.message;
  const persist = (message: any) => sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  return { sm, p, ctx, events, publication, persist, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("native compaction/reload/branch restore current state once without ordinary request-time tails", () => {
  const f = fixture(); const { sm, p } = f;
  try {
    assert.equal(f.publication(), undefined, "no routine empty-plan messages");
    let plan = p.create(sm, 0, "Current 日本語 🚀");
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, "Implementation"));
    const oldLeaf = sm.getLeafId()!;
    const initial = f.publication(); f.persist(initial);
    assert.equal(f.publication(), undefined);
    assert.equal(f.events.get("context")!({ messages: sm.buildSessionContext().messages }, f.ctx), undefined);
    sm.appendCompaction("No retained plan details", null, 10000);
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.block(s, c, s.tasks[0].taskId, "Need approval 日本語 🚀"));
    const bytes = readFileSync(sm.getSessionFile()!, "utf8");
    const native = sm.buildSessionContext().messages;
    const fallback = f.events.get("context")!({ messages: native }, f.ctx).messages;
    assert.match(fallback.at(-1).content, /revision=2/);
    assert.match(fallback.at(-1).content, /blocked.*Need approval 日本語 🚀/);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), bytes, "compaction fallback is read-only");
    assert.deepEqual(f.events.get("context")!({ messages: fallback }, f.ctx).messages, fallback);
    f.persist(f.publication());
    assert.equal(f.publication(), undefined);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    assert.equal(f.events.get("before_agent_start")!({}, { sessionManager: reopened }), undefined, "visible persisted state deduplicates after restart");
    sm.branch(oldLeaf);
    const historical = f.publication();
    assert.match(historical.content, /revision=1/); assert.match(historical.content, /read-only/); assert.doesNotMatch(historical.content, /Need approval/);
    sm.resetLeaf();
    assert.equal(f.publication(), undefined, "an empty sibling does not inherit prior publication state");
  } finally { f.cleanup(); }
});

test("bounded Unicode summary preserves access, task counts, blockers and conditional detail guidance", () => {
  const f = fixture(); const { sm, p } = f;
  try {
    let plan = p.create(sm, 0, "Unicode 🚀 日本語 ".repeat(250));
    for (let i = 0; i < 40; i++) plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, `Task ${i} 🚀 日本語 `.repeat(200)));
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.block(s, c, s.tasks[39].taskId, "Approval 🚀 日本語 ".repeat(300)));
    const text = summarizePlan(p.read(sm));
    assert.ok(Buffer.byteLength(text, "utf8") <= PLAN_CONTEXT_BYTES);
    assert.equal(text.isWellFormed(), true);
    assert.match(text, /accepted=0\/40/); assert.match(text, /blocked=1/); assert.match(text, /tasks omitted/);
    assert.match(text, /when details are needed/); assert.doesNotMatch(text, /Read plan_read\(\{\}\)/);
    assert.match(text, new RegExp(plan.tasks[39].taskId));
    const child = new PlanPersistence(() => assert.fail("No writes"), true);
    assert.match(summarizePlan(child.read(sm)), /read-only/);
    assert.match(summarizePlan({ ...p.read(sm), writable: false, detachRequired: "foreign", error: "Foreign inherited plan" }), /read-only; foreign copy requires explicit detach/);
    assert.equal(planContext({ writable: false, recoveryUncertain: [], error: "Child sessions cannot write parent plans" }), undefined);
    assert.doesNotMatch(planContext({ ...p.read(sm), error: "Plan append failed; durability uncertain" })!, new RegExp(plan.planId));
  } finally { f.cleanup(); }
});

test("50-task single-change receipt is at least 70% smaller and retains full UI details", async () => {
  const f = fixture(); const prior = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  try {
    const tools = new Map<string, any>();
    const persistence = registerPlanTools({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
      appendEntry: (type, data) => f.sm.appendCustomEntry(type, data) } as any);
    let plan = persistence.create(f.sm, 0, "Benchmark");
    for (let i = 0; i < 50; i++) plan = persistence.mutate(f.sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, `Task ${i}`));
    const result = await tools.get("plan_update").execute("id", { expectedRevision: plan.revision,
      command: { action: "status", planId: plan.planId, taskId: plan.tasks[0].taskId, transition: "block", reason: "Need review" } }, undefined, undefined, f.ctx);
    const receipt = JSON.parse(result.content[0].text);
    assert.equal(receipt.revision, 51); assert.equal(receipt.tasks.length, 1);
    assert.equal(receipt.tasks[0].taskId, plan.tasks[0].taskId); assert.equal(receipt.tasks[0].status, "blocked");
    assert.equal(result.details.tasks.length, 50); assert.equal(result.details.tasks[0].statusReason, "Need review");
    const oldBytes = Buffer.byteLength(JSON.stringify({ planId: result.details.planId, revision: result.details.revision, authority: result.details.authority, tasks: result.details.tasks }, null, 2));
    const newBytes = Buffer.byteLength(result.content[0].text);
    assert.ok(newBytes <= oldBytes * 0.3, `${newBytes}/${oldBytes} bytes`);
    console.log(`50-task receipt: ${oldBytes} -> ${newBytes} bytes (${(100 * (1 - newBytes / oldBytes)).toFixed(1)}% smaller)`);
    assert.equal(PLAN_CONTEXT_TYPE, "pi-subagents-plan-context/v1");
  } finally {
    for (const [i, name] of ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"].entries()) { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; }
    f.cleanup();
  }
});

test("mutation receipts expose every generated task, attempt, criterion/artifact and evidence ID", () => {
  const authority = { sessionId: "s", branchInstanceId: "b" };
  let plan = store.createPlan("IDs", authority);
  const ctx = () => ({ ...authority, expectedRevision: plan.revision });
  const criterion = store.createCriterion("Verified"), artifact = store.createArtifact("test/report.md");
  let previous = plan;
  plan = store.addTask(plan, ctx(), "Task", { criteria: [criterion], artifacts: [artifact] });
  let receipt = planMutationReceipt(plan, previous);
  assert.equal(receipt.tasks[0].taskId, plan.tasks[0].taskId);
  assert.deepEqual(receipt.tasks[0].criterionIds, [criterion.criterionId]);
  assert.deepEqual(receipt.tasks[0].artifactIds, [artifact.artifactId]);
  previous = plan; plan = store.startAttempt(plan, ctx(), plan.tasks[0].taskId);
  receipt = planMutationReceipt(plan, previous);
  assert.deepEqual(receipt.tasks[0].attemptIds, [plan.tasks[0].attempts[0].attemptId]);
  previous = plan; plan = store.addEvidence(plan, ctx(), plan.tasks[0].taskId, { criterionId: criterion.criterionId, ref: "test/report.md", artifactId: artifact.artifactId });
  receipt = planMutationReceipt(plan, previous);
  assert.deepEqual(receipt.tasks[0].evidenceIds, [plan.tasks[0].evidence[0].evidenceId]);
  assert.deepEqual(receipt.tasks[0].attemptIds, []);
  assert.deepEqual(planMutationReceipt(plan, plan).tasks, []);
});

test("a complete review/evidence/acceptance command sequence uses receipt IDs, with unchanged CAS/authority errors", async () => {
  const f = fixture();
  const prior = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  try {
    const tools = new Map<string, any>();
    registerPlanTools({ on() {}, registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
      appendEntry: (type, data) => f.sm.appendCustomEntry(type, data) } as any);
    const invoke = async (command: any, expectedRevision: number) => JSON.parse((await tools.get("plan_update").execute("id", { command, expectedRevision }, undefined, undefined, f.ctx)).content[0].text);
    await tools.get("plan_read").execute("read", {}, undefined, undefined, f.ctx); // read-first contract
    let receipt = await invoke({ action: "create", title: "Receipt workflow" }, 0);
    const planId = receipt.planId, authority = receipt.authority;
    const criterion = store.createCriterion("Parent verifies a passing check");
    receipt = await invoke({ action: "add", planId, title: "Implementation", details: { criteria: [criterion] } }, receipt.revision);
    const taskId = receipt.tasks[0].taskId;
    receipt = await invoke({ action: "attempt", planId, taskId, mode: "start" }, receipt.revision);
    const attemptId = receipt.tasks[0].attemptIds[0];
    receipt = await invoke({ action: "run", planId, taskId, attemptId, runId: "synthetic-run" }, receipt.revision);
    const result = { eventId: "synthetic-event", runId: "synthetic-run", ref: "test/synthetic.md" };
    await assert.rejects(invoke({ action: "result", planId, taskId, attemptId, origin: { ...authority, sessionId: "foreign" }, result }, receipt.revision), /authority mismatch/);
    receipt = await invoke({ action: "result", planId, taskId, attemptId, origin: authority, result }, receipt.revision);
    assert.equal(receipt.tasks[0].status, "in_review");
    await assert.rejects(invoke({ action: "accept", planId, taskId, criteria: {}, reason: "No evidence yet" }, receipt.revision), /Map ALL criteria/);
    receipt = await invoke({ action: "evidence", planId, taskId, evidence: { criterionId: criterion.criterionId, ref: "test/synthetic.md#passed", resultEventId: result.eventId } }, receipt.revision);
    const evidenceId = receipt.tasks[0].evidenceIds[0];
    receipt = await invoke({ action: "accept", planId, taskId, criteria: { [criterion.criterionId]: [evidenceId] }, reason: "Parent verified the evidence" }, receipt.revision);
    assert.equal(receipt.tasks[0].status, "accepted");
    await assert.rejects(invoke({ action: "edit", planId, taskId, patch: { title: "Stale edit" } }, 0), /Revision conflict/);
    receipt = await invoke({ action: "edit", planId, taskId, patch: { title: "Revised definition" } }, receipt.revision);
    assert.equal(receipt.tasks[0].status, "in_review", "definition edits still invalidate acceptance");
  } finally {
    for (const [i, name] of ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"].entries()) { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; }
    f.cleanup();
  }
});
