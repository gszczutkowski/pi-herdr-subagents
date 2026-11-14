import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineage, isLineage, sessionLineage } from "../pi-extension/subagents/lineage.ts";
import { persistLaunchProfile, readPiLaunchProfile, resolveLaunchProfile, resumeLaunchContext } from "../pi-extension/subagents/launch-profile.ts";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";
import { writeFileSync } from "node:fs";

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

test("fork and nested command metadata, saved profile and reopened assignment retain actual IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "lineage-driver-"));
  try {
    const rootFile = join(dir, "root.jsonl");
    writeFileSync(rootFile, JSON.stringify({ type: "session", version: 3, id: "root", cwd: dir }) + "\n");
    const childFile = join(dir, "fork.jsonl");
    seedSubagentSessionFile({ mode: "fork", parentSessionFile: rootFile, childSessionFile: childFile, childCwd: dir });
    const entries: any[] = [];
    const root = { getSessionId: () => "root", getSessionFile: () => rootFile, getBranch: () => entries };
    const lineage = createLineage(root, childFile, dir, dir, { checkpoint: "cp", branchToken: "token" })!;
    const context: any = { params: { id: "fork-run", name: "same display", task: "explicit task" }, lineage,
      runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
      subagentSessionFile: childFile, effectiveCwd: dir, localAgentDir: dir, effectiveAutoExit: false,
      effectiveInteractive: true, taskDelivery: "artifact", subagentsDir: dir, artifactDir: dir,
      surface: "pane", shellQuote: (v: string) => JSON.stringify(v) };
    context.launchProfile = resolveLaunchProfile(context, "pi", null);
    persistLaunchProfile(context.launchProfile);
    new PiHarnessDriver().buildCommand(context);
    const assignment = JSON.parse(readFileSync(join(dir, "context", "subagent-assignment-fork-run.json"), "utf8"));
    assert.deepEqual(assignment.lineage, lineage);
    entries.push({ type: "custom", customType: "subagent-assignment", data: assignment });
    const child = { getSessionId: () => lineage.child.sessionId, getSessionFile: () => childFile, getBranch: () => entries };
    const nested = createLineage(child, join(dir, "nested.jsonl"), dir, dir, { checkpoint: "nested-cp", branchToken: "nested-token" })!;
    new PiHarnessDriver().buildCommand({ ...context, launchProfile: undefined, lineage: nested,
      params: { ...context.params, id: "nested-run" }, subagentSessionFile: nested.child.sessionFile });
    const nestedAssignment = JSON.parse(readFileSync(join(dir, "context", "subagent-assignment-nested-run.json"), "utf8"));
    assert.deepEqual(nestedAssignment.lineage.parent, lineage.child);
    assert.deepEqual(nestedAssignment.lineage.root, lineage.root);
    const reopened = resumeLaunchContext(readPiLaunchProfile(childFile), { id: "reopened", name: "renamed", surface: "new-pane",
      artifactDir: dir, subagentsDir: dir, shellQuote: String });
    new PiHarnessDriver().buildCommand(reopened);
    const reopenedAssignment = JSON.parse(readFileSync(join(dir, "context", "subagent-assignment-reopened.json"), "utf8"));
    assert.deepEqual(reopenedAssignment.lineage, lineage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
