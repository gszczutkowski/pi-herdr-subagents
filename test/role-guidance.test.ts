import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const plan = read("pi-extension/subagents/plan-skill.md");

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
