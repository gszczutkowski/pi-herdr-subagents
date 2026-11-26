import type { Attempt, Authority, PlanSnapshot, PlanTask } from "./plan-store.ts";

export interface WorkArea {
  readonly cwd: string;
  readonly root: string;
  readonly kind: "git" | "directory";
  readonly access: "read" | "write";
}
export interface QueueSettings {
  readonly mode: "ready_order";
  readonly maxActive: number;
  readonly enabledRevision: number;
  readonly pause?: { readonly reason: string; readonly revision: number };
}
export interface DependencyGeneration { readonly taskId: string; readonly generation: number }
export interface InfrastructureRetryLink {
  readonly repairDecisionId: string;
  readonly predecessorAttemptId: string;
}
export interface InfrastructureRetryInput extends InfrastructureRetryLink { readonly reason: string }
export interface Reservation {
  readonly infrastructureRetry?: InfrastructureRetryLink;
  readonly phase: "reserved" | "uncertain" | "dispatched" | "released";
  readonly area: WorkArea;
  readonly dependencies: readonly DependencyGeneration[];
  readonly runId?: string;
  readonly dispatchedRevision?: number;
  readonly release?: { readonly reason: string; readonly revision: number; readonly proof: "not_dispatched" | "settled" };
}
export const BLOCKER_CODES = ["repair_failed", "provider_restriction", "infrastructure", "missing_capability", "uncertain_effects", "scope_decision", "invalid_result", "unknown"] as const;
export const BLOCKER_EFFECTS = ["none", "partial", "completed", "unknown"] as const;
export interface BlockerInput {
  readonly attemptId?: string;
  readonly code: typeof BLOCKER_CODES[number];
  readonly effects: typeof BLOCKER_EFFECTS[number];
  readonly decisionOwner: "parent" | "user";
  readonly summary: string;
  readonly requestedAction: string;
}
export interface QueueBlocker extends BlockerInput { readonly revision: number }
export interface QueueReview {
  readonly attemptId?: string;
  readonly dependencies: readonly DependencyGeneration[];
  readonly revision: number;
}
export interface RepairInput {
  readonly decisionId: string;
  readonly reviewRef: string;
  readonly artifactVersion: string;
  readonly reason: string;
}
export interface QueueRepair extends RepairInput {
  readonly attemptId: string;
  readonly replacement?: true;
  readonly round: number;
  readonly revision: number;
}

export interface QueueRuntimeBinding {
  readonly planId: string;
  readonly authority: Authority;
  readonly taskId: string;
  readonly attemptId: string;
  readonly runId: string;
}
export type QueueRuntimeObservation =
  | { readonly state: "unknown" }
  | { readonly state: "working"; readonly owner: "coordinator" | "runtime"; readonly proposal?: boolean }
  | { readonly state: "not_dispatched" | "settled"; readonly proposal?: boolean };
/** Trusted local, synchronous, non-reentrant runtime adapter (never a tool argument).
 * `available` asserts durable custody and admission support. `inspect` must check
 * exact binding; missing manifest/history, abort or exit of just the root are
 * not proof. `settled` covers the entire tree and all dispatches; `not_dispatched`
 * requires affirmative evidence nothing crossed the dispatch boundary. */
export interface QueueRuntimeAdapter {
  readonly available: (plan: PlanSnapshot) => boolean;
  readonly inspect: (binding: QueueRuntimeBinding) => QueueRuntimeObservation;
  /** Affirmatively excludes known/conflicting runtime intent under current custody.
   * Missing evidence, a fault, or already resolved dispatch is not permission. */
  readonly canPrepareDispatch?: (binding: QueueRuntimeBinding) => boolean;
}
export interface QueueFacts {
  readonly writable?: boolean;
  readonly available?: boolean;
  readonly verifiedTaskIds?: ReadonlySet<string>;
  readonly checkedTaskIds?: ReadonlySet<string>;
  readonly deferredTaskIds?: ReadonlySet<string>;
  readonly inconclusiveTaskIds?: ReadonlySet<string>;
  readonly observations?: ReadonlyMap<string, QueueRuntimeObservation>;
}
export interface QueueReason { readonly code: string; readonly taskId?: string; readonly attemptId?: string }
export interface NextAction {
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly state: "uncertain" | "closed" | "review" | "decision" | "assigned" | "working" | "wait" | "ready";
  readonly owner: "parent" | "coordinator" | "user" | "runtime" | "none";
  readonly reasons: readonly QueueReason[];
  readonly action: "inspect_recovery" | "none" | "inspect_result" | "resolve_blocker" | "dispatch_bound" | "continue_plan" | "await_result" | "revise_or_skip" | "await_dependency" | "set_work_area" | "await_resource" | "await_capacity" | "check_work_area" | "start_attempt" | "release_reservation";
}
export interface NextActions {
  readonly planId: string;
  readonly revision: number;
  readonly paused: boolean;
  readonly maxActive: number;
  readonly occupied: number;
  readonly areaChecksComplete: boolean;
  /** Omitted when deferred I/O may change the answer; null means known empty. */
  readonly firstReadyTaskId?: string | null;
  readonly items: readonly NextAction[];
}

const pathKey = (path: string) => process.platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path;
export const sameAreaPath = (a: string, b: string) => pathKey(a) === pathKey(b);
function containsPath(parent: string, child: string): boolean {
  const separator = process.platform === "win32" ? "\\" : "/";
  const root = pathKey(parent);
  return pathKey(child).startsWith(root.endsWith(separator) ? root : root + separator);
}
export function areaContainsCwd(area: WorkArea): boolean {
  return sameAreaPath(area.root, area.cwd) || (area.kind === "git" && containsPath(area.root, area.cwd));
}
export function areasConflict(a: WorkArea, b: WorkArea): boolean {
  return (a.access === "write" || b.access === "write") && (sameAreaPath(a.root, b.root) ||
    ((a.kind === "directory" || b.kind === "directory") && (containsPath(a.root, b.root) || containsPath(b.root, a.root))));
}

// The accept decision revision is an immutable per-task generation, not the
// plan's current revision. Follow recorded snapshots transitively: an accepted
// dependency cannot lend stale authority after its own prerequisite changes.
const indexTasks = (plan: PlanSnapshot) => new Map(plan.tasks.map(task => [task.taskId, task]));
function generations(tasks: ReadonlyMap<string, PlanTask>): (id: string) => number | undefined {
  const cache = new Map<string, number | undefined>();
  function generation(id: string): number | undefined {
    if (cache.has(id)) return cache.get(id);
    cache.set(id, undefined);
    const task = tasks.get(id);
    const decision = task?.decisions.at(-1);
    if (task?.status !== "accepted" || decision?.kind !== "accept") return undefined;
    const dependencies = decision.dependencies ?? [];
    if (dependencies.length !== task.dependencies.length || !task.dependencies.every((id, i) =>
      dependencies[i]?.taskId === id && generation(id) === dependencies[i].generation)) return undefined;
    cache.set(id, decision.revision);
    return decision.revision;
  }
  return generation;
}
function capture(task: PlanTask, generation: ReturnType<typeof generations>): DependencyGeneration[] | undefined {
  const result: DependencyGeneration[] = [];
  for (const taskId of task.dependencies) {
    const version = generation(taskId);
    if (version === undefined) return undefined;
    result.push({ taskId, generation: version });
  }
  return result;
}
export function captureDependencies(plan: PlanSnapshot, task: PlanTask): DependencyGeneration[] | undefined {
  return capture(task, generations(indexTasks(plan)));
}
export function sameDependencies(a: readonly DependencyGeneration[] | undefined, b: readonly DependencyGeneration[] | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((dep, i) => dep.taskId === b[i].taskId && dep.generation === b[i].generation);
}

/** A result from an old attempt or dependency generation cannot be made fresh
 * by re-adding the citation. Same-tree repairs do not yet correlate new result
 * events to individual rounds, so require independent parent evidence there. */
export function isQueueResultEvidenceCurrent(task: PlanTask, eventId: string, attempt: Attempt | undefined, dependencies: readonly DependencyGeneration[] | undefined, before = Infinity): boolean {
  return !!attempt && attempt.results.some(result => result.eventId === eventId && (result.kind ?? "result") === "result") &&
    sameDependencies(attempt.reservation?.dependencies, dependencies) &&
    !task.repairs?.some(repair => !repair.replacement && repair.attemptId === attempt.attemptId && repair.revision < before) &&
    !task.decisions.some(decision => decision.kind === "invalidate" && decision.revision < before &&
      decision.revision > (attempt.reservation?.dispatchedRevision ?? 0));
}
/** First manual acceptance with no attempt and no dependency/review epoch
 * preserves legacy evidence semantics. Other acceptances require fresh proof. */
export function queueEvidenceMinimum(task: PlanTask, attempt: Attempt | undefined, dependencies: readonly DependencyGeneration[], before = Infinity): number | undefined {
  const invalidation = task.decisions.findLast(decision => decision.kind === "invalidate" && decision.revision < before)?.revision;
  const review = task.queueReview?.attemptId === attempt?.attemptId && task.queueReview && task.queueReview.revision < before ? task.queueReview.revision : undefined;
  if (!attempt && !invalidation && !dependencies.length && !review) return undefined;
  const dispatch = attempt?.reservation?.dispatchedRevision;
  const latestReview = task.statusHistory.findLast(change => change.status === "in_review" && change.revision < before)?.revision;
  const repair = task.repairs?.findLast(decision => !decision.replacement && decision.attemptId === attempt?.attemptId && decision.revision < before)?.revision;
  return Math.max(invalidation ?? 0, review ?? 0, dispatch ?? 0, latestReview ?? 0, repair ?? 0, ...dependencies.map(dependency => dependency.generation));
}

function occupiedBy(plan: PlanSnapshot) {
  return plan.tasks.flatMap(task => {
    const attempt = task.attempts.at(-1); // Schema only permits the latest reservation to be active.
    return attempt?.reservation && attempt.reservation.phase !== "released"
      ? [{ taskId: task.taskId, attemptId: attempt.attemptId, reservation: attempt.reservation }] : [];
  });
}
const terminal = ["accepted", "cancelled", "skipped"];
const broken = ["failed", "cancelled", "skipped"];
// Deliberately lifetime-scoped: definition edits do not prove that previously
// reviewed work is unrelated or reset spent rounds. Only replacement attempts
// after a review on a previously attempted task require a decision.
export function needsReplacementRepair(task: PlanTask, before = Infinity): boolean {
  const firstStart = task.statusHistory.find(change => change.status === "in_progress")?.revision;
  return firstStart !== undefined && task.statusHistory.some(change => change.status === "in_review" && change.revision > firstStart && change.revision < before);
}
export function replacementRepairBlocker(task: PlanTask): string | undefined {
  if (!needsReplacementRepair(task)) return undefined;
  const prior = task.attempts.at(-1);
  if (task.repairs?.some(repair => repair.replacement && repair.attemptId === prior?.attemptId)) return undefined;
  return (task.repairs?.length ?? 0) >= 3 ? "repair_limit_reached" : "replacement_repair_required";
}
/** Never override a user/scope/unknown-effects block. A plain blocked state is
 * eligible only if the release itself created it, not if a separate decision did. */
export function isDefiniteUnsentRetryPredecessor(task: PlanTask, attempt: Attempt, before = Infinity): boolean {
  const reservation = attempt.reservation;
  const release = reservation?.release;
  if (reservation?.phase !== "released" || reservation.dispatchedRevision !== undefined ||
    release?.proof !== "not_dispatched" || release.revision >= before) return false;
  const statusIndex = task.statusHistory.findLastIndex(change => change.revision < before);
  const status = task.statusHistory[statusIndex];
  if (status?.status === "failed") {
    // The canonical pre-send failure import moves in_progress to failed.
    // A review rejection or another unrelated decision is not that import.
    return !!reservation.runId && status.revision < release.revision && task.statusHistory[statusIndex - 1]?.status === "in_progress" &&
      attempt.results.some(result => result.runId === reservation.runId && result.eventId === `subagent:${reservation.runId}:dispatch-failure:launch` &&
        result.kind === "failure" && result.reason === status.reason);
  }
  if (status?.status !== "blocked") return false;
  const blocker = task.blockers?.find(block => block.revision === status.revision);
  if (!blocker) return status.revision === release.revision && status.reason === release.reason;
  return blocker.attemptId === attempt.attemptId && blocker.code === "infrastructure" && blocker.effects === "none" && blocker.decisionOwner === "parent";
}
function blockers(plan: PlanSnapshot, task: PlanTask, facts: QueueFacts, occupied: ReturnType<typeof occupiedBy>,
  tasks: ReadonlyMap<string, PlanTask>, currentGeneration: (id: string) => number | undefined, ownAttemptId?: string): QueueReason[] {
  const reasons: QueueReason[] = [];
  const add = (code: string, taskId?: string, attemptId?: string) => reasons.push({ code, ...(taskId && { taskId }), ...(attemptId && { attemptId }) });
  for (const id of task.dependencies) {
    const dep = tasks.get(id);
    if (dep && broken.includes(dep.status)) add("dependency_terminal", id);
    else if (currentGeneration(id) === undefined) add(dep?.status === "accepted" ? "dependency_stale" : "dependency_unaccepted", id);
  }
  if (plan.queue?.pause) add("queue_paused");
  const areaStatus = (id: string, prefix: "work_area" | "reservation_area") =>
    facts.checkedTaskIds === undefined || facts.checkedTaskIds.has(id) ? `${prefix}_unverified` :
      facts.inconclusiveTaskIds?.has(id) ? `${prefix}_check_inconclusive` :
        facts.deferredTaskIds?.has(id) ? `${prefix}_check_deferred` : `${prefix}_unchecked`;
  if (!task.workArea) add("work_area_missing");
  else if (!facts.verifiedTaskIds?.has(task.taskId)) add(areaStatus(task.taskId, "work_area"));
  const repairBlocker = !ownAttemptId && (task.status === "pending" || task.status === "failed" || task.status === "blocked" || task.status === "in_review")
    ? replacementRepairBlocker(task) : undefined;
  if (repairBlocker) add(repairBlocker);
  const others = occupied.filter(item => item.attemptId !== ownAttemptId);
  for (const item of others) {
    if (item.taskId === task.taskId) add("prior_reservation", item.taskId, item.attemptId);
    if (!facts.verifiedTaskIds?.has(item.taskId)) add(areaStatus(item.taskId, "reservation_area"), item.taskId, item.attemptId);
    if (task.workArea && areasConflict(task.workArea, item.reservation.area)) add("work_area_conflict", item.taskId, item.attemptId);
  }
  if (others.length >= (plan.queue?.maxActive ?? 0)) {
    add("capacity_exhausted");
    for (const item of others) add("capacity_occupant", item.taskId, item.attemptId);
  }
  if (facts.writable !== true) add("parent_authority_unavailable");
  if (facts.available !== true) add("runtime_unavailable");
  return reasons;
}

/** Shared command/view admission predicate. Exclude own reservation for dispatch. */
export function queueAdmissionReasons(plan: PlanSnapshot, task: PlanTask, facts: QueueFacts, ownAttemptId?: string): QueueReason[] {
  if (!plan.queue) return [{ code: "queue_not_enabled" }];
  const tasks = indexTasks(plan);
  return blockers(plan, task, facts, occupiedBy(plan), tasks, generations(tasks), ownAttemptId);
}

/** Deterministic projection; no I/O, mutation, clock, transport, or scheduling. */
export function evaluateQueue(plan: PlanSnapshot, facts: QueueFacts = {}): NextActions | { readonly error: "queue_not_enabled" } {
  if (!plan.queue) return { error: "queue_not_enabled" };
  const tasks = indexTasks(plan);
  const generation = generations(tasks);
  const occupied = occupiedBy(plan);
  const items: NextAction[] = plan.tasks.map(task => {
    const attempt = task.attempts.at(-1);
    const reservation = attempt?.reservation;
    const active = reservation && reservation.phase !== "released";
    const observation = attempt && active && reservation.runId ? facts.observations?.get(attempt.attemptId) : undefined;
    const reasons = blockers(plan, task, facts, occupied, tasks, generation, active ? attempt?.attemptId : undefined);
    const has = (...codes: string[]) => reasons.some(r => codes.includes(r.code));
    const item = (state: NextAction["state"], owner: NextAction["owner"], action: NextAction["action"]): NextAction =>
      ({ taskId: task.taskId, attemptId: attempt?.attemptId ?? null, state, owner, reasons, action });
    const blocker = task.blockers?.at(-1);
    const latestStatus = task.statusHistory.at(-1);
    const currentBlocker = task.status === "blocked" && blocker?.revision === latestStatus?.revision ? blocker : undefined;
    if (currentBlocker) reasons.push({ code: currentBlocker.code });
    if (active) reasons.push({ code: `reservation_${reservation.phase}`, taskId: task.taskId, attemptId: attempt?.attemptId });
    const captured = task.queueReview?.dependencies ?? reservation?.dependencies;
    const current = captured ? capture(task, generation) : undefined;
    const changed = active && !sameDependencies(reservation.dependencies, current);
    if (captured && !sameDependencies(captured, current)) reasons.push({ code: "dependency_generation_changed" });
    if (active && reservation.runId && (!facts.available || !observation || observation.state === "unknown" ||
      (reservation.phase === "dispatched" && observation.state === "not_dispatched"))) {
      reasons.push({ code: "dispatch_or_release_unverified", taskId: task.taskId, attemptId: attempt?.attemptId });
      return item("uncertain", "parent", "inspect_recovery");
    }
    if (terminal.includes(task.status) && !active && !has("prior_reservation")) return item("closed", "none", "none");
    if (task.status === "in_review" || (task.status === "in_progress" && observation && "proposal" in observation && observation.proposal)) return item("review", "parent", "inspect_result");
    if (active && facts.writable && facts.available && (observation?.state === "settled" || observation?.state === "not_dispatched" ||
      (!reservation.runId && (changed || task.status !== "in_progress" || has("work_area_unverified", "work_area_missing"))))) return item("decision", "parent", "release_reservation");
    if (task.status === "blocked" || task.status === "failed") return item("decision", currentBlocker?.decisionOwner ?? "parent", "resolve_blocker");
    if (active && observation?.state === "working") return item("working", observation.owner, "await_result");
    if (task.status === "in_progress" && active && !reservation.runId && !changed && facts.available && facts.writable) {
      if (has("queue_paused")) return item("wait", "parent", "continue_plan");
      if (reasons.every(r => r.code === "reservation_reserved")) return item("assigned", "parent", "dispatch_bound");
    }
    if (task.status === "in_progress" && (!active || !facts.available || !facts.writable)) return item("uncertain", "parent", "inspect_recovery");
    if (has("dependency_terminal")) return item("decision", "parent", "revise_or_skip");
    if (has("dependency_unaccepted", "dependency_stale")) return item("wait", "parent", "await_dependency");
    if (has("queue_paused")) return item("wait", "parent", "continue_plan");
    if (task.status === "pending" && !active && has("work_area_missing", "work_area_unverified")) return item("decision", "parent", "set_work_area");
    if (has("replacement_repair_required", "repair_limit_reached")) return item("decision", "parent", "resolve_blocker");
    if (has("reservation_area_unverified") && !has("capacity_exhausted")) return item("uncertain", "parent", "inspect_recovery");
    if (has("work_area_conflict", "prior_reservation")) return item("wait", "runtime", "await_resource");
    if (has("capacity_exhausted")) return item("wait", "runtime", "await_capacity");
    if (has("work_area_check_deferred", "reservation_area_check_deferred", "work_area_check_inconclusive", "reservation_area_check_inconclusive")) return item("wait", "parent", "check_work_area");
    if (task.status === "pending" && !active && reasons.length === 0) return item("ready", "parent", "start_attempt");
    return item("uncertain", "parent", "inspect_recovery");
  });
  const areaChecksComplete = !facts.deferredTaskIds?.size && !facts.inconclusiveTaskIds?.size;
  // A checked alias later in the list may be ready while an earlier candidate
  // is deferred. Report a first candidate only if its precedence is known.
  const first = items.find((item, i) => item.state === "ready" || (plan.tasks[i].status === "pending" && item.action === "check_work_area"));
  const firstReadyTaskId = first?.state === "ready" ? first.taskId : areaChecksComplete ? null : undefined;
  return { planId: plan.planId, revision: plan.revision, paused: !!plan.queue.pause, maxActive: plan.queue.maxActive,
    occupied: occupied.length, areaChecksComplete, ...(firstReadyTaskId !== undefined && { firstReadyTaskId }), items };
}
