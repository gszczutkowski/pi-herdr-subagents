import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAssignmentContract, contractTask, isAssignmentContract } from "../pi-extension/subagents/contracts.ts";

test("optional assignment is bounded, strict and never silently disagrees with bound definitions", () => {
  assert.equal(resolveAssignmentContract(undefined), undefined);
  assert.equal(contractTask("plain"), "plain");
  const task: any = { title: "Objective", scope: "Scope", criteria: [{ criterionId: "c", text: "Verify" }], dependencies: ["d"], artifacts: [{ ref: "input.md" }] };
  const c = resolveAssignmentContract(undefined, task)!;
  assert.ok(isAssignmentContract(c));
  assert.match(contractTask("work", c), /Verify/);
  assert.throws(() => resolveAssignmentContract({ ...c, scope: "other" }, task), /scope disagrees/);
  assert.throws(() => resolveAssignmentContract({ ...c, accepted: true }), /Invalid bounded/);
  assert.throws(() => resolveAssignmentContract({ ...c, files: Array(101).fill("f") }), /Invalid bounded/);
  assert.deepEqual(resolveAssignmentContract({ ...c, changeConstraints: ["Do not merge"] }, task)?.changeConstraints, ["Do not merge"]);
});
