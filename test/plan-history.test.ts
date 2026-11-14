import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "../pi-extension/subagents/plan-store.ts";

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
