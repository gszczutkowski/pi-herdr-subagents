import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureDispatchEvidence, readDispatchEvidence, type DispatchEvidence } from "../pi-extension/subagents/dispatch-recovery.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { queueDispatchProof } from "../pi-extension/subagents/queue-dispatch-proof.ts";
import { beginQueueLaunch } from "../pi-extension/subagents/queue-launch-gate.ts";
import { createQueueRuntimeAdapter, type QueueRuntimeSource } from "../pi-extension/subagents/queue-runtime-adapter.ts";
import * as plans from "../pi-extension/subagents/plan-store.ts";
import { dispatchFailureEventId, RuntimeStore, type DurableEvent, type DurableRun } from "../pi-extension/subagents/runtime-store.ts";

const binding = { planId: "p", taskId: "t", attemptId: "a", authority: { sessionId: "parent", branchInstanceId: "branch" } };
const runId = "run", eventId = dispatchFailureEventId(runId);
const claim = { runId, binding };
const parent = { sessionFile: "parent.jsonl", headerId: "parent", branchToken: "branch", checkpoint: "checkpoint" };
const proof = (input: { run?: Partial<DurableRun>; event?: Partial<DurableEvent>; runtime?: Partial<NonNullable<Parameters<typeof queueDispatchProof>[1]>> } = {}) => {
  const run: DurableRun = {
    id: runId, name: "test", task: "test", startTime: 1, sessionFile: "child", planTask: binding,
    phase: "prepared", eventCursor: [eventId], ...input.run,
  };
  const event: DurableEvent = {
    status: "handedOff", runId, envelope: { message: { customType: "subagent_result", content: "failed",
      details: { error: "failed before send", eventId } }, options: { triggerTurn: true, deliverAs: "steer" } }, ...input.event,
  };
  return {
    store: { dispatchCustody: (): ReturnType<RuntimeStore["dispatchCustody"]> => ({ parent }), getRun: () => run, getEvent: (id: string) => id === eventId ? event : undefined },
    incidents: new Map(), storageUncertain: false, ...input.runtime,
  };
};

test("queue proof requires the exact run, binding, and sole before-send failure tombstone", () => {
  assert.deepEqual(queueDispatchProof(claim, proof()), { kind: "not_dispatched", runId });
  for (const fixture of [
    proof({ run: { planTask: { ...binding, attemptId: "old" } } }),
    proof({ run: { id: "foreign" } }),
    proof({ run: { eventCursor: [] } }),
    proof({ run: { eventCursor: [eventId, "possible-execution"] } }),
    proof({ event: { status: "pending" } }),
    proof({ event: { status: "dispatching" } }),
    proof({ event: { runId: "foreign" } }),
    proof({ runtime: { incidents: new Map([[runId, { status: "still-blocked", phase: "before-send" }]]) } }),
    proof({ runtime: { incidents: new Map([[runId, { status: "resolved", phase: "send-possible" }]]) } }),
  ]) assert.equal(queueDispatchProof(claim, fixture).kind, "uncertain");
});

test("queue proof refuses missing, paused and conflicting custody without interpreting stale evidence", () => {
  assert.equal(queueDispatchProof(claim, undefined).kind, "uncertain");
  const runtime = proof();
  let read = false;
  runtime.store.getRun = () => { read = true; assert.fail("must not read run after losing custody"); };
  assert.equal(queueDispatchProof(claim, { ...runtime, storageUncertain: true }).kind, "uncertain");
  runtime.store.dispatchCustody = () => ({ parent, custodyPaused: "branch changed" });
  assert.equal(queueDispatchProof(claim, runtime).kind, "uncertain");
  runtime.store.dispatchCustody = () => ({ parent: { ...parent, headerId: "foreign" } });
  assert.equal(queueDispatchProof(claim, runtime).kind, "uncertain");
  runtime.store.dispatchCustody = () => { throw new Error("lost lease"); };
  assert.equal(queueDispatchProof(claim, runtime).kind, "uncertain");
  assert.equal(read, false);
});

test("current supervision is not closure; old result and pending continuation cannot attest release", () => {
  const runtime = proof({ run: { phase: "supervised", dispatchVerified: true } });
  assert.deepEqual(queueDispatchProof(claim, runtime), { kind: "uncertain", runId, reason: "tree_unaccounted" });
  const supervised = { runId, store: runtime.store, owner: "coordinator" as const };
  assert.deepEqual(queueDispatchProof(claim, { ...runtime, supervised }), { kind: "working", runId, owner: "coordinator" });
  const continued = proof({ run: { phase: "supervised", continuationRequestId: "unknown-receipt" } });
  assert.deepEqual(queueDispatchProof(claim, { ...continued, supervised: { ...supervised, store: continued.store } }),
    { kind: "uncertain", runId, reason: "continuation" });
  assert.equal(queueDispatchProof(claim, { ...runtime, supervised: { ...supervised, store: proof().store } }).kind, "uncertain");
  const prepared = proof();
  assert.equal(queueDispatchProof(claim, { ...prepared, supervised: { ...supervised, store: prepared.store } }).kind, "uncertain");
});

test("writer rotation distinguishes exact before-send failure from missing and send-possible records", () => {
  const directory = mkdtempSync(join(tmpdir(), "queue-proof-"));
  let store = new RuntimeStore(directory, parent);
  try {
    const run = { id: runId, name: "test", task: "test", startTime: 1, sessionFile: "child", planTask: binding };
    const envelope = { message: { customType: "subagent_result", content: "failed before send", details: { eventId, error: "failed" } },
      options: { triggerTurn: true as const, deliverAs: "steer" as const } };
    const current = () => ({ store, incidents: new Map(), storageUncertain: false });
    assert.equal(queueDispatchProof(claim, current()).kind, "uncertain");
    store.recordDispatchFailure(run, envelope);
    const ambiguous = { ...run, id: "ambiguous" };
    store.prepare(ambiguous);
    store.phase(ambiguous.id, "dispatch-intent");
    store.close();
    store = new RuntimeStore(directory, parent);
    assert.equal(queueDispatchProof(claim, current()).kind, "not_dispatched");
    assert.equal(queueDispatchProof({ ...claim, runId: ambiguous.id }, current()).kind, "uncertain");
    const beforePause = current();
    store.pauseCustody("branch changed");
    assert.deepEqual(queueDispatchProof(claim, beforePause), { kind: "uncertain", runId, reason: "custody" },
      "a current lease and previously verified incident do not override a later revocation");
  } finally {
    try { store.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

function queueFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "queue-adapter-"));
  let writer: RuntimeStore | undefined;
  t.after(() => { try { writer?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const sm = SessionManager.create(directory, directory);
  const user = sm.appendMessage({ role: "user", content: "Parent", timestamp: 1 });
  const checkpoint = sm.appendCustomEntry("subagent-custody", { branchToken: "queue-owner" });
  writer = new RuntimeStore(join(directory, "runtime"), { sessionFile: canonicalSessionPath(sm.getSessionFile()!),
    headerId: sm.getSessionId(), checkpoint, branchToken: "queue-owner" });
  let supervised: ReturnType<QueueRuntimeSource["supervision"]>;
  let storageFault = false;
  const dispatchEvidence = new Map<string, DispatchEvidence>();
  const source: QueueRuntimeSource = { assertCurrent: () => { if (storageFault) throw new Error("Runtime storage fenced"); },
    dispatchEvidence, supervision: () => supervised };
  const persistence = new PlanPersistence((type, data) => sm.appendCustomEntry(type, data), false);
  const adapter = createQueueRuntimeAdapter(persistence, sm, writer, source);
  const { planId } = persistence.create(sm, 0, "Queue");
  const read = () => persistence.read(sm).snapshot!;
  const mutate = (command: Parameters<PlanPersistence["mutate"]>[3]) => persistence.mutate(sm, planId, read().revision, command);
  mutate((p, c) => plans.configureQueue(p, c, 1));
  const { taskId } = mutate((p, c) => plans.addTask(p, c, "Task")).tasks[0];
  mutate((p, c) => plans.setWorkArea(p, c, taskId, directory, "write"));
  const parentFile = sm.getSessionFile()!;
  const beforeReserve = readFileSync(parentFile);
  const reserved = mutate((p, c) => plans.startAttempt(p, c, taskId, undefined, adapter));
  const beforeClaim = readFileSync(parentFile);
  const { attemptId } = reserved.tasks[0].attempts[0];
  const runId = randomUUID(), sessionFile = canonicalSessionPath(join(directory, "child.jsonl"));
  const permit = beginQueueLaunch(persistence, sm, writer, { planId, taskId, attemptId, expectedRevision: reserved.revision },
    { runId, sessionFile, cwd: directory }, source);
  const claim = { ...permit.binding, runId };
  const run = { id: runId, name: "test", task: "test", startTime: 1, sessionFile, cli: "pi", planTask: permit.binding, profile: { cwd: directory } };
  const release = () => mutate((p, c) => plans.releaseReservation(p, c, taskId, attemptId, "Done", adapter));
  // Reopen actual durable history with the suffix gone, not a /tree selection
  // where PlanPersistence can still see the abandoned future and reject writes.
  function rollback(through: "reserved" | "pending") {
    writeFileSync(parentFile, through === "reserved" ? beforeClaim : beforeReserve);
    const reopened = SessionManager.open(parentFile);
    const persistence = new PlanPersistence((type, data) => reopened.appendCustomEntry(type, data), false);
    const view = () => persistence.read(reopened);
    const adapter = createQueueRuntimeAdapter(persistence, reopened, writer!, source);
    const mutate = (command: Parameters<PlanPersistence["mutate"]>[3]) => persistence.mutate(reopened, planId, view().snapshot!.revision, command);
    const relaunch = (runId = randomUUID()) => beginQueueLaunch(persistence, reopened, writer!, { planId, taskId, attemptId, expectedRevision: view().snapshot!.revision },
      { runId, sessionFile, cwd: directory }, source);
    return { view, adapter, mutate, relaunch, release: () => mutate((p, c) => plans.releaseReservation(p, c, taskId, attemptId, "Done", adapter)) };
  }
  return { adapter, writer, read, mutate, permit, claim, run, release, reserved, sm, user, dispatchEvidence, rollback,
    supervise: (value: typeof supervised) => { supervised = value; }, fault: (value: boolean) => { storageFault = value; } };
}

for (const location of ["journal", "memory", "retained evidence", "manifest run"] as const) test(`first launch refuses a target ID already present in unbound ${location}`, (t) => {
  const { rollback, run, writer, sm, dispatchEvidence } = queueFixture(t);
  const occupiedSessionFile = canonicalSessionPath(join(writer.directory, "unbound.jsonl"));
  const durableFiles = [sm.getSessionFile()!, join(writer.directory, "manifest.json")];
  if (location === "manifest run") {
    writer.prepare({ ...run, sessionFile: occupiedSessionFile, planTask: undefined });
  } else {
    const failure = new Error("synthetic failure");
    const { record, retained } = captureDispatchEvidence(location === "memory" ? dispatchEvidence : new Map(), writer,
      { runId: run.id, sessionFile: occupiedSessionFile, startedAt: run.startTime, dispatched: false }, failure, failure);
    assert.equal(retained, "file");
    assert.equal(record.binding, undefined);
    const journal = join(writer.directory, "dispatch-evidence", `${run.id}.json`);
    if (location === "journal") durableFiles.push(journal);
    else {
      if (location === "retained evidence") writer.retainDispatchEvidence(record);
      rmSync(journal);
    }
    const merged = readDispatchEvidence(writer.directory, writer.snapshot(), dispatchEvidence);
    assert.equal(merged.storeError, undefined);
    assert.equal(merged.conflicts.size, 0);
    assert.deepEqual(merged.records.get(run.id), record);
    assert.equal(writer.getRun(run.id), undefined, "there is no manifest run to catch the collision");
  }
  const { view, adapter, relaunch } = rollback("reserved");
  const plan = view().snapshot!;
  const before = durableFiles.map(file => readFileSync(file));
  assert.equal(adapter.available(plan), true, "unbound records do not fence the entire plan");
  assert.throws(() => relaunch(run.id), /runtime_unavailable/);
  assert.deepEqual(durableFiles.map(file => readFileSync(file)), before, "collision refusal must not append a claim or alter runtime evidence");
  assert.deepEqual(view().snapshot, plan);

  const fresh = randomUUID();
  const permit = relaunch(fresh);
  const claimed = view().snapshot!;
  assert.equal(claimed.revision, plan.revision + 1);
  assert.equal(claimed.tasks[0].attempts[0].reservation?.runId, fresh);
  assert.equal(claimed.tasks[0].attempts[0].reservation?.phase, "uncertain");
  assert.deepEqual(durableFiles.slice(1).map(file => readFileSync(file)), before.slice(1), "a fresh claim mutates only the plan");
  writer.prepare({ ...run, id: fresh, planTask: permit.binding });
  permit.commitBeforeSend();
  assert.equal(writer.getRun(fresh)?.phase, "dispatch-intent");
});

for (const surviving of ["manifest", "journal"] as const) test(`adapter fences a rolled-back runless reservation with surviving ${surviving} binding`, (t) => {
  const { rollback, claim, permit, run, writer, sm, dispatchEvidence } = queueFixture(t);
  const durableFiles = [sm.getSessionFile()!, join(writer.directory, "manifest.json")];
  if (surviving === "manifest") {
    writer.prepare(run);
    permit.commitBeforeSend();
    writer.phase(run.id, "supervised");
  } else {
    const failure = new Error("synthetic failure");
    assert.equal(captureDispatchEvidence(new Map(), writer, { runId: run.id, sessionFile: run.sessionFile,
      startedAt: run.startTime, binding: run.planTask, dispatched: false }, failure, failure).retained, "file");
    assert.equal(writer.getRun(run.id), undefined, "manifest cannot account for the journal-only binding");
    durableFiles.push(join(writer.directory, "dispatch-evidence", `${run.id}.json`));
  }
  const merged = readDispatchEvidence(writer.directory, writer.snapshot(), dispatchEvidence);
  assert.equal(merged.storeError, undefined);
  assert.equal(merged.conflicts.size, 0);
  assert.equal(merged.records.size, surviving === "journal" ? 1 : 0);
  const { view, adapter, release, relaunch } = rollback("reserved");
  const plan = view().snapshot!;
  assert.equal(view().writable, true);
  assert.equal(plan.tasks[0].attempts[0].reservation?.phase, "reserved");
  assert.equal(plan.tasks[0].attempts[0].reservation?.runId, undefined);
  const before = durableFiles.map(file => readFileSync(file));
  assert.equal(adapter.available(plan), false);
  assert.deepEqual(adapter.inspect(claim), { state: "unknown" });
  assert.throws(release, /runtime unavailable/);
  assert.throws(relaunch, /runtime_unavailable/);
  assert.deepEqual(durableFiles.map(file => readFileSync(file)), before, "refusals cannot alter any durable evidence or allocation");
});

test("adapter denies fresh admission after rollback before the surviving run's reservation", (t) => {
  const { rollback, writer, permit, claim, run, sm } = queueFixture(t);
  writer.prepare(run);
  permit.commitBeforeSend();
  const { view, adapter, mutate } = rollback("pending");
  assert.equal(view().writable, true);
  assert.deepEqual(view().snapshot!.tasks[0].attempts, []);
  const durableFiles = [sm.getSessionFile()!, join(writer.directory, "manifest.json")];
  const before = durableFiles.map(file => readFileSync(file));
  assert.throws(() => mutate((p, c) => plans.startAttempt(p, c, claim.taskId, undefined, adapter)), /runtime_unavailable/);
  assert.deepEqual(durableFiles.map(file => readFileSync(file)), before);
});

test("genuinely runless release still succeeds, but conflicting evidence fences explicit retry", (t) => {
  const { rollback, writer, claim, run, sm } = queueFixture(t);
  const { adapter, view, mutate, release } = rollback("reserved");
  const retry = () => mutate((p, c) => plans.retry(p, c, claim.taskId, undefined, adapter));
  const released = release();
  assert.equal(released.tasks[0].status, "blocked");
  assert.equal(released.tasks[0].attempts[0].reservation?.release?.proof, "not_dispatched");
  assert.equal(adapter.available(view().snapshot!), true);
  // Exercise the admission predicate on exactly the same history first, then
  // simulate the runtime half of a split restore from the original claim.
  assert.equal(plans.retry(released, { ...released.authority, expectedRevision: released.revision }, claim.taskId, undefined, adapter)
    .tasks[0].attempts.length, 2);
  writer.prepare(run);
  writer.commitFreshDispatch(run.id, run.sessionFile, run.planTask);
  const durableFiles = [sm.getSessionFile()!, join(writer.directory, "manifest.json")];
  const before = durableFiles.map(file => readFileSync(file));
  assert.throws(retry, /runtime_unavailable/);
  assert.deepEqual(durableFiles.map(file => readFileSync(file)), before);
});

test("adapter uses current branch and canonical non-send evidence for release", (t) => {
  const { adapter, writer, read, claim, run, release, reserved, sm, user, fault } = queueFixture(t);
  const unknown = { state: "unknown" };
  assert.equal(adapter.available(read()), true);
  assert.equal(adapter.available(reserved), false, "cannot re-use stale plan facts");
  assert.deepEqual(adapter.inspect(claim), unknown, "missing manifest record is not non-send");
  writer.prepare(run);
  assert.throws(release, /without positive/);
  const eventId = dispatchFailureEventId(run.id);
  writer.recordDispatchFailure(run, { message: { customType: "subagent_result", content: "failed", details: { eventId, error: "pre-send failure" } },
    options: { triggerTurn: true, deliverAs: "steer" } });
  assert.deepEqual(adapter.inspect(claim), { state: "not_dispatched" });
  for (const conflicting of [
    { ...claim, planId: randomUUID() }, { ...claim, attemptId: randomUUID() }, { ...claim, runId: randomUUID() },
    { ...claim, authority: { ...claim.authority, branchInstanceId: randomUUID() } },
  ]) assert.deepEqual(adapter.inspect(conflicting), unknown);
  const journalDir = join(writer.directory, "dispatch-evidence");
  mkdirSync(journalDir);
  const badJournal = join(journalDir, `${run.id}.json`);
  writeFileSync(badJournal, "not JSON");
  assert.deepEqual(adapter.inspect(claim), unknown);
  assert.throws(release, /runtime unavailable/);
  rmSync(badJournal);
  fault(true);
  assert.deepEqual(adapter.inspect(claim), unknown);
  assert.throws(release, /runtime unavailable/);
  fault(false);
  const result = release();
  assert.equal(result.tasks[0].status, "blocked");
  assert.equal(result.tasks[0].attempts[0].reservation?.release?.proof, "not_dispatched");
  assert.deepEqual(release(), result, "replay does not free any other reservation");
  const releasedLeaf = sm.getLeafId()!;
  sm.branch(user);
  assert.deepEqual(adapter.inspect(claim), unknown, "a valid tombstone is not authority on another branch");
  sm.branch(releasedLeaf);
  assert.equal(adapter.available(result), true, "a matching tombstone permits admission after release");
  writer.phase(run.id, "supervised");
  assert.equal(adapter.available(result), false, "observed execution cannot remain outside active allocations");
});

for (const action of ["release", "commit"] as const) test(`adapter refuses ${action} when a cross-run journal conflict masks a competing binding`, (t) => {
  const { adapter, writer, read, permit, claim, run, release, sm, dispatchEvidence } = queueFixture(t);
  writer.prepare(run);
  if (action === "release") {
    const eventId = dispatchFailureEventId(run.id);
    writer.recordDispatchFailure(run, { message: { customType: "subagent_result", content: "failed", details: { eventId, error: "pre-send failure" } },
      options: { triggerTurn: true, deliverAs: "steer" } });
    assert.deepEqual(adapter.inspect(claim), { state: "not_dispatched" });
  }

  const rival = { runId: randomUUID(), sessionFile: canonicalSessionPath(join(writer.directory, "rival.jsonl")),
    startedAt: 1, binding: permit.binding, dispatched: false };
  const failure = new Error("synthetic failure");
  assert.equal(captureDispatchEvidence(new Map(), writer, rival, failure, failure).retained, "file");
  const unrelated = { ...rival, binding: { ...rival.binding, attemptId: randomUUID() } };
  const { record, retained } = captureDispatchEvidence(dispatchEvidence, writer, unrelated, failure, failure);
  assert.equal(retained, "memory-only");
  const merged = readDispatchEvidence(writer.directory, writer.snapshot(), dispatchEvidence);
  assert.equal(merged.storeError, undefined, "both records must be valid, not merely unreadable");
  assert.deepEqual(merged.conflicts, new Set([rival.runId]));
  assert.deepEqual(merged.records.get(rival.runId), record, "the visible record masks the competing binding");

  const durableFiles = [sm.getSessionFile()!, join(writer.directory, "manifest.json"),
    join(writer.directory, "dispatch-evidence", `${rival.runId}.json`)];
  const before = durableFiles.map(file => readFileSync(file));
  if (action === "release") assert.throws(release, /runtime unavailable/);
  else assert.throws(permit.commitBeforeSend, /runtime_unavailable/);
  assert.deepEqual(durableFiles.map(file => readFileSync(file)), before, "refusal must not change the plan, manifest, or journal");
  assert.equal(adapter.available(read()), false);
  assert.deepEqual(adapter.inspect(claim), { state: "unknown" });
});

test("adapter observes exact current supervision but cannot certify whole-tree settlement", (t) => {
  const { adapter, writer, read, mutate, permit, claim, run, release, supervise } = queueFixture(t);
  writer.prepare(run);
  permit.commitBeforeSend();
  const supervised = { runId: run.id, store: writer, owner: "coordinator" as const };
  supervise(supervised);
  assert.deepEqual(adapter.inspect(claim), { state: "unknown" }, "unconfirmed intent is not running proof");
  writer.phase(run.id, "supervised");
  assert.deepEqual(adapter.inspect(claim), { state: "working", owner: "coordinator" });
  mutate((p, c) => plans.confirmQueueDispatch(p, c, claim.taskId, claim.attemptId, run.id, adapter));
  assert.equal(read().tasks[0].attempts[0].reservation?.phase, "dispatched");
  supervise(undefined);
  assert.deepEqual(adapter.inspect(claim), { state: "unknown" });
  assert.throws(release, /without positive/);
  supervise(supervised);
  writer.pauseCustody("Parent writer paused");
  assert.equal(adapter.available(read()), false);
  assert.deepEqual(adapter.inspect(claim), { state: "unknown" });
});
