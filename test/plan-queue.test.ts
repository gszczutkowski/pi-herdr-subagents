import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as s from "../pi-extension/subagents/plan-store.ts";
import { evaluateQueue, sameAreaPath, type QueueRuntimeAdapter, type QueueRuntimeObservation } from "../pi-extension/subagents/plan-queue.ts";
import { canonicalWorkArea, collectQueueFacts, QUEUE_VIEW_AREA_CHECK_LIMIT } from "../pi-extension/subagents/plan-queue-work-area.ts";
import { PLAN_ENTRY_V2, PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { dispatchFailureEventId } from "../pi-extension/subagents/runtime-store.ts";

const authority = { sessionId: "parent", branchInstanceId: "branch" };
const context = (plan: s.PlanSnapshot) => ({ ...plan.authority, expectedRevision: plan.revision });
const add = (plan: s.PlanSnapshot, title: string, dependencies: string[] = []) => s.addTask(plan, context(plan), title, { dependencies, criteria: [s.createCriterion(`Verify ${title}`)] });
const task = (plan: s.PlanSnapshot, taskId: string) => plan.tasks.find(t => t.taskId === taskId)!;
const attempt = (plan: s.PlanSnapshot, taskId: string) => task(plan, taskId).attempts.at(-1)!;
const id = (plan: s.PlanSnapshot) => plan.tasks.at(-1)!.taskId;
const cwdFor = (plan: s.PlanSnapshot, taskId: string) => task(plan, taskId).workArea!.cwd;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "plan-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = (name: string) => { const cwd = join(dir, name); mkdirSync(cwd, { recursive: true }); return cwd; };
  return { dir, workspace };
}
function runtime() {
  const facts = new Map<string, QueueRuntimeObservation>();
  const inspected: Parameters<QueueRuntimeAdapter["inspect"]>[0][] = [];
  const adapter: QueueRuntimeAdapter = { available: () => true, canPrepareDispatch: binding => !facts.has(binding.runId), inspect: binding => {
    inspected.push(binding);
    return facts.get(binding.runId) ?? { state: "unknown" };
  } };
  return { adapter, facts, inspected };
}
function queue(plan: s.PlanSnapshot, adapter?: QueueRuntimeAdapter) {
  const view = evaluateQueue(plan, collectQueueFacts(plan, true, adapter));
  if ("error" in view) throw new Error(view.error);
  return view;
}
function item(plan: s.PlanSnapshot, taskId: string, adapter?: QueueRuntimeAdapter) {
  return queue(plan, adapter).items.find(item => item.taskId === taskId)!;
}
const setArea = (plan: s.PlanSnapshot, taskId: string, cwd: string, access: "read" | "write" = "write") => s.setWorkArea(plan, context(plan), taskId, cwd, access);
const start = (plan: s.PlanSnapshot, taskId: string, adapter?: QueueRuntimeAdapter) => s.startAttempt(plan, context(plan), taskId, undefined, adapter);
function begin(plan: s.PlanSnapshot, taskId: string, runId: string, adapter: QueueRuntimeAdapter, cwd = cwdFor(plan, taskId)) {
  return s.beginQueueDispatch(plan, context(plan), taskId, attempt(plan, taskId).attemptId, runId, cwd, adapter);
}
function confirm(plan: s.PlanSnapshot, taskId: string, runId: string, adapter: QueueRuntimeAdapter) {
  return s.confirmQueueDispatch(plan, context(plan), taskId, attempt(plan, taskId).attemptId, runId, adapter);
}
const repairInput = (n: number) => ({ decisionId: `repair-${n}`, reviewRef: `review-${n}`, artifactVersion: `v${n}`, reason: "New failing case" });
function replacement(plan: s.PlanSnapshot, taskId: string, n: number) {
  return s.recordQueueReplacementRepair(plan, context(plan), taskId, attempt(plan, taskId).attemptId, repairInput(n));
}
function release(plan: s.PlanSnapshot, taskId: string, adapter?: QueueRuntimeAdapter) {
  return s.releaseReservation(plan, context(plan), taskId, attempt(plan, taskId).attemptId, "Custody checked", adapter);
}
function evidence(plan: s.PlanSnapshot, taskId: string, resultEventId?: string) {
  return s.addEvidence(plan, context(plan), taskId, { criterionId: task(plan, taskId).criteria[0].criterionId, ref: "Test/review at reviewed artifact version", resultEventId });
}
function accept(plan: s.PlanSnapshot, taskId: string) {
  const current = task(plan, taskId);
  return s.accept(plan, context(plan), taskId, { [current.criteria[0].criterionId]: [current.evidence.at(-1)!.evidenceId] }, "Parent reviewed all criteria");
}

test("blocked task does not gate independent work; proposal, acceptance and release are independent", t => {
  const { workspace } = fixture(t);
  const { adapter, facts } = runtime();
  let plan = s.createPlan("Queue", authority);
  assert.deepEqual(evaluateQueue(plan), { error: "queue_not_enabled" });
  plan = add(plan, "A"); const a = id(plan);
  plan = add(plan, "B", [a]); const b = id(plan);
  plan = add(plan, "C"); const c = id(plan);
  plan = add(plan, "D", [c]); const d = id(plan);
  plan = s.configureQueue(plan, context(plan), 1);
  for (const current of plan.tasks) plan = setArea(plan, current.taskId, workspace(current.title));
  assert.equal(queue(plan).firstReadyTaskId, null);
  assert.equal(queue(plan, adapter).firstReadyTaskId, a);
  plan = start(plan, a, adapter);
  plan = s.setBlocker(plan, context(plan), a, { attemptId: attempt(plan, a).attemptId, code: "scope_decision", effects: "none", decisionOwner: "user", summary: "Choose scope", requestedAction: "Approve option A or B" });
  assert.equal(item(plan, a, adapter).action, "release_reservation");
  plan = release(plan, a, adapter);
  assert.equal(item(plan, a, adapter).owner, "user");
  assert.equal(queue(plan, adapter).firstReadyTaskId, c);
  plan = start(plan, c, adapter);
  assert.equal(item(plan, c, adapter).action, "dispatch_bound");
  plan = begin(plan, c, "run-c", adapter);
  facts.set("run-c", { state: "settled" });
  plan = confirm(plan, c, "run-c", adapter);
  plan = s.recordResult(plan, context(plan), c, attempt(plan, c).attemptId, { eventId: "event-c", runId: "run-c", ref: "proposal" });
  assert.equal(item(plan, c, adapter).action, "inspect_result");
  assert.equal(item(plan, d, adapter).action, "await_dependency");
  plan = accept(evidence(plan, c), c);
  assert.equal(item(plan, d, adapter).action, "await_capacity");
  assert.equal(item(plan, c, adapter).action, "release_reservation");
  plan = release(plan, c, adapter);
  assert.equal(item(plan, c, adapter).state, "closed");
  assert.equal(queue(plan, adapter).firstReadyTaskId, d);
  assert.equal(item(plan, b, adapter).action, "await_dependency");
});

test("canonical checkout, alias and nested non-Git conflicts; distinct Git worktree and read/read are allowed", t => {
  const { dir, workspace } = fixture(t);
  const checkout = workspace("git");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=Queue Test", "-c", "user.email=queue-test@example.invalid", "commit", "--allow-empty", "-qm", "Initial");
  git("worktree", "add", "--detach", join(dir, "worktree"), "HEAD");
  const nested = workspace("git/nested");
  const alias = join(dir, "alias");
  symlinkSync(nested, alias, process.platform === "win32" ? "junction" : "dir");
  const main = canonicalWorkArea(checkout, "write");
  const linked = canonicalWorkArea(alias, "read");
  const separate = canonicalWorkArea(join(dir, "worktree"), "read");
  assert.equal(sameAreaPath(linked.root, main.root), true);
  assert.equal(separate.kind, "git");
  assert.equal(sameAreaPath(separate.root, main.root), false);

  // The real checkouts above don't change. Replay their Git answers so ready
  // order doesn't depend on spawning Git within the projection's 150 ms budget.
  // Filesystem checks (including the directory move below) are still live.
  const roots = new Map([main, linked, separate].map(area => [area.cwd, area.root]));
  const gitProbe = t.mock.method(childProcess, "execFileSync", (cmd: string, args: string[], options: { cwd: string }) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
    const root = roots.get(options.cwd);
    assert.ok(root, `Unexpected checkout: ${options.cwd}`);
    return `${root}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { gitProbe.mock.restore(); syncBuiltinESMExports(); });
  const { adapter } = runtime();
  let plan = s.createPlan("Queue", authority);
  plan = add(plan, "Writer"); const w = id(plan);
  plan = add(plan, "Git alias"); const a = id(plan);
  plan = add(plan, "Separate worktree"); const b = id(plan);
  plan = add(plan, "Other directory"); const c = id(plan);
  plan = add(plan, "Descendant directory"); const d = id(plan);
  plan = s.configureQueue(plan, context(plan), 3);
  plan = setArea(plan, w, checkout);
  plan = setArea(plan, a, alias, "read");
  plan = setArea(plan, b, join(dir, "worktree"));
  plan = setArea(plan, c, workspace("outside"));
  plan = setArea(plan, d, workspace("outside/nested"), "read");
  plan = start(plan, w, adapter);
  assert.equal(item(plan, a, adapter).action, "await_resource");
  assert.equal(item(plan, a, adapter).reasons.find(r => r.code === "work_area_conflict")?.taskId, w);
  assert.equal(queue(plan, adapter).firstReadyTaskId, b);
  plan = start(plan, c, adapter);
  assert.equal(item(plan, d, adapter).action, "await_resource");
  plan = release(plan, w, adapter);
  plan = s.cancel(plan, context(plan), w, "Reset");
  plan = s.reopen(plan, context(plan), w, "Read only");
  plan = setArea(plan, w, checkout, "read");
  plan = start(plan, w, adapter);
  assert.equal(item(plan, a, adapter).action, "start_attempt");
  renameSync(join(dir, "outside"), join(dir, "moved"));
  assert.equal(item(plan, a, adapter).action, "inspect_recovery");
  assert.ok(item(plan, a, adapter).reasons.some(r => r.code === "reservation_area_unverified" && r.taskId === c));
});

test("synchronous CAS, launch recheck and uncertain intent after crash fail closed", async t => {
  const { dir, workspace } = fixture(t);
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Plan queue", timestamp: 1 });
  const p = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
  const { adapter, facts, inspected } = runtime();
  let plan = p.create(sm, 0, "Queue");
  const mutate = (command: Parameters<PlanPersistence["mutate"]>[3]) => { plan = p.mutate(sm, plan.planId, plan.revision, command); };
  mutate(q => add(q, "A")); const a = id(plan);
  mutate(q => add(q, "B")); const b = id(plan);
  mutate((q, c) => s.configureQueue(q, c, 1));
  mutate(q => setArea(q, a, workspace("a")));
  mutate(q => setArea(q, b, workspace("b")));
  const revision = plan.revision;
  const reservations = await Promise.allSettled([a, b].map(taskId => Promise.resolve().then(() => p.mutate(sm, plan.planId, revision, q => start(q, taskId, adapter)))));
  assert.deepEqual(reservations.map(result => result.status), ["fulfilled", "rejected"]);
  plan = p.read(sm).snapshot!;
  assert.equal(queue(plan, adapter).occupied, 1);
  let sends = 0;
  const newDispatch = (run: string, cwd?: string) => mutate(q => begin(q, a, run, adapter, cwd));
  const verifyThenSend = (run: string) => { s.verifyQueueDispatchIntent(plan, context(plan), a, attempt(plan, a).attemptId, run, cwdFor(plan, a), adapter); sends++; };
  assert.throws(() => newDispatch("wrong-cwd", cwdFor(plan, b)), /cwd does not match/);
  mutate((q, c) => s.queuePause(q, c, "User requested pause"));
  assert.throws(() => newDispatch("paused"), /queue_paused/);
  assert.equal(sends, 0);
  mutate((q, c) => s.queueContinue(q, c, "Continue"));
  newDispatch("crash-before-manifest");
  assert.equal(attempt(plan, a).reservation?.phase, "uncertain");
  assert.equal(sends, 0);
  assert.throws(() => newDispatch("duplicate"), /first dispatch/);
  assert.throws(() => release(plan, a, adapter), /positive/);
  const file = SessionManager.open(sm.getSessionFile()!);
  const reopened = new PlanPersistence(() => { throw new Error("Check must not write"); }, false);
  const restored = reopened.restore(file).snapshot!;
  assert.deepEqual(restored, plan);
  assert.equal(item(restored, a, adapter).state, "uncertain");
  assert.equal(item(restored, b, adapter).action, "await_capacity");
  assert.deepEqual(inspected.at(-1), { planId: plan.planId, authority: plan.authority, taskId: a, attemptId: attempt(plan, a).attemptId, runId: "crash-before-manifest" });
  mutate((q, c) => s.queuePause(q, c, "Paused after intent"));
  assert.throws(() => verifyThenSend("crash-before-manifest"), /queue_paused/);
  assert.equal(sends, 0);
  facts.set("crash-before-manifest", { state: "not_dispatched" });
  mutate(q => release(q, a, adapter));
  assert.equal(task(plan, a).status, "blocked");
  assert.equal(release(plan, a, adapter), plan);
  assert.throws(() => verifyThenSend("crash-before-manifest"), /in_progress/);
  assert.equal(sends, 0);
  assert.ok(sm.getBranch().some(entry => entry.type === "custom" && entry.customType === PLAN_ENTRY_V2));
  mutate((q, c) => s.queueContinue(q, c, "Continue"));
  mutate(q => start(q, b, adapter));
  const dispatch = () => {
    mutate(q => begin(q, b, "run-b", adapter));
    s.verifyQueueDispatchIntent(plan, context(plan), b, attempt(plan, b).attemptId, "run-b", cwdFor(plan, b), adapter);
    sends++;
  };
  dispatch();
  assert.throws(dispatch, /first dispatch/);
  assert.equal(sends, 1);
  const verify = (runtimeAdapter: QueueRuntimeAdapter) => s.verifyQueueDispatchIntent(plan, context(plan), b, attempt(plan, b).attemptId, "run-b", cwdFor(plan, b), runtimeAdapter);
  assert.throws(() => verify({ ...adapter, canPrepareDispatch: undefined }), /cannot positively exclude/);
  assert.throws(() => verify({ ...adapter, canPrepareDispatch: () => { throw new Error("Custody lost"); } }), /cannot positively exclude/);
  assert.throws(() => verify({ ...adapter, canPrepareDispatch: () => true, inspect: () => { throw new Error("Observation failed"); } }), /could not be checked/);
  facts.set("run-b", { state: "unknown" }); // A known but inconclusive record must not authorize preparation.
  assert.throws(() => verify(adapter), /cannot positively exclude/);
  for (const observation of [{ state: "working", owner: "runtime" }, { state: "settled" }, { state: "not_dispatched" }] as const) {
    facts.set("run-b", observation);
    assert.throws(() => verify({ ...adapter, canPrepareDispatch: () => true }), /already has a runtime disposition/);
  }
});

test("failed launch-intent append disables admission without transport", t => {
  const { dir, workspace } = fixture(t);
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Plan queue", timestamp: 1 });
  let appendFault = false;
  const p = new PlanPersistence((type, data) => {
    if (appendFault) throw new Error("Injected disk failure");
    sm.appendCustomEntry(type, data);
  }, false);
  const { adapter } = runtime();
  let plan = p.create(sm, 0, "Queue");
  const mutate = (command: Parameters<PlanPersistence["mutate"]>[3]) => { plan = p.mutate(sm, plan.planId, plan.revision, command); };
  mutate(q => add(q, "Task")); const a = id(plan);
  mutate((q, c) => s.configureQueue(q, c, 1));
  mutate(q => setArea(q, a, workspace("a")));
  mutate(q => start(q, a, adapter));
  let sends = 0;
  const dispatch = () => { mutate(q => begin(q, a, "run-a", adapter)); sends++; };
  appendFault = true;
  assert.throws(dispatch, /append failed/);
  appendFault = false;
  assert.throws(dispatch, /writes disabled/);
  assert.equal(sends, 0);
  assert.equal(attempt(p.read(sm).snapshot!, a).reservation?.phase, "reserved");
});

test("accepted prerequisites are pinned per attempt; reopened and reaccepted dependencies need explicit reverification", t => {
  const { workspace } = fixture(t);
  const { adapter, facts } = runtime();
  let plan = s.createPlan("Queue", authority);
  plan = add(plan, "Integrated result"); const a = id(plan);
  plan = add(plan, "Consumer", [a]); const b = id(plan);
  plan = add(plan, "Transitive", [b]); const c = id(plan);
  plan = s.configureQueue(plan, context(plan), 2);
  plan = setArea(plan, b, workspace("consumer"));
  plan = setArea(plan, c, workspace("transitive"));
  plan = s.submitReview(plan, context(plan), a, "Integration review");
  plan = accept(evidence(plan, a), a);
  const generation = task(plan, a).decisions.at(-1)!.revision;
  plan = start(plan, b, adapter);
  assert.deepEqual(attempt(plan, b).reservation!.dependencies, [{ taskId: a, generation }]);
  plan = s.reopen(plan, context(plan), a, "New integrated version");
  assert.equal(item(plan, b, adapter).action, "release_reservation");
  assert.throws(() => begin(plan, b, "reopened", adapter), /dependency_unaccepted/);
  plan = s.submitReview(plan, context(plan), a, "Revised integration review");
  plan = s.revalidateQueueReview(plan, context(plan), a);
  plan = accept(evidence(plan, a), a);
  assert.throws(() => begin(plan, b, "stale", adapter), /generation changed/);
  plan = release(plan, b, adapter);
  plan = s.retry(plan, context(plan), b, undefined, adapter);
  plan = begin(plan, b, "run-b", adapter);
  facts.set("run-b", { state: "working", owner: "runtime" });
  plan = confirm(plan, b, "run-b", adapter);
  assert.equal(item(plan, b, adapter).owner, "runtime");
  plan = s.recordResult(plan, context(plan), b, attempt(plan, b).attemptId, { eventId: "consumer-at-old-generation", ref: "Consumer proposal", runId: "run-b" });
  plan = evidence(plan, b, "consumer-at-old-generation");
  plan = s.reopen(plan, context(plan), a, "Prerequisite rejected after execution");
  assert.throws(() => accept(plan, b), /generation/);
  plan = s.submitReview(plan, context(plan), a, "Retest integration");
  plan = s.revalidateQueueReview(plan, context(plan), a);
  assert.throws(() => accept(plan, a), /new evidence/);
  plan = accept(evidence(plan, a), a);
  assert.throws(() => accept(plan, b), /generation/);
  plan = s.revalidateQueueReview(plan, context(plan), b);
  assert.throws(() => evidence(plan, b, "consumer-at-old-generation"), /Stale queue result evidence/);
  assert.throws(() => accept(plan, b), /new evidence/);
  plan = accept(evidence(plan, b), b);
  assert.equal(item(plan, c, adapter).state, "ready");
  plan = s.reopen(plan, context(plan), a, "Another integrated change");
  assert.equal(item(plan, c, adapter).reasons.find(r => r.code === "dependency_stale")?.taskId, b);
});

test("retry cannot seal a new dependency generation with an old attempt's evidence", t => {
  const { workspace } = fixture(t);
  const { adapter, facts } = runtime();
  let plan = add(s.createPlan("Queue", authority), "Prerequisite"); const a = id(plan);
  plan = add(plan, "Consumer", [a]); const b = id(plan);
  plan = s.configureQueue(plan, context(plan), 1);
  plan = setArea(plan, b, workspace("consumer"));
  plan = s.submitReview(plan, context(plan), a, "Initial integration review");
  plan = accept(evidence(plan, a), a);
  const oldGeneration = task(plan, a).decisions.at(-1)!.revision;
  plan = begin(start(plan, b, adapter), b, "old", adapter);
  facts.set("old", { state: "settled" });
  plan = confirm(plan, b, "old", adapter);
  plan = s.recordResult(plan, context(plan), b, attempt(plan, b).attemptId, { eventId: "old-event", runId: "old", ref: "Consumer proposal" });
  plan = evidence(plan, b, "old-event");
  plan = s.reject(plan, context(plan), b, "Rejected consumer");
  plan = release(plan, b, adapter);
  plan = s.reopen(plan, context(plan), a, "Revised dependency");
  plan = s.submitReview(plan, context(plan), a, "Revised integration review");
  plan = s.revalidateQueueReview(plan, context(plan), a);
  plan = accept(evidence(plan, a), a);
  const newGeneration = task(plan, a).decisions.at(-1)!.revision;
  assert.notEqual(newGeneration, oldGeneration);
  assert.throws(() => s.retry(plan, context(plan), b, undefined, adapter), /replacement_repair_required/);
  plan = replacement(plan, b, 1);
  assert.equal(replacement(plan, b, 1), plan);
  assert.throws(() => replacement(plan, b, 2), /already recorded/);
  plan = s.retry(s.deserializePlan(s.serializePlan(plan)), context(plan), b, undefined, adapter);
  assert.deepEqual(attempt(plan, b).reservation?.dependencies, [{ taskId: a, generation: newGeneration }]);
  assert.throws(() => s.deserializePlan(JSON.stringify({ ...plan, tasks: plan.tasks.map(task => task.taskId === b ? { ...task, repairs: undefined } : task) })), /lacks prior repair decision/);
  const immediate = s.submitReview(plan, context(plan), b, "Review newly assigned consumer without dispatch");
  assert.throws(() => accept(immediate, b), /positively confirmed dispatch/);
  assert.throws(() => accept(evidence(immediate, b), b), /positively confirmed dispatch/);
  assert.throws(() => evidence(immediate, b, "old-event"), /Stale queue result evidence/);
  plan = begin(plan, b, "new", adapter);
  plan = s.submitReview(plan, context(plan), b, "Review new consumer");
  assert.throws(() => accept(evidence(plan, b), b), /positively confirmed dispatch/);
  facts.set("new", { state: "settled" });
  plan = confirm(plan, b, "new", adapter);
  assert.throws(() => accept(plan, b), /new evidence/);
  plan = accept(evidence(plan, b), b);
  assert.deepEqual(task(plan, b).decisions.at(-1)?.dependencies, [{ taskId: a, generation: newGeneration }]);
  assert.deepEqual(s.deserializePlan(s.serializePlan(plan)), plan);
  const consumer = task(plan, b);
  const staleDecision = { ...consumer.decisions.at(-1), criteria: { [consumer.criteria[0].criterionId]: [consumer.evidence[0].evidenceId] } };
  assert.throws(() => s.deserializePlan(JSON.stringify({ ...plan, tasks: [task(plan, a), { ...consumer, decisions: [staleDecision] }] })), /Stale queue acceptance evidence/);
});

test("no-attempt manual evidence stays compatible, but explicit reverification requires fresh evidence", () => {
  let plan = add(s.createPlan("Queue", authority), "Manual"); const a = id(plan);
  plan = evidence(plan, a); // Legacy evidence without an attempt or queue epoch.
  plan = s.configureQueue(plan, context(plan), 1);
  plan = s.submitReview(plan, context(plan), a, "Manual review");
  assert.equal(task(accept(plan, a), a).status, "accepted");
  plan = s.revalidateQueueReview(plan, context(plan), a);
  assert.throws(() => accept(plan, a), /new evidence/);
  assert.equal(task(accept(evidence(plan, a), a), a).status, "accepted");
});

test("vanished reserved cwd offers release, then explicit cancel, reopen and reconfigure", t => {
  const { dir, workspace } = fixture(t);
  const { adapter } = runtime();
  let plan = add(s.createPlan("Queue", authority), "Task"); const a = id(plan);
  plan = s.configureQueue(plan, context(plan), 1);
  const old = workspace("old");
  plan = start(setArea(plan, a, old), a, adapter);
  renameSync(old, join(dir, "moved"));
  assert.equal(item(plan, a, adapter).action, "release_reservation");
  assert.throws(() => begin(plan, a, "wrong", adapter), /work_area_unverified/);
  plan = release(plan, a, adapter);
  assert.equal(task(plan, a).status, "blocked");
  assert.throws(() => setArea(plan, a, workspace("new")), /pending/);
  plan = s.cancel(plan, context(plan), a, "Choose a new area");
  plan = s.reopen(plan, context(plan), a, "Reconfigure");
  assert.equal(item(plan, a, adapter).action, "set_work_area");
  plan = setArea(plan, a, workspace("new"));
  assert.equal(item(plan, a, adapter).action, "start_attempt");
});

test("projection skips closed, preblocked and read-only checks and bounds distinct areas; admission is targeted", t => {
  const { workspace } = fixture(t);
  const { adapter, inspected } = runtime();
  let plan = s.createPlan("Queue", authority);
  plan = s.configureQueue(plan, context(plan), 1);
  for (let i = 0; i < 50; i++) {
    plan = add(plan, `Closed-${i}`);
    plan = setArea(plan, id(plan), workspace(`closed-${i}`));
    plan = s.cancel(plan, context(plan), id(plan), "Closed without execution");
  }
  const closedTaskIds = plan.tasks.map(task => task.taskId);
  plan = add(plan, "Preblocked", [closedTaskIds[0]]);
  plan = setArea(plan, id(plan), workspace("preblocked"));
  const preblocked = id(plan);
  const pending: string[] = [];
  for (let i = 0; i <= QUEUE_VIEW_AREA_CHECK_LIMIT; i++) {
    plan = add(plan, `Pending-${i}`);
    plan = setArea(plan, id(plan), workspace(`pending-${i}`));
    pending.push(id(plan));
  }
  let availabilityChecks = 0;
  const readOnly = collectQueueFacts(plan, false, { ...adapter, available: () => { availabilityChecks++; return true; } });
  assert.equal(availabilityChecks, 0);
  assert.equal(readOnly.checkedTaskIds?.size, 0);
  assert.equal(collectQueueFacts(plan, true).checkedTaskIds?.size, 0);
  const facts = collectQueueFacts(plan, true, adapter);
  assert.deepEqual([...facts.checkedTaskIds!], pending.slice(0, QUEUE_VIEW_AREA_CHECK_LIMIT));
  assert.equal(inspected.length, 0);
  assert.equal(queue(plan, adapter).firstReadyTaskId, pending[0]);
  assert.equal(item(plan, preblocked, adapter).action, "revise_or_skip");
  const unchecked = pending.at(-1)!;
  assert.equal(item(plan, unchecked, adapter).action, "check_work_area");
  assert.ok(item(plan, unchecked, adapter).reasons.some(r => r.code === "work_area_check_deferred"));
  assert.equal(task(start(plan, unchecked, adapter), unchecked).status, "in_progress");
});

test("projection advances past five active disjoint reservations without dispatch and pins the read to state and runtime", t => {
  const { dir, workspace } = fixture(t);
  const live = runtime();
  let prepareCalls = 0;
  let available = true;
  const adapter = { ...live.adapter, available: () => available, canPrepareDispatch: () => { prepareCalls++; return false; } };
  let plan = s.createPlan("Queue", authority);
  plan = s.configureQueue(plan, context(plan), 6);
  const workers: string[] = [];
  for (let i = 0; i < 5; i++) {
    plan = add(plan, `Worker ${i}`);
    const worker = id(plan);
    workers.push(worker);
    plan = begin(start(setArea(plan, worker, workspace(`worker-${i}`)), worker, adapter), worker, `worker-${i}`, adapter);
    live.facts.set(`worker-${i}`, { state: "working", owner: "runtime" });
    plan = confirm(plan, worker, `worker-${i}`, adapter);
  }
  plan = add(plan, "Eligible sixth"); const candidate = id(plan);
  plan = setArea(plan, candidate, workspace("sixth"));
  const before = s.serializePlan(plan);
  const first = collectQueueFacts(plan, true, adapter);
  assert.ok(first.cursor);
  assert.deepEqual([...first.checkedTaskIds!], workers.slice(0, 4));
  assert.deepEqual([...first.deferredTaskIds!], [workers[4], candidate]);
  const partial = evaluateQueue(plan, first);
  assert.ok(!("error" in partial));
  assert.equal(partial.occupied, 5);
  assert.equal(partial.areaChecksComplete, false);
  assert.ok(!("firstReadyTaskId" in partial));
  assert.equal(partial.items[5].action, "check_work_area");
  assert.ok(partial.items[5].reasons.some(r => r.code === "reservation_area_check_deferred" && r.taskId === workers[4]));

  assert.throws(() => collectQueueFacts(s.queuePause(plan, context(plan), "Pause"), true, adapter, first.cursor), /cursor does not match/);
  assert.throws(() => collectQueueFacts(s.deserializePlan(before), true, adapter, first.cursor), /cursor does not match/);
  assert.throws(() => collectQueueFacts(plan, false, adapter, first.cursor), /cursor does not match/);
  assert.throws(() => collectQueueFacts(plan, true, { ...adapter }, first.cursor), /cursor does not match/);
  available = false;
  assert.throws(() => collectQueueFacts(plan, true, adapter, first.cursor), /runtime state changed/);
  available = true;
  live.facts.set("worker-4", { state: "working", owner: "coordinator" });
  assert.throws(() => collectQueueFacts(plan, true, adapter, first.cursor), /runtime state changed/);
  live.facts.set("worker-4", { state: "working", owner: "runtime" });
  const done = collectQueueFacts(plan, true, adapter, first.cursor);
  assert.equal(done.cursor, undefined);
  assert.deepEqual([...done.checkedTaskIds!], [...workers, candidate]);
  const complete = evaluateQueue(plan, done);
  assert.ok(!("error" in complete));
  assert.equal(complete.areaChecksComplete, true);
  assert.equal(complete.firstReadyTaskId, candidate);
  assert.equal(complete.items[5].action, "start_attempt");
  assert.equal(prepareCalls, 0);
  assert.equal(s.serializePlan(plan), before);
  assert.equal(task(plan, candidate).attempts.length, 0);

  renameSync(cwdFor(plan, workers[0]), join(dir, "vanished-worker"));
  assert.throws(() => start(plan, candidate, adapter), /reservation_area_unverified/);
});

test("four vanished pending CWDs remain checked-invalid and a second bounded slice finds the fifth", t => {
  const { dir, workspace } = fixture(t);
  const { adapter, inspected } = runtime();
  let plan = s.createPlan("Queue", authority);
  plan = s.configureQueue(plan, context(plan), 1);
  for (let i = 0; i < 5; i++) {
    plan = add(plan, `Pending ${i}`);
    plan = setArea(plan, id(plan), workspace(`pending-${i}`));
  }
  for (const [index, task] of plan.tasks.slice(0, 4).entries()) renameSync(task.workArea!.cwd, join(dir, `moved-${index}`));
  const before = s.serializePlan(plan);
  const first = collectQueueFacts(plan, true, adapter);
  assert.ok(first.cursor);
  assert.deepEqual([...first.checkedTaskIds!], plan.tasks.slice(0, 4).map(task => task.taskId));
  assert.equal(first.verifiedTaskIds?.size, 0);
  assert.deepEqual([...first.deferredTaskIds!], [id(plan)]);
  const partial = evaluateQueue(plan, first);
  assert.ok(!("error" in partial));
  assert.equal(partial.areaChecksComplete, false);
  assert.ok(!("firstReadyTaskId" in partial));
  assert.deepEqual(partial.items.map(item => item.action), [...Array(4).fill("set_work_area"), "check_work_area"]);
  const done = collectQueueFacts(plan, true, adapter, first.cursor);
  const complete = evaluateQueue(plan, done);
  assert.ok(!("error" in complete));
  assert.equal(done.cursor, undefined);
  assert.equal(complete.areaChecksComplete, true);
  assert.equal(complete.firstReadyTaskId, id(plan));
  assert.deepEqual(complete.items.map(item => item.action), [...Array(4).fill("set_work_area"), "start_attempt"]);
  assert.equal(inspected.length, 0);
  assert.ok(plan.tasks.every(task => !task.attempts.length));
  assert.equal(s.serializePlan(plan), before);
  renameSync(cwdFor(plan, id(plan)), join(dir, "moved-last"));
  assert.throws(() => start(plan, id(plan), adapter), /work_area_unverified/);
  const restart = collectQueueFacts(plan, true, adapter);
  assert.ok(restart.cursor);
  const empty = evaluateQueue(plan, collectQueueFacts(plan, true, adapter, restart.cursor));
  assert.ok(!("error" in empty));
  assert.equal(empty.areaChecksComplete, true);
  assert.equal(empty.firstReadyTaskId, null);
});

test("strict queue input, historical proof retention, and detach/legacy authority", t => {
  const { workspace } = fixture(t);
  const { adapter, facts } = runtime();
  let plan = add(s.createPlan("Queue", authority), "Task"); const a = id(plan);
  const legacy = start(plan, a);
  assert.throws(() => s.configureQueue(legacy, context(legacy), 1), /existing attempts/);
  assert.throws(() => s.configureQueue(plan, context(plan), 1.5), /integer/);
  plan = s.configureQueue(plan, context(plan), 1);
  assert.throws(() => setArea(plan, a, "."), /absolute/);
  plan = setArea(plan, a, workspace("a"));
  assert.throws(() => start(plan, a), /runtime_unavailable/);
  plan = start(plan, a, adapter);
  const attemptId = attempt(plan, a).attemptId;
  const blocker = { attemptId, code: "provider_restriction", effects: "partial", decisionOwner: "user", summary: "Safe alternative needed", requestedAction: "Choose different scope" } as const;
  assert.throws(() => s.setBlocker(plan, context(plan), a, { ...blocker, log: "untrusted" } as typeof blocker), /Unsupported queue field/);
  assert.throws(() => s.setBlocker(plan, context(plan), a, { ...blocker, summary: "raw\nlog" }), /bounded|512/);
  assert.throws(() => s.attachRun(plan, context(plan), a, attemptId, "raw-attachment"), /beginQueueDispatch/);
  plan = begin(plan, a, "run-a", adapter);
  facts.set("run-a", { state: "working", owner: "coordinator" });
  plan = s.confirmQueueDispatch(plan, context(plan), a, attemptId, "run-a", adapter);
  plan = s.setBlocker(plan, context(plan), a, blocker);
  plan = s.recordResult(plan, context(plan), a, attemptId, { eventId: "old-result", runId: "run-a", ref: "older proposal" });
  assert.equal(item(plan, a, adapter).owner, "user");
  assert.throws(() => s.retry(plan, context(plan), a, undefined, adapter), /prior_reservation/);
  const fork = { sessionId: "another-parent", branchInstanceId: "another-branch" };
  assert.throws(() => s.detachPlan(plan, fork, "entry", "fork"), /outstanding/);
  assert.throws(() => release(plan, a, adapter), /positive/);
  facts.set("run-a", { state: "not_dispatched" });
  assert.throws(() => release(plan, a, adapter), /positive/);
  assert.equal(item(plan, a, adapter).state, "uncertain");
  facts.set("run-a", { state: "settled" });
  plan = release(plan, a, adapter);
  assert.deepEqual(s.deserializePlan(s.serializePlan(plan)), plan);
  assert.throws(() => s.deserializePlan(JSON.stringify({ ...plan, schemaVersion: 1 })), /schema version/);
  assert.throws(() => s.deserializePlan(JSON.stringify({ ...plan, schemaVersion: 99 })), /Unsupported schema/);
  assert.throws(() => s.deserializePlan(JSON.stringify({ ...plan, queue: { ...plan.queue, forceRelease: true } })), /Unsupported queue field/);
  const detached = s.detachPlan(plan, fork, "entry", "fork");
  assert.deepEqual(evaluateQueue(detached), { error: "queue_not_enabled" });
  assert.equal(attempt(detached, a).reservation, undefined);
  assert.deepEqual(attempt(detached, a).results, attempt(plan, a).results);
  assert.throws(() => s.attachRun(detached, context(detached), a, attemptId, "new-run"), /Inherited attempt/);
});

test("Git timeout leaves projection inconclusive, not an invalid or known-empty work area", t => {
  const { workspace } = fixture(t);
  const cwd = workspace("checkout");
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const { adapter } = runtime();
  let plan = add(s.createPlan("Queue", authority), "A"); const a = id(plan);
  plan = s.configureQueue(plan, context(plan), 1);
  plan = setArea(plan, a, cwd);
  const original = childProcess.execFileSync;
  const mock = t.mock.method(childProcess, "execFileSync", (...args: Parameters<typeof original>) => {
    if (args[0] === "git" && typeof args[2] === "object" && args[2]?.timeout === 150) {
      throw Object.assign(new Error("projection deadline"), { code: "ETIMEDOUT" });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const pending = queue(plan, adapter);
    assert.equal(pending.areaChecksComplete, false);
    assert.equal(Object.hasOwn(pending, "firstReadyTaskId"), false);
    assert.equal(pending.items[0].action, "check_work_area");
    assert.ok(pending.items[0].reasons.some(reason => reason.code === "work_area_check_inconclusive"));
    const assigned = start(plan, a, adapter);
    assert.equal(item(assigned, a, adapter).action, "check_work_area", "timeout is not proof the reserved CWD disappeared");
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("explicit infrastructure retry after reload reuses only a definitively unsent replacement decision", t => {
  const { dir, workspace } = fixture(t);
  let sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Plan queue", timestamp: 1 });
  const persistence = () => new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
  let store = persistence();
  let plan = store.create(sm, 0, "Queue");
  const mutate = (command: Parameters<PlanPersistence["mutate"]>[3]) => { plan = store.mutate(sm, plan.planId, plan.revision, command); };
  const { adapter, facts, inspected } = runtime();
  mutate(q => add(q, "Repair target")); const a = id(plan);
  mutate(q => add(q, "Capacity peer")); const peer = id(plan);
  mutate((q, c) => s.configureQueue(q, c, 1));
  mutate(q => setArea(q, a, workspace("target")));
  mutate(q => setArea(q, peer, workspace("peer")));
  mutate(q => begin(start(q, a, adapter), a, "original-tree", adapter));
  facts.set("original-tree", { state: "working", owner: "coordinator" });
  mutate(q => confirm(q, a, "original-tree", adapter));
  mutate((q, c) => s.submitReview(q, c, a, "Review the current artifact"));
  for (const round of [1, 2]) mutate((q, c) => s.recordQueueRepair(q, c, a, attempt(q, a).attemptId, "original-tree", cwdFor(q, a), repairInput(round), adapter));
  facts.set("original-tree", { state: "settled" });
  mutate(q => release(q, a, adapter));
  mutate(q => replacement(q, a, 3));
  mutate((q, c) => s.retry(q, c, a, undefined, adapter));
  const attemptId = attempt(plan, a).attemptId;
  const input = { predecessorAttemptId: attemptId, repairDecisionId: repairInput(3).decisionId, reason: "Fixed launch infrastructure" };
  const retry = (q: s.PlanSnapshot) => s.retryQueueInfrastructure(q, context(q), a, input, adapter);
  const noIntent = release(plan, a, adapter);
  const inspectedBefore = inspected.length;
  const freshAfterNoIntent = retry(noIntent);
  assert.equal(inspected.length, inspectedBefore, "no run identity exists to audit");
  assert.deepEqual(attempt(s.deserializePlan(s.serializePlan(freshAfterNoIntent)), a).reservation?.infrastructureRetry,
    { predecessorAttemptId: attemptId, repairDecisionId: input.repairDecisionId });
  assert.throws(() => s.retryQueueInfrastructure(noIntent, context(noIntent), a, input, { ...adapter, available: () => false }), /runtime_unavailable/);
  mutate(q => begin(q, a, "unsent", adapter));
  assert.throws(() => retry(plan), /definite non-send/);
  assert.throws(() => release(plan, a, adapter), /positive/);
  facts.set("unsent", { state: "working", owner: "runtime" });
  assert.throws(() => retry(plan), /definite non-send/);
  assert.throws(() => release(plan, a, adapter), /positive/);
  facts.set("unsent", { state: "settled" });
  assert.throws(() => retry(release(plan, a, adapter)), /definite non-send/);
  facts.set("unsent", { state: "not_dispatched" });
  const separatelyBlocked = s.setBlocker(plan, context(plan), a, { attemptId, code: "scope_decision", effects: "none", decisionOwner: "user", summary: "Choose scope", requestedAction: "Decide scope" });
  assert.throws(() => retry(release(separatelyBlocked, a, adapter)), /conflicting block/);
  const unrelatedReview = s.submitReview(plan, context(plan), a, "Unrelated review");
  assert.throws(() => retry(release(s.reject(unrelatedReview, context(unrelatedReview), a, "Review rejected"), a, adapter)), /conflicting block/);
  const eventId = dispatchFailureEventId("unsent");
  importPlanEnvelope(store, { sessionManager: sm } as Parameters<typeof importPlanEnvelope>[1],
    { planId: plan.planId, taskId: a, attemptId, authority: plan.authority }, "unsent",
    { message: { customType: "subagent_result", content: "Failure before send", details: { eventId, error: "Launch failed before send" } },
      options: { triggerTurn: true, deliverAs: "steer" } });
  plan = store.read(sm).snapshot!;
  assert.equal(task(plan, a).status, "failed");
  mutate(q => release(q, a, adapter));

  sm = SessionManager.open(sm.getSessionFile()!);
  store = persistence();
  const restored = store.restore(sm).snapshot!;
  assert.deepEqual(restored, plan);
  plan = restored;
  assert.equal(attempt(plan, a).reservation?.release?.proof, "not_dispatched");
  assert.throws(() => s.retry(plan, context(plan), a, undefined, adapter), /repair_limit_reached/);
  assert.throws(() => replacement(plan, a, 4), /limit/);
  assert.throws(() => s.retryQueueInfrastructure(plan, { ...context(plan), expectedRevision: plan.revision - 1 }, a, input, adapter), /Revision conflict/);
  assert.throws(() => s.retryQueueInfrastructure(plan, context(plan), a, { ...input, force: true } as typeof input, adapter), /Unsupported queue field/);
  assert.throws(() => s.retryQueueInfrastructure(plan, context(plan), a, { ...input, repairDecisionId: repairInput(2).decisionId }, adapter), /current replacement/);
  assert.throws(() => retry(s.queuePause(plan, context(plan), "Pause")), /queue_paused/);
  assert.throws(() => retry(start(plan, peer, adapter)), /capacity_exhausted/);
  for (const observation of [{ state: "unknown" }, { state: "working", owner: "runtime" }, { state: "settled" }, { state: "not_dispatched", proposal: true }] as const) {
    facts.set("unsent", observation);
    assert.throws(() => retry(plan), /cannot reaffirm definite non-send/);
  }
  facts.set("unsent", { state: "not_dispatched" });
  const decisions = task(plan, a).repairs;
  mutate(retry);
  assert.deepEqual(inspected.at(-1), { planId: plan.planId, authority: plan.authority, taskId: a, attemptId, runId: "unsent" });
  assert.deepEqual(task(plan, a).repairs, decisions);
  const latest = attempt(plan, a);
  assert.notEqual(latest.attemptId, attemptId);
  assert.deepEqual(latest.reservation?.infrastructureRetry, { predecessorAttemptId: attemptId, repairDecisionId: input.repairDecisionId });
  assert.equal(latest.reservation?.phase, "reserved");
  assert.deepEqual(latest.runIds, []);
  assert.throws(() => retry(plan), /Current queue reservation required/);
  assert.throws(() => begin(plan, a, "unsent", adapter), /Duplicate run ID/);
  assert.throws(() => s.verifyQueueDispatchIntent(plan, context(plan), a, attemptId, "unsent", cwdFor(plan, a), adapter), /Current queue reservation required/);
  assert.deepEqual(store.restore(SessionManager.open(sm.getSessionFile()!)).snapshot, plan);

  const rebuild = (attempts: readonly s.Attempt[]) => s.deserializePlan(JSON.stringify({ ...plan, tasks: [{ ...task(plan, a), attempts }, task(plan, peer)] }));
  const [original, predecessor] = task(plan, a).attempts;
  const link = latest.reservation!.infrastructureRetry!;
  const forged = (patch: object | undefined) => rebuild([original, predecessor, { ...latest, reservation: { ...latest.reservation!, infrastructureRetry: patch } }]);
  assert.throws(() => forged(undefined), /lacks prior repair decision/);
  assert.throws(() => forged({ ...link, predecessorAttemptId: original.attemptId }), /retry lineage/);
  assert.throws(() => forged({ ...link, repairDecisionId: repairInput(2).decisionId }), /retry lineage/);
  assert.throws(() => forged({ ...link, bypass: true }), /Unsupported queue field/);
  const oldRelease = predecessor.reservation!.release!;
  assert.throws(() => rebuild([original, { ...predecessor, reservation: { ...predecessor.reservation!, dispatchedRevision: oldRelease.revision, release: { ...oldRelease, proof: "settled" } } }, latest]), /definite non-send/);
  assert.throws(() => rebuild([original, { ...predecessor, results: [] }, latest]), /definite non-send/, "failed status without matching import cannot carry a repair decision");

  mutate(q => begin(q, a, "fresh-run", adapter));
  facts.set("fresh-run", { state: "settled" });
  mutate(q => release(q, a, adapter));
  assert.throws(() => s.retryQueueInfrastructure(plan, context(plan), a, { ...input, predecessorAttemptId: latest.attemptId }, adapter), /definite non-send/);
  assert.throws(() => replacement(plan, a, 4), /limit/);
});

test("post-review repair decisions survive restore, cannot replay, and stop at three", t => {
  const { workspace } = fixture(t);
  const { adapter, facts } = runtime();
  let plan = add(s.createPlan("Queue", authority), "Task"); const a = id(plan);
  plan = s.configureQueue(plan, context(plan), 1);
  plan = start(setArea(plan, a, workspace("a")), a, adapter);
  plan = begin(plan, a, "run-a", adapter);
  facts.set("run-a", { state: "working", owner: "coordinator" });
  plan = confirm(plan, a, "run-a", adapter);
  assert.equal(item(plan, a, adapter).owner, "coordinator");
  plan = s.submitReview(plan, context(plan), a, "Unchecked artifact");
  plan = evidence(plan, a);
  let sends = 0;
  const repair = (n: number) => {
    const next = s.recordQueueRepair(plan, context(plan), a, attempt(plan, a).attemptId, "run-a", cwdFor(plan, a),
      repairInput(n), adapter);
    if (next !== plan) sends++;
    plan = next;
  };
  repair(1);
  repair(1);
  assert.throws(() => accept(plan, a), /new evidence/);
  repair(2);
  repair(3);
  plan = s.deserializePlan(s.serializePlan(plan));
  assert.throws(() => repair(4), /limit/);
  assert.equal(sends, 3);
  assert.deepEqual(task(plan, a).repairs!.map(d => d.round), [1, 2, 3]);
  facts.set("run-a", { state: "settled" });
  plan = release(plan, a, adapter);
  assert.throws(() => replacement(plan, a, 4), /limit/);
  assert.throws(() => s.retry(plan, context(plan), a, undefined, adapter), /repair_limit_reached/);
  for (const changed of [s.block(plan, context(plan), a, "Blocked after review"), s.reject(plan, context(plan), a, "Failed review")]) {
    assert.throws(() => s.retry(changed, context(changed), a, undefined, adapter), /repair_limit_reached/);
    const terminal = task(changed, a).status;
    const failedOrCancelled = terminal === "failed" ? changed : s.cancel(changed, context(changed), a, "Cancel unchanged task");
    const reopened = s.reopen(failedOrCancelled, context(failedOrCancelled), a, "Reopen unchanged task");
    assert.equal(item(reopened, a, adapter).action, "resolve_blocker");
    assert.throws(() => start(reopened, a, adapter), /repair_limit_reached/);
  }
});
