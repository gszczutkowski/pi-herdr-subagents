import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlan, addTask, attachRun, serializePlan, deserializePlan } from "../pi-extension/subagents/plan-store.ts";

const authority = { sessionId: "parent", branchInstanceId: "branch-a" };
const context = (plan: { revision: number }) => ({ ...authority, expectedRevision: plan.revision });
test("stable UUID identities, existing runtime reference, immutable serialization", () => {
  const empty = createPlan("Same title", authority);
  let plan = addTask(empty, context(empty), "Same title");
  plan = addTask(plan, context(plan), "Same title");
  assert.notEqual(plan.tasks[0].taskId, plan.tasks[1].taskId);
  assert.notEqual(plan.planId, createPlan("Same title", authority).planId);
  plan = attachRun(plan, context(plan), plan.tasks[0].taskId, "existing-runtime-id");
  assert.deepEqual(plan.tasks[0].runIds, ["existing-runtime-id"]);
  assert.deepEqual(deserializePlan(serializePlan(plan)), plan);
  assert.equal(empty.tasks.length, 0);
  assert.ok(Object.isFrozen(plan.tasks[0]));
  assert.throws(() => addTask(plan, context(empty), "stale"), /Revision/);
  assert.throws(() => addTask(plan, { ...context(plan), branchInstanceId: "other" }, "bad"), /authority/);
  assert.throws(() => deserializePlan(serializePlan(plan).replace('"schemaVersion":1', '"schemaVersion":2')), /schema/);
});
