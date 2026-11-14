import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSummary, historyAnchors, readHistory, recordHistory, registerPlanHistory } from "../pi-extension/subagents/history.ts";
import { createLineage, LINEAGE_ASSIGNMENT } from "../pi-extension/subagents/lineage.ts";

test("atomic immutable bounded descendant records are filtered by root native active branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  try {
    const branch: any[] = [{ type: "custom", id: "cp", customType: "subagent-custody", data: { branchToken: "token" } }];
    const sm = { getSessionId: () => "root", getSessionFile: () => join(dir, "root.jsonl"), getBranch: () => branch };
    const lineage = createLineage(sm, join(dir, "child.jsonl"), dir, dir, { checkpoint: "cp", branchToken: "token" },
      (customType, data) => branch.push({ type: "custom", customType, data }))!;
    assert.equal(recordHistory(lineage, "run", "assignment", "界".repeat(1000), "source"), true);
    assert.equal(recordHistory(lineage, "run", "assignment", "replacement", "source"), false);
    const nested = { ...lineage, parent: lineage.child, child: { sessionId: "nested", sessionFile: join(dir, "nested.jsonl") } };
    assert.equal(recordHistory(nested, "nested-run", "result", "Explicit result", "nested-result", [nested.child.sessionFile]), true);
    recordHistory({ ...lineage, rootAssignmentId: "foreign-assignment" }, "foreign", "result", "must not ingest", "other");
    const events = readHistory(historyAnchors(sm));
    assert.equal(events.length, 2);
    assert.ok(Buffer.byteLength(events[0].summary, "utf8") <= 320);
    assert.equal(events.find(e => e.runId === "nested-run")?.lineage.parent.sessionId, lineage.child.sessionId);
    assert.equal(readdirSync(lineage.eventDirectory).some(n => n.endsWith(".tmp")), false);
    writeFileSync(join(lineage.eventDirectory, `${"a".repeat(64)}.json`), '{"partial":');
    assert.equal(readHistory(historyAnchors(sm)).length, 2);
    branch.splice(branch.findIndex(e => e.customType === LINEAGE_ASSIGNMENT), 1);
    assert.equal(readHistory(historyAnchors(sm)).length, 0);
    assert.equal(boundedSummary("\x1b\nhello\t world"), "hello world");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("authoritative plan subscription records transitions and decisions without report copies or model API", () => {
  let listener: any;
  let plan: any = { planId: "plan", authority: { branchInstanceId: "branch" }, revision: 0, tasks: [] };
  const persistence: any = { subscribe: (fn: any) => { listener = fn; return () => {}; }, read: () => ({ writable: true, snapshot: plan }) };
  const dir = mkdtempSync(join(tmpdir(), "history-plan-"));
  try {
    const branch: any[] = [{ type: "custom", id: "cp", customType: "subagent-custody", data: { branchToken: "token" } }];
    const sm = { getSessionId: () => "root", getSessionFile: () => join(dir, "root.jsonl"), getBranch: () => branch };
    createLineage(sm, join(dir, "child.jsonl"), dir, dir, { checkpoint: "cp", branchToken: "token" },
      (customType, data) => branch.push({ type: "custom", customType, data }));
    registerPlanHistory(persistence);
    listener(sm); // restoration does not fabricate decisions
    plan = { ...plan, revision: 1, tasks: [{ taskId: "task", attempts: [{ runIds: ["run"] }],
      statusHistory: [{ revision: 1, status: "accepted", reason: "Verified tests" }],
      decisions: [{ revision: 1, kind: "accept", reason: "Criterion evidence checked" }], fullReport: "NEVER COPY" }] };
    listener(sm); listener(sm);
    const events = readHistory(historyAnchors(sm));
    assert.deepEqual(events.map(e => e.kind).sort(), ["decision", "state"]);
    assert.equal(JSON.stringify(events).includes("NEVER COPY"), false);
    assert.equal(events[0].refs.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
