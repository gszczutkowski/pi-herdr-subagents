import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";

for (const scenario of ["linear", "branch", "compaction", "retain-none", "empty-root"] as const) {
  test(`fork native context: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-context-"));
    try {
      const parent = SessionManager.create(dir, dir);
      const root = parent.appendMessage({ role: "user", content: "shared history", timestamp: 1 });
      parent.appendCustomMessageEntry("test", "earlier answer", false);
      if (scenario === "compaction") parent.appendCompaction("saved summary", root, 1000);
      if (scenario === "retain-none") parent.appendCompaction("saved summary only", null, 1000);
      if (scenario === "branch") {
        parent.appendMessage({ role: "user", content: "ABANDONED PRIVATE PATH", timestamp: 2 });
        parent.appendCustomMessageEntry("test", "ABANDONED ANSWER", false);
        parent.branch(root);
        parent.appendCustomMessageEntry("test", "selected path", false);
      }
      if (scenario === "empty-root") parent.resetLeaf();
      const expected = parent.buildSessionContext().messages;
      const branchPoint = parent.getLeafId();
      parent.appendMessage({ role: "user", content: "delegate this task", timestamp: 3 });
      parent.appendCustomEntry("delegating-turn", { incomplete: true });
      // For the branched case, the physical tail is deliberately not the active path.
      const selected = parent.getBranch();
      if (scenario === "branch") {
        parent.branch(root);
        parent.appendMessage({ role: "user", content: "PHYSICAL TAIL NOT SELECTED", timestamp: 4 });
        parent.branch(selected.at(-1)!.id);
      }
      const childFile = join(dir, "child.jsonl");
      seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent.getSessionFile()!,
        childSessionFile: childFile, childCwd: dir, parentBranch: parent.getBranch() });
      const child = SessionManager.open(childFile);
      assert.deepEqual(child.buildSessionContext().messages, expected);
      assert.equal(child.getLeafId(), branchPoint);
      assert.doesNotMatch(readFileSync(childFile, "utf8"), /ABANDONED|PHYSICAL TAIL|delegate this task|delegating-turn/);
      assert.equal(child.getHeader()!.parentSession, parent.getSessionFile());
      assert.notEqual(child.getSessionId(), parent.getSessionId());
      // The parent tree and selection remain untouched by serialization.
      assert.deepEqual(parent.getBranch(), selected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("fork fails closed without active branch instead of guessing from disk", () => {
  assert.throws(() => seedSubagentSessionFile({ mode: "fork", parentSessionFile: "unused",
    childSessionFile: "unused", childCwd: "." }), /active parent branch/);
});
