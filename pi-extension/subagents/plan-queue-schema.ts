import { isAbsolute, normalize } from "node:path";
import type { PlanSnapshot } from "./plan-store.ts";
import { areaContainsCwd, areasConflict, BLOCKER_CODES, BLOCKER_EFFECTS, isDefiniteUnsentRetryPredecessor, isQueueResultEvidenceCurrent, needsReplacementRepair, queueEvidenceMinimum, type BlockerInput, type DependencyGeneration, type InfrastructureRetryInput, type InfrastructureRetryLink, type RepairInput, type WorkArea } from "./plan-queue.ts";
import { sameWorkArea } from "./plan-queue-work-area.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function queueKeys(value: unknown, allowed: readonly string[]): void {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), "Unsupported queue field");
}
export function queueText(value: unknown): asserts value is string {
  check(typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !value.includes("\0") && !/[\r\n]/.test(value), "Expected nonempty queue text (1–512 characters, no raw logs)");
}
export function validateQueueLimit(value: unknown): void {
  check(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 32, "maxActive must be an integer from 1 to 32");
}
export function validateBlocker(value: BlockerInput, persisted = false): void {
  queueKeys(value, ["attemptId", "code", "effects", "decisionOwner", "summary", "requestedAction", ...(persisted ? ["revision"] : [])]);
  if (value.attemptId !== undefined) queueText(value.attemptId);
  check(BLOCKER_CODES.includes(value.code) && BLOCKER_EFFECTS.includes(value.effects) && ["parent", "user"].includes(value.decisionOwner), "Invalid blocker enum");
  queueText(value.summary); queueText(value.requestedAction);
}
export function validateRepair(value: RepairInput, persisted = false): void {
  queueKeys(value, ["decisionId", "reviewRef", "artifactVersion", "reason", ...(persisted ? ["attemptId", "revision", "round", "replacement"] : [])]);
  queueText(value.decisionId); queueText(value.reviewRef); queueText(value.artifactVersion); queueText(value.reason);
}
function validateInfrastructureRetryLink(value: InfrastructureRetryLink, command = false): void {
  queueKeys(value, ["repairDecisionId", "predecessorAttemptId", ...(command ? ["reason"] : [])]);
  queueText(value.repairDecisionId); queueText(value.predecessorAttemptId);
}
export function validateInfrastructureRetry(value: InfrastructureRetryInput): void {
  validateInfrastructureRetryLink(value, true); queueText(value.reason);
}
function validateArea(value: WorkArea): void {
  queueKeys(value, ["cwd", "root", "kind", "access"]);
  for (const path of [value.cwd, value.root]) check(typeof path === "string" && path.length <= 8192 && !path.includes("\0") && !/[\r\n]/.test(path) && isAbsolute(path) && normalize(path) === path, "Invalid canonical work area path");
  check(["git", "directory"].includes(value.kind) && ["read", "write"].includes(value.access) && areaContainsCwd(value), "Invalid work area");
}

export function validateQueueSchema(plan: PlanSnapshot): void {
  const queue = plan.queue;
  check(plan.schemaVersion === 2 ? queue !== undefined : queue === undefined, "Queue settings/schema version mismatch");
  if (!queue) {
    for (const task of plan.tasks) check(task.workArea === undefined && task.blockers === undefined && task.queueReview === undefined && task.repairs === undefined &&
      task.attempts.every(attempt => attempt.reservation === undefined) && task.evidence.every(evidence => evidence.queue === undefined) &&
      task.decisions.every(decision => decision.dependencies === undefined && decision.evidenceAfter === undefined), "Queue data requires schema version 2");
    return;
  }
  queueKeys(queue, ["mode", "maxActive", "enabledRevision", "pause"]);
  check(queue.mode === "ready_order", "Invalid queue mode");
  validateQueueLimit(queue.maxActive);
  const checkRevision = (value: number, after: number, through = plan.revision) => check(Number.isSafeInteger(value) && value > after && value <= through, "Invalid queue revision");
  checkRevision(queue.enabledRevision, 0);
  if (queue.pause !== undefined) {
    queueKeys(queue.pause, ["reason", "revision"]);
    queueText(queue.pause.reason); checkRevision(queue.pause.revision, queue.enabledRevision);
  }
  const acceptGenerations = new Map(plan.tasks.map(task => [task.taskId, new Set(task.decisions.filter(d => d.kind === "accept").map(d => d.revision))]));
  const repairIds = new Set<string>();
  const activeAreas: WorkArea[] = [];
  function validateGenerations(list: readonly DependencyGeneration[], consumerId: string, before: number): void {
    check(Array.isArray(list) && list.length <= 1000, "Invalid dependency generations");
    const ids = new Set<string>();
    for (const dependency of list) {
      queueKeys(dependency, ["taskId", "generation"]);
      checkRevision(dependency.generation, 0, before - 1);
      check(dependency.taskId !== consumerId && !ids.has(dependency.taskId) && acceptGenerations.get(dependency.taskId)?.has(dependency.generation), "Unknown or duplicate dependency generation");
      ids.add(dependency.taskId);
    }
  }
  for (const task of plan.tasks) {
    if (task.workArea !== undefined) validateArea(task.workArea);
    const starts = task.statusHistory.filter(change => change.status === "in_progress");
    const attemptAt = (revision: number) => task.attempts[starts.findLastIndex(change => change.revision <= revision)];
    for (const [index, attempt] of task.attempts.entries()) {
      const start = starts[index].revision;
      checkRevision(start, queue.enabledRevision);
      const reservation = attempt.reservation;
      check(reservation && attempt.origin?.planId === plan.planId && attempt.origin.authority.sessionId === plan.authority.sessionId && attempt.origin.authority.branchInstanceId === plan.authority.branchInstanceId, "Missing owned queue reservation");
      queueKeys(reservation, ["phase", "area", "dependencies", "runId", "dispatchedRevision", "release", "infrastructureRetry"]);
      if (reservation.infrastructureRetry !== undefined) validateInfrastructureRetryLink(reservation.infrastructureRetry);
      check(["reserved", "uncertain", "dispatched", "released"].includes(reservation.phase), "Invalid reservation phase");
      validateArea(reservation.area); validateGenerations(reservation.dependencies, task.taskId, start);
      if (reservation.runId !== undefined) queueText(reservation.runId);
      check(reservation.runId === undefined ? attempt.runIds.length === 0 : attempt.runIds.length === 1 && attempt.runIds[0] === reservation.runId, "Reservation/runtime identity mismatch");
      check(reservation.phase === "reserved" || reservation.phase === "released" || reservation.runId !== undefined, "Missing dispatch intent");
      if (reservation.phase === "reserved") check(reservation.runId === undefined, "Reserved attempt already has dispatch intent");
      const dispatched = reservation.phase === "dispatched" || reservation.release?.proof === "settled";
      check(dispatched === (reservation.dispatchedRevision !== undefined), "Missing or contradictory positive dispatch proof");
      if (reservation.dispatchedRevision !== undefined) checkRevision(reservation.dispatchedRevision, start, reservation.release?.revision ?? plan.revision);
      if (reservation.phase === "released") {
        const release = reservation.release;
        check(release, "Missing queue release record");
        queueKeys(release, ["reason", "revision", "proof"]);
        queueText(release.reason);
        checkRevision(release.revision, start, starts[index + 1] ? starts[index + 1].revision - 1 : plan.revision);
        check(release.proof === "not_dispatched" || (release.proof === "settled" && reservation.runId !== undefined), "Invalid release proof type");
      } else {
        check(reservation.release === undefined && index === task.attempts.length - 1 && task.workArea && sameWorkArea(task.workArea, reservation.area), "Invalid active reservation");
        check(activeAreas.length < 32 && !activeAreas.some(area => areasConflict(area, reservation.area)), "Conflicting active reservations");
        activeAreas.push(reservation.area);
      }
    }
    if (task.blockers !== undefined) {
      check(Array.isArray(task.blockers) && task.blockers.length > 0 && task.blockers.length <= 1000, "Invalid blockers history");
      let last = queue.enabledRevision;
      for (const block of task.blockers) {
        validateBlocker(block, true); checkRevision(block.revision, last); last = block.revision;
        check(attemptAt(block.revision)?.attemptId === block.attemptId && task.statusHistory.some(change => change.revision === block.revision && change.status === "blocked" && change.reason === block.summary), "Blocker history mismatch");
      }
    }
    const replacementRepairs = new Map<string, { decisionId: string; revision: number }>();
    if (task.repairs !== undefined) {
      check(Array.isArray(task.repairs) && task.repairs.length > 0 && task.repairs.length <= 3, "Invalid repair history");
      let last = queue.enabledRevision;
      for (const [index, repair] of task.repairs.entries()) {
        validateRepair(repair, true); checkRevision(repair.revision, last); last = repair.revision;
        const attempt = attemptAt(repair.revision);
        check(repair.round === index + 1 && attempt?.attemptId === repair.attemptId && !repairIds.has(repair.decisionId), "Repair history mismatch");
        const status = task.statusHistory.findLast(change => change.revision < repair.revision)?.status;
        const release = attempt.reservation?.release?.revision;
        if (repair.replacement === true) {
          check(release !== undefined && release < repair.revision && needsReplacementRepair(task, repair.revision) &&
            ["pending", "in_review", "failed", "blocked"].includes(status ?? "") && !replacementRepairs.has(repair.attemptId), "Invalid replacement repair decision");
          replacementRepairs.set(repair.attemptId, repair);
        } else check(repair.replacement === undefined && status === "in_review" && attempt.reservation?.runId &&
          (release === undefined || repair.revision < release), "Invalid same-tree repair decision");
        repairIds.add(repair.decisionId);
      }
    }
    const firstAttemptReview = task.statusHistory.find(change => change.status === "in_review" && change.revision > (starts[0]?.revision ?? Infinity));
    let appliedDecisionId: string | undefined;
    for (const [i, start] of starts.entries()) {
      const link = task.attempts[i].reservation?.infrastructureRetry;
      const predecessor = task.attempts[i - 1];
      if (link) {
        const latestDecision = task.repairs?.findLast(repair => repair.revision < start.revision);
        check(predecessor?.attemptId === link.predecessorAttemptId && link.repairDecisionId === appliedDecisionId &&
          latestDecision?.decisionId === appliedDecisionId && isDefiniteUnsentRetryPredecessor(task, predecessor, start.revision),
        "Invalid infrastructure retry lineage or definite non-send proof");
        queueText(start.reason);
      } else if (predecessor && firstAttemptReview && firstAttemptReview.revision < start.revision) {
        const decision = replacementRepairs.get(predecessor.attemptId);
        check(decision !== undefined && decision.revision < start.revision, "Replacement attempt lacks prior repair decision");
        appliedDecisionId = decision.decisionId;
      } else {
        appliedDecisionId = undefined;
      }
    }
    if (task.queueReview !== undefined) {
      const review = task.queueReview;
      queueKeys(review, ["attemptId", "dependencies", "revision"]);
      checkRevision(review.revision, queue.enabledRevision);
      check(review.attemptId === task.attempts.at(-1)?.attemptId && review.attemptId === attemptAt(review.revision)?.attemptId &&
        task.statusHistory.findLast(change => change.revision < review.revision)?.status === "in_review", "Invalid queue review baseline");
      validateGenerations(review.dependencies, task.taskId, review.revision);
    }
    let evidenceRevision = queue.enabledRevision;
    const evidenceById = new Map(task.evidence.map(evidence => [evidence.evidenceId, evidence]));
    for (const evidence of task.evidence) {
      if (!evidence.queue) {
        check(evidence.queue === undefined && evidenceRevision === queue.enabledRevision && evidence.resultEventId === undefined, "Invalid legacy queue evidence");
        continue;
      }
      queueKeys(evidence.queue, ["attemptId", "revision"]);
      checkRevision(evidence.queue.revision, evidenceRevision);
      evidenceRevision = evidence.queue.revision;
      const attempt = attemptAt(evidenceRevision);
      check(evidence.queue.attemptId === attempt?.attemptId && (evidence.resultEventId === undefined ||
        attempt?.results.some(result => result.eventId === evidence.resultEventId)), "Queue evidence attempt mismatch");
    }
    for (const decision of task.decisions) {
      if (decision.kind === "accept" && decision.revision > queue.enabledRevision) {
        validateGenerations(decision.dependencies!, task.taskId, decision.revision);
        const attempt = attemptAt(decision.revision);
        check(!attempt || (attempt.reservation?.dispatchedRevision !== undefined && attempt.reservation.dispatchedRevision < decision.revision), "Queue acceptance lacks positive dispatch proof");
        const minimum = queueEvidenceMinimum(task, attempt, decision.dependencies!, decision.revision);
        if (minimum !== undefined || decision.evidenceAfter !== undefined) {
          const after = decision.evidenceAfter;
          check(after !== undefined && after >= (minimum ?? 0), "Invalid queue acceptance evidence epoch");
          checkRevision(after, queue.enabledRevision, decision.revision - 1);
        }
        for (const refs of Object.values(decision.criteria)) for (const id of refs) {
          const evidence = evidenceById.get(id)!;
          check(!evidence.queue || evidence.queue.revision < decision.revision, "Queue acceptance predates its evidence");
          if (decision.evidenceAfter !== undefined) check(evidence.queue && evidence.queue.revision > decision.evidenceAfter && evidence.queue.attemptId === attempt?.attemptId &&
            (evidence.resultEventId === undefined || isQueueResultEvidenceCurrent(task, evidence.resultEventId, attempt, decision.dependencies, decision.revision)), "Stale queue acceptance evidence");
        }
        if (task.status === "accepted" && task.decisions.at(-1) === decision) {
          check(decision.dependencies?.length === task.dependencies.length && task.dependencies.every((id, index) => decision.dependencies?.[index]?.taskId === id), "Acceptance dependency snapshot mismatch");
        }
      } else check(decision.dependencies === undefined && decision.evidenceAfter === undefined, "Unexpected queue decision metadata");
    }
  }
}
