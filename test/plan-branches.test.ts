import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PlanPersistence, PLAN_ENTRY } from "../pi-extension/subagents/plan-persistence.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "plan-branches-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const p = adapter(sm);
  let plan = p.create(sm, 0, "Plan");
  plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, "Original task"));
  return { dir, sm, p, plan, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function adapter(sm: SessionManager, child = false) { return new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, child); }
function update(p: PlanPersistence, sm: SessionManager, plan: store.PlanSnapshot, title: string) {
  return p.mutate(sm, plan.planId, plan.revision, (s, c) => store.editTask(s, c, s.tasks[0].taskId, { title }));
}

test("native tree reads target path, not physical tail; historical edits require explicit copy/detach", () => {
  const { sm, p, plan, cleanup } = fixture();
  try {
    const oldEntry = sm.getLeafId()!;
    const main = update(p, sm, plan, "Main future");
    const mainEntry = sm.getLeafId()!;
    sm.branch(oldEntry);
    assert.equal(p.restore(sm).snapshot?.tasks[0].title, "Original task");
    assert.equal(p.read(sm).detachRequired, "historical");
    assert.throws(() => update(p, sm, plan, "No detach"), /Historical.*read-only/);
    const branched = p.detach(sm, plan.planId, plan.revision, "Explore alternate implementation");
    assert.notEqual(branched.planId, plan.planId);
    assert.notEqual(branched.authority.branchInstanceId, plan.authority.branchInstanceId);
    assert.deepEqual(branched.source, { planId: plan.planId, authority: plan.authority, revision: plan.revision, entryId: oldEntry, reason: "Explore alternate implementation" });
    const alternate = update(p, sm, branched, "Alternate");
    const alternateEntry = sm.getLeafId()!;
    sm.branch(mainEntry);
    assert.equal(p.restore(sm).snapshot?.planId, main.planId);
    assert.equal(p.read(sm).writable, true);
    const continued = update(p, sm, main, "Main continued");
    assert.equal(continued.planId, main.planId); // no repeated clone on return
    assert.deepEqual(continued.authority, main.authority);
    sm.branch(alternateEntry);
    assert.equal(p.restore(sm).snapshot?.planId, alternate.planId);
    assert.equal(p.read(sm).writable, true);
    const continuedAlternate = update(p, sm, alternate, "Alternate continued");
    assert.equal(continuedAlternate.planId, alternate.planId);
    assert.deepEqual(adapter(SessionManager.open(sm.getSessionFile()!)).read(SessionManager.open(sm.getSessionFile()!)).snapshot, continuedAlternate);
    assert.throws(() => p.mutate(sm, main.planId, continuedAlternate.revision, s => s), /identity conflict/);
  } finally { cleanup(); }
});

test("tree rollback detection survives module recreation and a new conversation append", () => {
  const { sm, p, plan, cleanup } = fixture();
  try {
    const oldEntry = sm.getLeafId()!;
    update(p, sm, plan, "Future");
    sm.branch(oldEntry);
    sm.appendMessage({ role: "user", content: "Different direction", timestamp: Date.now() });
    const reopened = SessionManager.open(sm.getSessionFile()!);
    const reload = adapter(reopened);
    assert.equal(reload.restore(reopened).detachRequired, "historical");
    const detached = reload.detach(reopened, plan.planId, plan.revision, "Historical write");
    const tip = reopened.getLeafId()!;
    reopened.branch(oldEntry);
    reopened.branch(tip);
    assert.equal(reload.restore(reopened).writable, true);
    assert.equal(update(reload, reopened, detached, "New branch").planId, detached.planId);
  } finally { cleanup(); }
});

test("return to an unchanged main tip ignores explicitly detached alternatives", () => {
  const { sm, p, plan, cleanup } = fixture();
  try {
    const mainTip = sm.getLeafId()!;
    const detached = p.detach(sm, plan.planId, plan.revision, "Explicit copy at tip");
    const detachedTip = sm.getLeafId()!;
    sm.branch(mainTip);
    assert.equal(p.restore(sm).writable, true);
    assert.equal(update(p, sm, plan, "Main").planId, plan.planId);
    sm.branch(detachedTip);
    assert.equal(p.restore(sm).writable, true);
    assert.equal(update(p, sm, detached, "Copy").planId, detached.planId);
  } finally { cleanup(); }
});

test("malformed abandoned detaches preserve the selected snapshot but cannot exempt historical writes", () => {
  const corruptions: ((copy: any) => void)[] = [
    copy => { delete copy.source.authority; },
    copy => { copy.source.authority = null; },
    copy => { copy.source.authority = {}; },
    copy => { copy.source = null; },
    copy => { delete copy.authority; },
    copy => { copy.source.revision = -1; },
    copy => { copy.tasks = null; },
  ];
  for (const corrupt of corruptions) {
    const { sm, p, plan, cleanup } = fixture();
    try {
      const goodTip = sm.getLeafId()!;
      const malformed = structuredClone(store.detachPlan(plan, { ...plan.authority, branchInstanceId: crypto.randomUUID() }, goodTip, "Alternate"));
      corrupt(malformed);
      sm.appendCustomEntry(PLAN_ENTRY, malformed);
      sm.branch(goodTip);
      for (const selected of [sm, SessionManager.open(sm.getSessionFile()!)]) {
        selected.branch(goodTip);
        const persistence = adapter(selected);
        const view = persistence.restore(selected);
        assert.deepEqual(view.snapshot, plan, "bad off-branch data cannot hide the valid active plan");
        assert.equal(view.detachRequired, "historical");
        assert.equal(view.writable, false);
        assert.match(view.error!, /Historical.*read-only/);
        assert.doesNotMatch(view.error!, /TypeError/);
        assert.throws(() => update(persistence, selected, plan, "Unsafe write"), /Historical.*read-only/);
      }
      const detached = p.detach(sm, plan.planId, plan.revision, "Recover explicitly");
      assert.equal(p.read(sm).writable, true);
      assert.deepEqual(detached.source?.authority, plan.authority);
    } finally { cleanup(); }
  }
});

test("native fork/clone copies actual selected point, foreign read-only until parent detach; source stays untouched", () => {
  const { sm, p, plan: original, cleanup } = fixture();
  try {
    let plan = p.mutate(sm, original.planId, original.revision, (s, c) => store.startAttempt(s, c, s.tasks[0].taskId));
    const taskId = plan.tasks[0].taskId;
    const attemptId = plan.tasks[0].attempts[0].attemptId;
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.attachRun(s, c, taskId, attemptId, "original-run"));
    const selectedPoint = sm.getLeafId()!;
    const promptPoint = sm.appendMessage({ role: "user", content: "Fork before this prompt", timestamp: Date.now() });
    const future = update(p, sm, plan, "Not in selected copy");
    const file = sm.getSessionFile()!;
    const sourceBytes = readFileSync(file, "utf8");
    // SessionManager's selected point is exactly what /fork before and /clone at pass.
    for (const point of [sm.getEntry(promptPoint)!.parentId!, selectedPoint]) {
      const clone = SessionManager.open(file);
      clone.createBranchedSession(point);
      const cp = adapter(clone);
      assert.equal(cp.restore(clone).detachRequired, "foreign");
      assert.equal(cp.read(clone).snapshot?.tasks[0].title, "Original task");
      assert.throws(() => update(cp, clone, plan, "Implicit takeover"), /Foreign/);
      assert.throws(() => cp.detach(clone, plan.planId, plan.revision - 1, "Stale"), /Revision/);
      assert.throws(() => adapter(clone, true).detach(clone, plan.planId, plan.revision, "Child takeover"), /Child/);
      const detached = cp.detach(clone, plan.planId, plan.revision, "Independent work");
      assert.equal(detached.authority.sessionId, clone.getSessionId());
      assert.notEqual(detached.planId, plan.planId);
      assert.equal(detached.tasks[0].status, "blocked");
      assert.match(detached.tasks[0].statusReason, /Inherited attempt.*retry/);
      assert.deepEqual(detached.tasks[0].attempts[0].origin, { planId: plan.planId, authority: plan.authority });
      assert.throws(() => cp.mutate(clone, detached.planId, detached.revision, (s, c) => store.attachRun(s, c, taskId, attemptId, "stolen")), /Inherited attempt/);
      const result = { eventId: "late", runId: "original-run", ref: "result" };
      assert.throws(() => cp.mutate(clone, detached.planId, detached.revision, (s, c) => store.recordResult(s, c, taskId, attemptId, result), plan.authority), /origin authority/);
      assert.throws(() => cp.mutate(clone, detached.planId, detached.revision, (s, c) => store.recordResult(s, c, taskId, attemptId, result), detached.authority), /Inherited attempt/);
      const retried = cp.mutate(clone, detached.planId, detached.revision, (s, c) => store.retry(s, c, taskId));
      assert.equal(retried.tasks[0].attempts.length, 2);
      assert.equal(retried.tasks[0].attempts[1].origin?.planId, detached.planId);
      assert.deepEqual(cp.read(clone).recoveryUncertain, []);
      assert.deepEqual(adapter(SessionManager.open(clone.getSessionFile()!)).read(SessionManager.open(clone.getSessionFile()!)).snapshot, retried);
      assert.equal(readFileSync(file, "utf8"), sourceBytes);
      assert.equal(p.read(sm).snapshot?.revision, future.revision);
    }
  } finally { cleanup(); }
});

test("new session has no inherited plan; no physical-entry scan or foreign results change selection", () => {
  const { dir, sm, p, plan, cleanup } = fixture();
  try {
    const source = sm.getSessionFile()!;
    const fresh = SessionManager.create(dir, dir, { parentSession: source });
    fresh.appendMessage({ role: "user", content: "New", timestamp: Date.now() });
    assert.equal(adapter(fresh).restore(fresh).snapshot, undefined);
    const next = adapter(fresh).create(fresh, 0, "Separate");
    assert.notEqual(next.planId, plan.planId);
    assert.equal(p.read(sm).snapshot?.planId, plan.planId);
    // A future/invalid plan entry off the active branch must not poison it.
    const goodTip = sm.getLeafId()!;
    sm.appendCustomEntry("pi-subagents-plan/v99", {});
    sm.branch(goodTip);
    assert.equal(p.read(sm).snapshot?.planId, plan.planId);
    assert.equal(p.read(sm).detachRequired, "historical");
    assert.equal(sm.getBranch().filter(e => e.type === "custom" && e.customType === PLAN_ENTRY).length, 2);
  } finally { cleanup(); }
});
