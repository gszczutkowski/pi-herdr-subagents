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
