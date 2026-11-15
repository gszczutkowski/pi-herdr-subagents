import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const plan = read("pi-extension/subagents/plan-skill.md");

test("planning sizes tasks by verifiable outcomes rather than elapsed minutes", () => {
  for (const text of [read("agents/planner.md"), plan]) {
    assert.match(text, /coherent, verifiable units of work/);
    assert.match(text, /meaningful outcome/);
    assert.match(text, /scope, dependencies, and acceptance evidence/);
    assert.match(text, /implementation and (?:its )?tests together/);
    assert.doesNotMatch(text, /2[-–]5 minutes|2[-–]5.minute/i);
  }
});

test("commits require policy permission and user authorization, preserving per-point requests", () => {
  const worker = read("agents/worker.md");
  for (const text of [worker, plan]) {
    assert.match(text, /project policy/);
    assert.match(text, /user(?:'s instructions authorize| authorization)/);
    assert.match(text, /explicit request for per-point commits/);
    assert.match(text, /alone (?:does not authorize a commit|is not authorization)/);
    assert.match(text, /leave changes uncommitted/);
    assert.match(text, /conflict before committing/);
  }
  assert.doesNotMatch(plan, /Every todo has a polished commit/);
  assert.match(worker, /skill is unavailable, follow the project's commit conventions/);
});

test("handoffs use accessible artifact paths and targeted context instead of report pastes", () => {
  assert.match(plan, /artifact paths plus targeted summaries/);
  assert.match(plan, /absolute paths when working directories differ/);
  assert.match(plan, /verify recipient access/);
  assert.match(plan, /necessary excerpt or request access/);
  assert.equal((plan.match(/Scout context path:/g) ?? []).length, 3);
  assert.doesNotMatch(plan, /\[paste scout/);
  for (const role of ["scout", "reviewer", "planner", "worker", "visual-tester"]) {
    assert.match(read(`agents/${role}.md`), /targeted summar/);
  }
  assert.match(read("agents/planner.md"), /parent saves it and forwards its path/);
});

test("parallel code changes require worktree isolation and integrated verification", () => {
  for (const text of [plan, read("agents/planner.md"), read("agents/worker.md")]) {
    assert.match(text, /sequential.*shared repository/);
    assert.match(text, /(?:different files|different files;)/);
    assert.match(text, /separate isolated git worktrees/);
    assert.match(text, /branch/);
    assert.match(text, /explicit working director/);
    assert.match(text, /designated integration owner/);
    assert.match(text, /dependency order/);
    assert.match(text, /resolve(?:s)? conflicts/);
    assert.match(text, /combined tests and review on the integrated tree/);
  }
  assert.match(read("agents/worker.md"), /Verify your assigned worktree and branch before editing/);
  assert.match(read("agents/worker.md"), /report the blocker before modifying files/);
  assert.match(plan, /Without isolation and an integration stage, stay sequential/);
});

// These are instruction contracts, not runtime permission/sandbox tests.
test("read-only roles return reports for parent persistence without code edits", () => {
  for (const role of ["scout", "reviewer"]) {
    const text = read(`agents/${role}.md`);
    assert.match(text, /^tools: read, bash\r?$/m);
    assert.doesNotMatch(text, /Use the `write` tool/);
    assert.match(text, /final response/);
    assert.match(text, /parent saves/i);
    assert.match(text, /shell redirection/);
    assert.match(text, /Do not claim the report was saved yourself/);
  }
  assert.match(read("agents/scout.md"), /Do NOT modify any files/);
  assert.match(read("agents/reviewer.md"), /Do NOT modify any code, including through bash/);
  assert.match(read("agents/reviewer.md"), /do not apply fixes or commit/);
  assert.match(plan, /save their final response at the assigned path using the parent's `write` tool/);
  assert.match(plan, /Save its final findings.*with `write`/);
  assert.match(plan, /Save the review response.*with `write`/);
  assert.doesNotMatch(plan, /Save your findings to:/);
});

test("planning requires an explicit parent cleanup decision after results and before completion", () => {
  assert.match(plan, /After receiving a subagent result and before reporting done/);
  assert.match(plan, /review the current plan and concrete remaining actions for each owned idle child/);
  assert.match(plan, /Preserve its result first/);
  assert.match(plan, /no pending review, fixes, retry or other follow-up needs that child/);
  assert.match(plan, /use `subagent_close` with its owned id/);
  assert.match(plan, /record that reason in the plan or final handoff/);
  assert.match(plan, /missing plan or task binding alone does not authorize closure/);
  assert.match(plan, /user-managed interactive sessions require user authorization/);
  assert.match(plan, /unsent-draft, pending-input, ownership and branch\/custody guards/);
  assert.match(plan, /Never bypass them with force-kill, terminal typing or interruption/);
  assert.match(plan, /unavailable or returns rejected, pending or uncertain/);
  assert.match(plan, /explicit recheck must use the same id, not a polling loop/);
  assert.match(plan, /not background automatic cleanup/);
  assert.match(plan, /7\. ✅ Every owned idle subagent closed via `subagent_close`, retained with a concrete reason, or reported with unresolved close status/);
});
