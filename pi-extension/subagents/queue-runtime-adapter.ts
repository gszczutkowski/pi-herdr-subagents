import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dispatchIncidents, readDispatchEvidence, type DispatchEvidence } from "./dispatch-recovery.ts";
import { canonicalSessionPath } from "./ownership.ts";
import type { PlanPersistence } from "./plan-persistence.ts";
import type { QueueRuntimeAdapter, QueueRuntimeBinding, QueueRuntimeObservation, Reservation } from "./plan-queue.ts";
import { samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import type { PlanSnapshot } from "./plan-store.ts";
import { queueDispatchProof } from "./queue-dispatch-proof.ts";
import { dispatchFailureEventId, dispatchRunIdPattern, type RuntimeStore } from "./runtime-store.ts";

export interface QueueRuntimeSource {
  /** Trusted, synchronous checks of the captured extension instance, current
   * store and storage/recovery fault latches. Must throw on loss of custody. */
  readonly assertCurrent: () => void;
  readonly dispatchEvidence: ReadonlyMap<string, DispatchEvidence>;
  readonly supervision: (runId: string) => NonNullable<Parameters<typeof queueDispatchProof>[1]>["supervised"];
}

/** Internal, scoped to an existing writer. Does not acquire custody, recover a
 * send permit, or turn root supervision/exit into execution-tree settlement. */
export function createQueueRuntimeAdapter(
  persistence: PlanPersistence,
  sm: ExtensionContext["sessionManager"],
  store: RuntimeStore,
  source: QueueRuntimeSource,
  launch?: { readonly runId: string; readonly sessionFile: string; readonly stage: "claim" | "prepare" },
): QueueRuntimeAdapter & { assertCustody: () => void } {
  const target = launch && { ...launch, sessionFile: canonicalSessionPath(launch.sessionFile) };
  function assertCustody() {
    source.assertCurrent();
    const { parent, custodyPaused } = store.dispatchCustody();
    const file = sm.getSessionFile();
    if (custodyPaused !== undefined || !file || parent.sessionFile === target?.sessionFile ||
        parent.headerId !== sm.getHeader()?.id || parent.headerId !== sm.getSessionId() ||
        parent.sessionFile !== canonicalSessionPath(file) ||
        !sm.getBranch().some(e => e.type === "custom" && e.customType === "subagent-custody" && e.id === parent.checkpoint &&
          (e.data as { branchToken?: unknown } | undefined)?.branchToken === parent.branchToken)) {
      throw new Error("Queue runtime requires original parent branch custody");
    }
  }
  function currentPlan() {
    assertCustody();
    const { snapshot, writable, error } = persistence.read(sm);
    if (!writable || snapshot?.schemaVersion !== 2 || !snapshot.queue) throw new Error(error ?? "Original writable queue plan is not selected");
    return snapshot;
  }
  function journal(plan: PlanSnapshot) {
    const manifest = store.snapshot();
    const evidence = readDispatchEvidence(store.directory, manifest, source.dispatchEvidence);
    if (evidence.storeError) throw new Error("Queue dispatch evidence could not be read");
    // A conflict can hide a competing binding under a different run ID.
    if (evidence.conflicts.size > 0) throw new Error("Queue dispatch evidence is conflicting");
    let incidents: Map<string, ReturnType<typeof dispatchIncidents>[number]> | undefined;
    function prove(runId: string, binding: PlanTaskBinding) {
      incidents ??= new Map(dispatchIncidents(manifest, undefined, store.directory, evidence).map(item => [item.runId, item]));
      const supervised = source.supervision(runId);
      if (supervised && supervised.runId !== runId) throw new Error("Queue supervision is conflicting");
      return queueDispatchProof({ runId, binding }, { store, incidents, storageUncertain: false, supervised });
    }

    // Check in the runtime-to-plan direction too. Plan storage may have lost a
    // suffix while a bound run survived, including before the first reservation.
    const claims = new Map<string, { binding: PlanTaskBinding; reservation: Reservation }>();
    for (const task of plan.tasks) for (const attempt of task.attempts) {
      const reservation = attempt.reservation;
      if (reservation?.runId !== undefined) claims.set(reservation.runId, { reservation,
        binding: { planId: plan.planId, authority: plan.authority, taskId: task.taskId, attemptId: attempt.attemptId } });
    }
    const released = new Map<string, PlanTaskBinding>();
    function check(runId: string, binding: PlanTaskBinding | undefined) {
      const claim = claims.get(runId);
      if (!claim && binding?.planId !== plan.planId) return;
      if (!claim || !samePlanBinding(binding, claim.binding)) throw new Error("Queue plan and runtime bindings disagree");
      if (claim.reservation.phase === "released") {
        // A historical release can coexist with its exact unsent tombstone,
        // but must not let observed execution escape active slot accounting.
        // This adapter has no evidence for whole-tree settlement.
        if (claim.reservation.release?.proof !== "not_dispatched") throw new Error("Queue release is not corroborated by runtime");
        released.set(runId, claim.binding);
      }
    }
    for (const run of Object.values(manifest.runs)) check(run.id, run.planTask);
    for (const [runId, record] of evidence.records) check(runId, record.binding);
    for (const [runId, binding] of released) {
      if (prove(runId, binding).kind !== "not_dispatched") throw new Error("Queue non-send release is not corroborated by runtime");
    }
    return { manifest, evidence, prove };
  }
  function currentClaim({ runId, ...binding }: QueueRuntimeBinding) {
    if (!dispatchRunIdPattern.test(runId)) return undefined;
    const plan = currentPlan();
    const task = plan.tasks.find(task => task.taskId === binding.taskId);
    const attempt = task?.attempts.find(attempt => attempt.attemptId === binding.attemptId);
    const reservation = attempt?.reservation;
    if (!task || !attempt || !reservation || reservation.runId !== runId || !attempt.runIds.includes(runId) ||
        !samePlanBinding(binding, { ...binding, planId: plan.planId, authority: plan.authority }) ||
        !samePlanBinding(binding, attempt.origin ? { ...binding, ...attempt.origin } : plan.source ? undefined : binding)) return undefined;
    return { plan, task, attempt, reservation, binding, runId };
  }

  const adapter: QueueRuntimeAdapter & { assertCustody: () => void } = {
    assertCustody,
    available(plan) {
      try {
        const selected = currentPlan();
        if (selected.planId !== plan.planId || selected.revision !== plan.revision ||
            selected.authority.sessionId !== plan.authority.sessionId || selected.authority.branchInstanceId !== plan.authority.branchInstanceId) return false;
        const { manifest, evidence } = journal(selected);
        // An exact ID collision makes the new claim unusable even if the old
        // record is unbound. Unrelated unbound records do not affect admission.
        return target?.stage !== "claim" || (!manifest.runs[target.runId] && !evidence.records.has(target.runId));
      } catch { return false; }
    },
    inspect(candidate): QueueRuntimeObservation {
      try {
        const claim = currentClaim(candidate);
        if (claim) {
          const { manifest, prove } = journal(claim.plan);
          const proof = prove(claim.runId, claim.binding);
          if (proof.kind === "not_dispatched") return { state: "not_dispatched" };
          if (proof.kind === "working" && manifest.runs[claim.runId]?.cli === "pi") return { state: "working", owner: proof.owner };
        }
      } catch { /* Unavailable current authority/evidence is not proof. */ }
      return { state: "unknown" };
    },
    canPrepareDispatch(candidate) {
      try {
        if (target?.stage !== "prepare" || target.runId !== candidate.runId) return false;
        const claim = currentClaim(candidate);
        if (!claim || claim.task.attempts.at(-1) !== claim.attempt || claim.task.status !== "in_progress" ||
            claim.plan.queue?.pause || claim.reservation.phase !== "uncertain") return false;
        const { manifest, evidence } = journal(claim.plan);
        const { runId, binding } = claim;
        const run = manifest.runs[runId];
        // A bare exact prepared record is required here, but is *not* proof
        // of non-send for purposes of releasing a reservation or retrying.
        return run?.id === runId && run.cli === "pi" && run.sessionFile === target.sessionFile &&
          samePlanBinding(run.planTask, binding) && run.phase === "prepared" && run.eventCursor.length === 0 &&
          run.continuationRequestId === undefined && run.reconciliation === undefined && !run.dispatchVerified &&
          !manifest.outbox[dispatchFailureEventId(runId)] && !evidence.records.has(runId) &&
          source.supervision(runId) === undefined;
      } catch { return false; }
    },
  };
  return Object.freeze(adapter);
}
