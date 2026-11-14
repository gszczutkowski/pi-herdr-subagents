import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineage, isLineage, sessionLineage } from "../pi-extension/subagents/lineage.ts";
import { resumeLaunchContext } from "../pi-extension/subagents/launch-profile.ts";

test("standalone and nested identities are stable, scoped by actual session, not names", () => {
  const dir = mkdtempSync(join(tmpdir(), "lineage-"));
  try {
    const entries: any[] = [];
    const manager = (id: string, file: string) => ({ getSessionId: () => id, getSessionFile: () => file, getBranch: () => entries });
    const root = manager("root-id", join(dir, "root.jsonl"));
    const childFile = join(dir, "child.jsonl");
    const lineage = createLineage(root, childFile, dir, dir, { checkpoint: "checkpoint", branchToken: "token" },
      (customType, data) => entries.push({ type: "custom", customType, data }))!;
    assert.ok(isLineage(lineage));
    assert.equal(lineage.parent.sessionId, "root-id");
    assert.equal(JSON.parse(readFileSync(childFile, "utf8")).id, lineage.child.sessionId);
    entries.push({ type: "custom", customType: "subagent-assignment", data: { lineage } });
    const child = manager(lineage.child.sessionId, childFile);
    assert.deepEqual(sessionLineage(child), lineage);
    assert.equal(sessionLineage(manager("fork-id", join(dir, "fork.jsonl"))), undefined);
    const nested = createLineage(child, join(dir, "nested.jsonl"), dir, join(dir, "other"),
      { checkpoint: "child-checkpoint", branchToken: "child-token" })!;
    assert.deepEqual(nested.root, lineage.root);
    assert.deepEqual(nested.parent, lineage.child);
    assert.equal(nested.eventDirectory, lineage.eventDirectory);
    assert.equal(nested.rootAssignmentId, lineage.rootAssignmentId);
    assert.equal(isLineage({ ...lineage, surprise: true }), false);
    assert.equal(isLineage({ ...lineage, parent: { ...lineage.parent, name: "display" } }), false);
    const context = resumeLaunchContext({ lineage, sessionFile: childFile, runtimePlan: {}, denyTools: [] } as any,
      { id: "new-run", name: "renamed", surface: "pane", artifactDir: dir, subagentsDir: dir, shellQuote: String });
    assert.deepEqual(context.lineage, lineage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
