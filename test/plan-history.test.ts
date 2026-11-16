import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as store from "../pi-extension/subagents/plan-store.ts";

test("imports require exactly one attempt per in_progress history entry", () => {
  const authority = { sessionId: "parent", branchInstanceId: "branch" };
  let plan = store.addTask(store.createPlan("Plan", authority), { ...authority, expectedRevision: 0 }, "Task");
  const ctx = () => ({ ...plan.authority, expectedRevision: plan.revision });
  const id = plan.tasks[0].taskId;
  const rejects = (input: unknown) => assert.throws(() => store.deserializePlan(JSON.stringify(input)), /Attempt history mismatch/);
  const surplus = JSON.parse(store.serializePlan(plan));
  surplus.tasks[0].attempts.push({ attemptId: randomUUID(), runIds: [], results: [] });
  rejects(surplus);

  plan = store.startAttempt(plan, ctx(), id);
  const started = JSON.parse(store.serializePlan(plan));
  started.tasks[0].attempts = [];
  rejects(started);
  plan = store.submitReview(plan, ctx(), id, "Review first attempt");
  plan = store.retry(plan, ctx(), id);
  plan = store.block(plan, ctx(), id, "Waiting");
  plan = store.retry(plan, ctx(), id);
  plan = store.submitReview(plan, ctx(), id, "Review retry");
  plan = store.reject(plan, ctx(), id, "Needs work");
  plan = store.retry(plan, ctx(), id);
  plan = store.submitReview(plan, ctx(), id, "Final review");
  assert.equal(plan.tasks[0].attempts.length, 4);
  assert.deepEqual(store.deserializePlan(store.serializePlan(plan)), plan);
  const missing = JSON.parse(store.serializePlan(plan));
  missing.tasks[0].attempts.pop();
  rejects(missing);
  const extra = JSON.parse(store.serializePlan(plan));
  extra.tasks[0].attempts.push({ attemptId: randomUUID(), runIds: [], results: [] });
  rejects(extra);
  const missingStart = JSON.parse(store.serializePlan(plan));
  missingStart.tasks[0].statusHistory.splice(1, 1); // pending -> review is otherwise legal.
  rejects(missingStart);
  plan = store.detachPlan(plan, { sessionId: "copy", branchInstanceId: "copy" }, "entry", "Independent work");
  const inheritedMissing = JSON.parse(store.serializePlan(plan));
  inheritedMissing.tasks[0].attempts = [];
  rejects(inheritedMissing);
});

test("attempt history roundtrips manual review, edits, reopen and repeated detach without live ownership", () => {
  let plan = store.createPlan("Plan", { sessionId: "parent", branchInstanceId: "branch" });
  const ctx = () => ({ ...plan.authority, expectedRevision: plan.revision });
  const roundtrip = () => assert.deepEqual(store.deserializePlan(store.serializePlan(plan)), plan);
  const criterion = store.createCriterion("Proof");
  plan = store.addTask(plan, ctx(), "Task", { criteria: [criterion] });
  const id = plan.tasks[0].taskId;
  plan = store.addEvidence(plan, ctx(), id, { criterionId: criterion.criterionId, ref: "proof" });
  const mapping = { [criterion.criterionId]: [plan.tasks[0].evidence[0].evidenceId] };
  plan = store.block(plan, ctx(), id, "Manual work waiting");
  plan = store.submitReview(plan, ctx(), id, "Manual review");
  plan = store.accept(plan, ctx(), id, mapping, "Checked manually");
  plan = store.editTask(plan, ctx(), id, { title: "Edited task" });
  roundtrip();
  assert.equal(plan.tasks[0].attempts.length, 0);
  plan = store.accept(plan, ctx(), id, mapping, "Rechecked");
  plan = store.reopen(plan, ctx(), id, "More work");
  plan = store.startAttempt(plan, ctx(), id);
  // Legacy attempts without origin are supported and gain provenance on detach.
  const legacy = JSON.parse(store.serializePlan(plan));
  delete legacy.tasks[0].attempts[0].origin;
  plan = store.deserializePlan(JSON.stringify(legacy));
  for (const branch of ["copy-a", "copy-b"]) {
    plan = store.detachPlan(plan, { sessionId: branch, branchInstanceId: branch }, "entry", "Independent work");
    assert.equal(plan.tasks[0].status, "blocked");
    assert.equal(plan.tasks[0].attempts.length, 1);
    roundtrip();
  }
  plan = store.retry(plan, ctx(), id);
  assert.equal(plan.tasks[0].attempts.length, 2);
  roundtrip();
  plan = store.submitReview(plan, ctx(), id, "Review");
  plan = store.accept(plan, ctx(), id, mapping, "Checked");
  plan = store.editTask(plan, ctx(), id, { scope: "Updated scope" });
  plan = store.accept(plan, ctx(), id, mapping, "Checked edit");
  plan = store.reopen(plan, ctx(), id, "Start again");
  roundtrip();
  plan = store.startAttempt(plan, ctx(), id);
  assert.equal(plan.tasks[0].attempts.length, 3);
  roundtrip();
});

test("imports reject impossible lifecycle and decision histories without rejecting command snapshots", () => {
  const authority = { sessionId: "parent", branchInstanceId: "branch" };
  let plan = store.createPlan("Plan", authority);
  const ctx = () => ({ ...authority, expectedRevision: plan.revision });
  const criterion = store.createCriterion("Proof");
  plan = store.addTask(plan, ctx(), "Task", { criteria: [criterion] });
  const id = plan.tasks[0].taskId;
  plan = store.submitReview(plan, ctx(), id, "Ready");
  plan = store.addEvidence(plan, ctx(), id, { criterionId: criterion.criterionId, ref: "proof" });
  plan = store.accept(plan, ctx(), id, { [criterion.criterionId]: [plan.tasks[0].evidence[0].evidenceId] }, "Checked");
  const accepted = plan;
  const corrupt = [
    p => { p.tasks[0].decisions[0].revision = -1; },
    p => { p.tasks[0].statusHistory = [p.tasks[0].statusHistory.at(-1)]; },
    p => { p.tasks[0].statusHistory[1].revision = 0; },
    p => { p.tasks[0].statusHistory[1].revision = p.tasks[0].statusHistory[0].revision; },
    p => { p.tasks[0].statusHistory[1].status = "cancelled"; },
    p => { p.tasks[0].decisions = []; },
    p => { p.tasks[0].decisions[0].revision--; },
    p => { p.tasks[0].decisions[0].kind = "invalidate"; },
    p => { p.tasks[0].decisions[0].reason = "Mismatch"; },
    p => { p.tasks[0].decisions[0].criteria = {}; },
  ];
  for (const mutate of corrupt) {
    const input = JSON.parse(store.serializePlan(accepted));
    mutate(input);
    assert.throws(() => store.deserializePlan(JSON.stringify(input)));
  }
  plan = store.editTask(plan, ctx(), id, { criteria: [store.createCriterion("New criterion")] });
  assert.deepEqual(store.deserializePlan(store.serializePlan(plan)), plan);
  const emptyHistoricalDecision = JSON.parse(store.serializePlan(plan));
  emptyHistoricalDecision.tasks[0].decisions[0].criteria = {};
  assert.throws(() => store.deserializePlan(JSON.stringify(emptyHistoricalDecision)), /acceptance/);
  const input = JSON.parse(store.serializePlan(plan));
  input.tasks[0].decisions.pop();
  assert.throws(() => store.deserializePlan(JSON.stringify(input)), /decision/i);
  plan = store.reject(plan, ctx(), id, "Not ready");
  plan = store.retry(plan, ctx(), id);
  plan = store.cancel(plan, ctx(), id, "Stop");
  plan = store.reopen(plan, ctx(), id, "Resume");
  assert.deepEqual(store.deserializePlan(store.serializePlan(plan)), plan);
});
