import { randomUUID } from "node:crypto";
import { captureDependencies, isDefiniteUnsentRetryPredecessor, isQueueResultEvidenceCurrent, needsReplacementRepair, queueAdmissionReasons, queueEvidenceMinimum, sameDependencies, type BlockerInput, type DependencyGeneration, type InfrastructureRetryInput, type InfrastructureRetryLink, type QueueBlocker, type QueueRepair, type QueueReview, type QueueRuntimeAdapter, type QueueSettings, type RepairInput, type Reservation, type WorkArea } from "./plan-queue.ts";
import { canonicalWorkArea, collectQueueAdmissionFacts, inspectQueueRuntime, queueRuntimeAvailable, sameWorkArea } from "./plan-queue-work-area.ts";
import { queueText, validateBlocker, validateInfrastructureRetry, validateQueueLimit, validateQueueSchema, validateRepair } from "./plan-queue-schema.ts";

/** Pure parent command layer. Callers retain the current snapshot and supply trusted
 * session/branch context; worker proposals are data, never authority. This is not
 * an OS/security sandbox. Queue gates consult local work-area identity and trusted
 * synchronous runtime observations. Revision checks protect against the supplied
 * snapshot; persistence must serialize the current-revision compare-and-append.
 */

export interface Authority { readonly sessionId: string; readonly branchInstanceId: string }
export interface CommandContext extends Authority { readonly expectedRevision: number }
export interface Attempt {
  readonly attemptId: string;
  readonly runIds: readonly string[];
  readonly childSession?: string;
  readonly origin?: { readonly planId: string; readonly authority: Authority };
  readonly results: readonly ResultReference[];
  readonly reservation?: Reservation;
}
export interface ResultReference {
  readonly eventId: string;
  readonly runId: string;
  readonly ref: string;
  readonly kind?: "result" | "ping" | "failure" | "process_exit";
  readonly reason?: string;
}
export interface StatusChange { readonly revision: number; readonly status: TaskStatus; readonly reason: string }
export type TaskStatus = "pending" | "in_progress" | "blocked" | "in_review" | "accepted" | "failed" | "skipped" | "cancelled";
export interface Criterion { readonly criterionId: string; readonly text: string }
export interface Artifact { readonly artifactId: string; readonly ref: string }
export interface Evidence { readonly evidenceId: string; readonly criterionId: string; readonly ref: string; readonly artifactId?: string; readonly resultEventId?: string; readonly queue?: { readonly revision: number; readonly attemptId?: string } }
export interface Decision { readonly revision: number; readonly kind: "accept" | "invalidate"; readonly reason: string; readonly criteria: Readonly<Record<string, readonly string[]>>; readonly dependencies?: readonly DependencyGeneration[]; readonly evidenceAfter?: number }
export interface TaskDetails {
  readonly scope: string;
  readonly criteria: readonly Criterion[];
  readonly dependencies: readonly string[];
  readonly owner: string;
  readonly artifacts: readonly Artifact[];
}
export interface PlanTask extends TaskDetails {
  readonly taskId: string;
  readonly title: string;
  readonly attempts: readonly Attempt[];
  readonly evidence: readonly Evidence[];
  readonly decisions: readonly Decision[];
  readonly status: TaskStatus;
  readonly statusReason: string;
  readonly statusHistory: readonly StatusChange[];
  readonly workArea?: WorkArea;
  readonly blockers?: readonly QueueBlocker[];
  readonly queueReview?: QueueReview;
  readonly repairs?: readonly QueueRepair[];
}
export interface PlanSnapshot {
  readonly schemaVersion: 1 | 2;
  readonly queue?: QueueSettings;
  readonly revision: number;
  readonly planId: string;
  readonly title: string;
  readonly authority: Authority;
  readonly tasks: readonly PlanTask[];
  readonly source?: { readonly planId: string; readonly authority: Authority; readonly revision: number; readonly entryId: string; readonly reason: string };
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function text(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= 8192, "Expected bounded nonempty text");
}
function uuid(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), "Expected UUID");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function keys(value: object, allowed: readonly string[]): void {
  requireValue(value !== null && typeof value === "object" && Object.keys(value).every(key => allowed.includes(key)), "Unsupported snapshot field");
}
function validate(plan: PlanSnapshot): void {
  keys(plan, ["schemaVersion", "revision", "planId", "title", "authority", "tasks", "source", "queue"]);
  keys(plan.authority, ["sessionId", "branchInstanceId"]);
  requireValue(plan.schemaVersion === 1 || plan.schemaVersion === 2, "Unsupported schema version");
  requireValue(Number.isSafeInteger(plan.revision) && plan.revision >= 0, "Invalid revision");
  uuid(plan.planId); text(plan.title); text(plan.authority.sessionId); text(plan.authority.branchInstanceId);
  if (plan.source !== undefined) {
    keys(plan.source, ["planId", "authority", "revision", "entryId", "reason"]);
    keys(plan.source.authority, ["sessionId", "branchInstanceId"]);
    uuid(plan.source.planId); text(plan.source.entryId); text(plan.source.reason);
    text(plan.source.authority.sessionId); text(plan.source.authority.branchInstanceId);
    requireValue(plan.source.planId !== plan.planId && Number.isSafeInteger(plan.source.revision) && plan.source.revision >= 0 && plan.source.revision < plan.revision, "Invalid source provenance");
    requireValue(plan.source.authority.branchInstanceId !== plan.authority.branchInstanceId, "Detach requires new branch authority");
  }
  requireValue(Array.isArray(plan.tasks) && plan.tasks.length <= 1000, "Invalid tasks");
  const ids = new Set<string>();
  const attemptIds = new Set<string>();
  const runs = new Set<string>();
  const events = new Set<string>();
  for (const task of plan.tasks) {
    keys(task, ["taskId", "title", "scope", "owner", "criteria", "dependencies", "artifacts", "attempts", "evidence", "decisions", "status", "statusReason", "statusHistory", "workArea", "blockers", "queueReview", "repairs"]);
    uuid(task.taskId); text(task.title); text(task.scope); text(task.owner);
    requireValue(["pending", "in_progress", "blocked", "in_review", "accepted", "failed", "skipped", "cancelled"].includes(task.status), "Invalid status");
    text(task.statusReason);
    requireValue(Array.isArray(task.statusHistory) && task.statusHistory.length > 0 && task.statusHistory.length <= 1000, "Invalid status history");
    requireValue(task.statusHistory[0].status === "pending" && task.statusHistory[0].revision > 0 && task.statusHistory[0].reason === "Awaiting assignment", "Missing pending creation");
    const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
      pending: ["in_progress", "blocked", "in_review", "skipped", "cancelled"],
      in_progress: ["blocked", "in_review", "failed", "skipped", "cancelled"],
      blocked: ["blocked", "in_progress", "in_review", "failed", "skipped", "cancelled"],
      in_review: ["in_review", "in_progress", "blocked", "accepted", "failed", "skipped", "cancelled"],
      accepted: ["pending", "in_review"], failed: ["pending", "in_progress", "skipped", "cancelled"],
      skipped: ["pending"], cancelled: ["pending"],
    };
    let previous: StatusChange | undefined;
    for (const change of task.statusHistory) {
      keys(change, ["revision", "status", "reason"]);
      text(change.reason);
      requireValue(Number.isSafeInteger(change.revision) && change.revision >= 0 && change.revision <= plan.revision && ["pending", "in_progress", "blocked", "in_review", "accepted", "failed", "skipped", "cancelled"].includes(change.status), "Invalid status change");
      if (previous) {
        requireValue(change.revision > previous.revision, "Nonchronological status history");
        requireValue(transitions[previous.status].includes(change.status), "Impossible status transition");
      }
      previous = change;
    }
    requireValue(task.statusHistory.at(-1)?.status === task.status && task.statusHistory.at(-1)?.reason === task.statusReason, "Status history mismatch");
    for (const list of [task.criteria, task.dependencies, task.artifacts, task.evidence, task.decisions]) requireValue(Array.isArray(list) && list.length <= 1000, "Invalid bounded list");
    const criteria = new Set<string>();
    for (const criterion of task.criteria) {
      keys(criterion, ["criterionId", "text"]);
      uuid(criterion.criterionId); text(criterion.text);
      requireValue(!criteria.has(criterion.criterionId), "Duplicate criterion"); criteria.add(criterion.criterionId);
    }
    const artifacts = new Set<string>();
    for (const artifact of task.artifacts) {
      keys(artifact, ["artifactId", "ref"]);
      uuid(artifact.artifactId); text(artifact.ref);
      requireValue(!artifacts.has(artifact.artifactId), "Duplicate artifact"); artifacts.add(artifact.artifactId);
    }
    const evidenceIds = new Set<string>();
    for (const evidence of task.evidence) {
      keys(evidence, ["evidenceId", "criterionId", "ref", "artifactId", "resultEventId", "queue"]);
      uuid(evidence.evidenceId); uuid(evidence.criterionId); text(evidence.ref);
      requireValue(!evidenceIds.has(evidence.evidenceId), "Duplicate evidence"); evidenceIds.add(evidence.evidenceId);
      if (evidence.artifactId !== undefined) requireValue(artifacts.has(evidence.artifactId), "Unknown artifact");
      if (evidence.resultEventId !== undefined) requireValue(task.attempts.some((a: Attempt) => a.results.some((r: ResultReference) => r.eventId === evidence.resultEventId)), "Unknown result reference");
    }
    let previousDecisionRevision = -1;
    for (const decision of task.decisions) {
      keys(decision, ["revision", "kind", "reason", "criteria", "dependencies", "evidenceAfter"]);
      requireValue(decision.criteria !== null && typeof decision.criteria === "object" && !Array.isArray(decision.criteria) && Object.keys(decision.criteria).length <= 1000, "Invalid decision criteria");
      text(decision.reason);
      requireValue(["accept", "invalidate"].includes(decision.kind) && Number.isSafeInteger(decision.revision) && decision.revision >= 0 && decision.revision <= plan.revision && decision.revision > previousDecisionRevision, "Invalid decision");
      previousDecisionRevision = decision.revision;
      const index = task.statusHistory.findIndex((change: StatusChange) => change.revision === decision.revision);
      const change = task.statusHistory[index];
      const before = task.statusHistory[index - 1];
      requireValue(change && before && change.reason === decision.reason && (decision.kind === "accept"
        ? before.status === "in_review" && change.status === "accepted"
        : before.status === "accepted" && ["pending", "in_review"].includes(change.status) && Object.keys(decision.criteria).length === 0), "Decision history mismatch");
      if (decision.kind === "accept") requireValue(Object.keys(decision.criteria).length > 0, "Empty acceptance decision");
      for (const [criterionId, refs] of Object.entries(decision.criteria)) {
        uuid(criterionId);
        requireValue(Array.isArray(refs) && refs.length > 0 && refs.length <= 1000 && refs.every(id => evidenceIds.has(id) && task.evidence.some((e: Evidence) => e.evidenceId === id && e.criterionId === criterionId)), "Unknown decision evidence");
      }
    }
    for (let i = 1; i < task.statusHistory.length; i++) {
      const change = task.statusHistory[i];
      const before = task.statusHistory[i - 1];
      if (change.status === "accepted" || before.status === "accepted") {
        requireValue(task.decisions.some((d: Decision) => d.revision === change.revision && d.kind === (change.status === "accepted" ? "accept" : "invalidate")), "Missing lifecycle decision");
      }
    }
    if (task.status === "accepted") {
      const decision = task.decisions.at(-1);
      requireValue(decision?.kind === "accept", "Missing acceptance decision");
      validateAcceptance(task, decision.criteria);
    }
    requireValue(!ids.has(task.taskId), "Duplicate task ID"); ids.add(task.taskId);
    requireValue(Array.isArray(task.attempts) && task.attempts.length <= 1000, "Invalid attempts");
    // Only start/retry enter in_progress, each appending one attempt. Detach
    // preserves both histories, including attempts no longer supervised here.
    requireValue(task.attempts.length === task.statusHistory.filter((change: StatusChange) => change.status === "in_progress").length, "Attempt history mismatch");
    for (const attempt of task.attempts) {
      keys(attempt, ["attemptId", "runIds", "childSession", "results", "origin", "reservation"]);
      if (attempt.origin !== undefined) {
        keys(attempt.origin, ["planId", "authority"]);
        keys(attempt.origin.authority, ["sessionId", "branchInstanceId"]);
        uuid(attempt.origin.planId); text(attempt.origin.authority.sessionId); text(attempt.origin.authority.branchInstanceId);
      }
      uuid(attempt.attemptId);
      requireValue(!attemptIds.has(attempt.attemptId), "Duplicate attempt"); attemptIds.add(attempt.attemptId);
      if (attempt.childSession !== undefined) text(attempt.childSession);
      requireValue(Array.isArray(attempt.runIds) && attempt.runIds.length <= 1000, "Invalid runs");
      for (const runId of attempt.runIds) {
        text(runId); requireValue(!runs.has(runId), "Duplicate run ID"); runs.add(runId);
      }
      requireValue(Array.isArray(attempt.results) && attempt.results.length <= 1000, "Invalid results");
      for (const result of attempt.results) {
        keys(result, ["eventId", "runId", "ref", "kind", "reason"]);
        text(result.eventId); text(result.ref);
        requireValue(["result", "ping", "failure", "process_exit"].includes(result.kind ?? "result"), "Invalid result kind");
        if (result.reason !== undefined) text(result.reason);
        if (result.kind === "ping" || result.kind === "failure") text(result.reason);
        requireValue(attempt.runIds.includes(result.runId), "Unknown result run");
        requireValue(!events.has(result.eventId), "Duplicate event"); events.add(result.eventId);
      }
    }
  }
  const tasksById = new Map(plan.tasks.map(task => [task.taskId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(task: PlanTask): void {
    requireValue(!visiting.has(task.taskId), "Cyclic dependencies");
    if (visited.has(task.taskId)) return;
    visiting.add(task.taskId);
    requireValue(new Set(task.dependencies).size === task.dependencies.length, "Duplicate dependency");
    for (const id of task.dependencies) {
      requireValue(id !== task.taskId, "Self dependency");
      const dependency = tasksById.get(id);
      requireValue(dependency, "Missing dependency"); visit(dependency);
    }
    visiting.delete(task.taskId); visited.add(task.taskId);
  }
  plan.tasks.forEach(visit);
  validateQueueSchema(plan);
}
function validateAcceptance(task: PlanTask, mapping: Readonly<Record<string, readonly string[]>>): void {
  requireValue(task.criteria.length > 0 && Object.keys(mapping).length === task.criteria.length, "Map ALL criteria");
  for (const criterion of task.criteria) {
    const refs = mapping[criterion.criterionId];
    requireValue(Array.isArray(refs) && refs.length > 0 && refs.every(id => task.evidence.some(e => e.evidenceId === id && e.criterionId === criterion.criterionId)), "Missing valid criterion evidence");
  }
}
function snapshot(plan: PlanSnapshot): PlanSnapshot {
  validate(plan);
  // JSON is the schema boundary; omit optional undefined properties consistently.
  const copy: PlanSnapshot = JSON.parse(JSON.stringify(plan));
  validate(copy);
  return freeze(copy);
}
function authorize(plan: PlanSnapshot, context: CommandContext): void {
  requireValue(context.sessionId === plan.authority.sessionId && context.branchInstanceId === plan.authority.branchInstanceId, "Parent authority mismatch");
  requireValue(context.expectedRevision === plan.revision, "Revision conflict");
}
function update(plan: PlanSnapshot, context: CommandContext, tasks: readonly PlanTask[]): PlanSnapshot {
  authorize(plan, context);
  return snapshot({ ...plan, revision: plan.revision + 1, tasks });
}
export function createPlan(title: string, authority: Authority): PlanSnapshot {
  return snapshot({ schemaVersion: 1, revision: 0, planId: randomUUID(), title, authority, tasks: [] });
}
export function addTask(plan: PlanSnapshot, context: CommandContext, title: string, details: Partial<TaskDetails> = {}): PlanSnapshot {
  requireValue(Object.keys(details).every(key => ["scope", "owner", "criteria", "dependencies", "artifacts"].includes(key)), "Unsupported task details");
  return update(plan, context, [...plan.tasks, { taskId: randomUUID(), title, scope: title, owner: plan.authority.sessionId, criteria: [], dependencies: [], artifacts: [], ...details, attempts: [], evidence: [], decisions: [], status: "pending", statusReason: "Awaiting assignment", statusHistory: [{ revision: plan.revision + 1, status: "pending", reason: "Awaiting assignment" }] }]);
}
export function createCriterion(textValue: string): Criterion { text(textValue); return freeze({ criterionId: randomUUID(), text: textValue }); }
export function createArtifact(ref: string): Artifact { text(ref); return freeze({ artifactId: randomUUID(), ref }); }
export function editTask(plan: PlanSnapshot, context: CommandContext, taskId: string, patch: Partial<TaskDetails & { title: string }>): PlanSnapshot {
  const allowed = ["title", "scope", "criteria", "dependencies", "owner", "artifacts"];
  requireValue(Object.keys(patch).every(key => allowed.includes(key)), "Unsupported task edit");
  return changeTask(plan, context, taskId, task => {
    const edited = { ...task, ...patch };
    if (task.status !== "accepted" || Object.keys(patch).length === 0) return edited;
    return { ...setStatus(edited, plan, "in_review", "Task definition edited"), queueReview: undefined,
      decisions: [...task.decisions, { revision: plan.revision + 1, kind: "invalidate", reason: "Task definition edited", criteria: {} }] };
  });
}
export function addEvidence(plan: PlanSnapshot, context: CommandContext, taskId: string, evidence: Omit<Evidence, "evidenceId" | "queue">): PlanSnapshot {
  keys(evidence, ["criterionId", "ref", "artifactId", "resultEventId"]);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.criteria.some(c => c.criterionId === evidence.criterionId), "Unknown criterion");
    const attempt = task.attempts.at(-1);
    if (plan.queue && evidence.resultEventId !== undefined) {
      requireValue(isQueueResultEvidenceCurrent(task, evidence.resultEventId, attempt, captureDependencies(plan, task)), "Stale queue result evidence; record independent evidence for the current attempt and dependency versions");
    }
    return { ...task, evidence: [...task.evidence, { ...evidence, evidenceId: randomUUID(),
      ...(plan.queue && { queue: { revision: plan.revision + 1, attemptId: attempt?.attemptId } }) }] };
  });
}
export function accept(plan: PlanSnapshot, context: CommandContext, taskId: string, criteria: Readonly<Record<string, readonly string[]>>, reason: string): PlanSnapshot {
  text(reason);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "in_review", "Accept requires in_review");
    validateAcceptance(task, criteria);
    const dependencies = plan.queue ? captureDependencies(plan, task) : undefined;
    let evidenceAfter: number | undefined;
    if (plan.queue) {
      const attempt = task.attempts.at(-1);
      requireValue(!attempt || attempt.reservation?.dispatchedRevision !== undefined, "Accept requires positively confirmed dispatch of the current queue attempt");
      const invalidated = task.decisions.at(-1)?.kind === "invalidate" && task.decisions.at(-1)!.revision > (task.statusHistory.findLast(c => c.status === "in_progress")?.revision ?? 0);
      const review = task.queueReview;
      const baseline = review?.dependencies ?? (!invalidated ? attempt?.reservation?.dependencies : undefined);
      requireValue(dependencies && sameDependencies(dependencies, baseline ?? (task.dependencies.length === 0 && !attempt && !invalidated ? [] : undefined)), "Queue dependency generation changed or unverified; reverify review before accept");
      if (invalidated) requireValue(review && review.revision > task.decisions.at(-1)!.revision, "Queue review invalidated; reverify review before accept");
      evidenceAfter = queueEvidenceMinimum(task, attempt, dependencies);
      if (evidenceAfter !== undefined) {
        const after = evidenceAfter;
        const fresh = new Set(task.evidence.filter(e => e.queue && e.queue.revision > after && e.queue.attemptId === attempt?.attemptId &&
          (e.resultEventId === undefined || isQueueResultEvidenceCurrent(task, e.resultEventId, attempt, dependencies))).map(e => e.evidenceId));
        requireValue(Object.values(criteria).every(refs => refs.every(id => fresh.has(id))), "Queue review needs new evidence for all criteria in the current attempt and review epoch");
      }
    }
    return { ...setStatus(task, plan, "accepted", reason), decisions: [...task.decisions, { revision: plan.revision + 1, kind: "accept", reason, criteria, ...(dependencies && { dependencies }), ...(evidenceAfter !== undefined && { evidenceAfter }) }] };
  });
}
/** References an existing runtime ID; this module never creates a second runtime identity. */
export function attachRun(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string): PlanSnapshot {
  authorize(plan, context);
  requireValue(!plan.queue, "Queue runs must use beginQueueDispatch before manifest or transport");
  const existing = plan.tasks.find(t => t.taskId === taskId)?.attempts.find(a => a.attemptId === attemptId);
  if (existing?.runIds.includes(runId)) {
    requireAttemptAuthority(plan, existing);
    return plan;
  }
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "in_progress" || task.status === "blocked" || task.status === "in_review", "Cannot attach run in terminal/pending state");
    requireValue(task.attempts.at(-1)?.attemptId === attemptId, "Attach requires current attempt");
    requireAttemptAuthority(plan, task.attempts.at(-1)!);
    return { ...task, attempts: task.attempts.map(a => a.attemptId === attemptId ? { ...a, runIds: [...a.runIds, runId] } : a) };
  });
}
function changeTask(plan: PlanSnapshot, context: CommandContext, taskId: string, change: (task: PlanTask) => PlanTask): PlanSnapshot {
  authorize(plan, context);
  requireValue(plan.tasks.some(t => t.taskId === taskId), "Unknown task");
  return update(plan, context, plan.tasks.map(t => t.taskId === taskId ? change(t) : t));
}
function setStatus(task: PlanTask, plan: PlanSnapshot, status: TaskStatus, reason: string): PlanTask {
  text(reason);
  return { ...task, status, statusReason: reason, statusHistory: [...task.statusHistory, { revision: plan.revision + 1, status, reason }] };
}
function requireAttemptAuthority(plan: PlanSnapshot, attempt: Attempt): void {
  requireValue(attempt.origin ? attempt.origin.planId === plan.planId && attempt.origin.authority.sessionId === plan.authority.sessionId && attempt.origin.authority.branchInstanceId === plan.authority.branchInstanceId : !plan.source, "Inherited attempt is read-only; retry to create a new attempt");
}
function newAttempt(task: PlanTask, plan: PlanSnapshot, childSession: string | undefined, reason: string, adapter?: QueueRuntimeAdapter, infrastructureRetry?: InfrastructureRetryLink): PlanTask {
  let reservation: Reservation | undefined;
  if (plan.queue) {
    requireValue(childSession === undefined, "Queue attempts cannot inherit a child session");
    assertQueueAdmission(plan, task, adapter, undefined, { reusingRepair: infrastructureRetry !== undefined });
    const dependencies = captureDependencies(plan, task);
    requireValue(task.workArea && dependencies, "Verified work area and dependencies required");
    reservation = { phase: "reserved", area: task.workArea, dependencies, ...(infrastructureRetry && { infrastructureRetry }) };
  }
  return { ...setStatus(task, plan, "in_progress", reason), queueReview: undefined, attempts: [...task.attempts, { attemptId: randomUUID(), origin: { planId: plan.planId, authority: plan.authority }, runIds: [], ...(childSession === undefined ? {} : { childSession }), results: [], ...(reservation && { reservation }) }] };
}
export function startAttempt(plan: PlanSnapshot, context: CommandContext, taskId: string, childSession?: string, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "pending", "Start requires pending");
    return newAttempt(task, plan, childSession, "Parent started attempt", adapter);
  });
}
export function retry(plan: PlanSnapshot, context: CommandContext, taskId: string, childSession?: string, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(["failed", "blocked", "in_review"].includes(task.status), "Retry requires failed, blocked or in_review");
    return newAttempt(task, plan, childSession, "Parent requested retry", adapter);
  });
}
function requireQueue(plan: PlanSnapshot): QueueSettings {
  requireValue(plan.queue, "queue_not_enabled");
  return plan.queue;
}
function updateQueue(plan: PlanSnapshot, context: CommandContext, queue: QueueSettings): PlanSnapshot {
  authorize(plan, context);
  return snapshot({ ...plan, schemaVersion: 2, queue, revision: plan.revision + 1 });
}
export function configureQueue(plan: PlanSnapshot, context: CommandContext, maxActive: number): PlanSnapshot {
  authorize(plan, context);
  validateQueueLimit(maxActive);
  requireValue(plan.queue || plan.tasks.every(task => task.attempts.length === 0), "Queue opt-in requires a plan without existing attempts");
  return updateQueue(plan, context, { mode: "ready_order", enabledRevision: plan.revision + 1, ...plan.queue, maxActive });
}
export function queuePause(plan: PlanSnapshot, context: CommandContext, reason: string): PlanSnapshot {
  queueText(reason);
  return updateQueue(plan, context, { ...requireQueue(plan), pause: { reason, revision: plan.revision + 1 } });
}
export function queueContinue(plan: PlanSnapshot, context: CommandContext, reason: string): PlanSnapshot {
  queueText(reason); authorize(plan, context);
  const queue = requireQueue(plan);
  return queue.pause ? updateQueue(plan, context, { ...queue, pause: undefined }) : plan;
}
export function setWorkArea(plan: PlanSnapshot, context: CommandContext, taskId: string, cwd: string, access: WorkArea["access"]): PlanSnapshot {
  requireQueue(plan);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "pending" && task.attempts.every(a => a.reservation?.phase === "released"), "Work area changes require pending without an active reservation");
    return { ...task, workArea: canonicalWorkArea(cwd, access), queueReview: undefined };
  });
}
export function setBlocker(plan: PlanSnapshot, context: CommandContext, taskId: string, blocker: BlockerInput): PlanSnapshot {
  requireQueue(plan); validateBlocker(blocker);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.attempts.at(-1)?.attemptId === blocker.attemptId, "Blocker requires the current attempt ID, if any");
    requireValue(["pending", "in_progress", "in_review", "blocked"].includes(task.status), "Cannot block task in this status");
    return { ...setStatus(task, plan, "blocked", blocker.summary), blockers: [...task.blockers ?? [], { ...blocker, revision: plan.revision + 1 }] };
  });
}
function assertQueueAdmission(plan: PlanSnapshot, task: PlanTask, adapter?: QueueRuntimeAdapter, ownAttemptId?: string, options: { continuing?: boolean; reusingRepair?: boolean } = {}): void {
  const facts = collectQueueAdmissionFacts(plan, true, adapter, task.taskId);
  const reasons = queueAdmissionReasons(plan, task, facts, ownAttemptId).filter(({ code }) =>
    !(options.continuing && ["capacity_exhausted", "capacity_occupant"].includes(code)) &&
    !(options.reusingRepair && ["replacement_repair_required", "repair_limit_reached"].includes(code)));
  requireValue(reasons.length === 0, `Queue admission denied: ${reasons.map(r => r.code).join(", ")}`);
}
function requireCurrentReservation(plan: PlanSnapshot, task: PlanTask, attemptId: string) {
  requireQueue(plan);
  const attempt = task.attempts.at(-1);
  requireValue(attempt?.attemptId === attemptId && attempt.reservation, "Current queue reservation required");
  requireAttemptAuthority(plan, attempt);
  return { attempt, reservation: attempt.reservation };
}
function updateReservation(task: PlanTask, attemptId: string, reservation: Reservation, runIds?: readonly string[]): PlanTask {
  return { ...task, attempts: task.attempts.map(a => a.attemptId === attemptId ? { ...a, reservation, ...(runIds && { runIds }) } : a) };
}
function assertQueueExecution(plan: PlanSnapshot, task: PlanTask, attemptId: string, cwd: string, adapter?: QueueRuntimeAdapter, continuing = false) {
  const { reservation } = requireCurrentReservation(plan, task, attemptId);
  assertQueueAdmission(plan, task, adapter, attemptId, { continuing });
  requireValue(sameDependencies(reservation.dependencies, captureDependencies(plan, task)), "Queue dependency generation changed; do not dispatch");
  requireValue(sameWorkArea(reservation.area, canonicalWorkArea(cwd, reservation.area.access)), "Launch cwd does not match the queue reservation");
  return reservation;
}
/** Atomically records the single-use authorization and correlates the runtime ID.
 * Caller must successfully append this before creating its manifest or invoking
 * transport. A later missing manifest is not proof that nothing was sent. */
export function beginQueueDispatch(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string, cwd: string, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  queueText(runId);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "in_progress", "Dispatch requires in_progress");
    const reservation = assertQueueExecution(plan, task, attemptId, cwd, adapter);
    requireValue(reservation.phase === "reserved", "Reservation is not awaiting its first dispatch");
    return updateReservation(task, attemptId, { ...reservation, phase: "uncertain", runId }, [runId]);
  });
}
/** Recheck the initiating call's intent immediately before transport after any
 * asynchronous preparation. This is a negative-conflict/preparation guard,
 * not transport authorization. An initiating ephemeral permit and an atomic
 * runtime manifest boundary are still required; recovered intent cannot send. */
export function verifyQueueDispatchIntent(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string, cwd: string, adapter?: QueueRuntimeAdapter): void {
  authorize(plan, context);
  const task = plan.tasks.find(t => t.taskId === taskId);
  requireValue(task?.status === "in_progress", "Dispatch requires in_progress");
  const reservation = assertQueueExecution(plan, task, attemptId, cwd, adapter);
  requireValue(reservation.phase === "uncertain" && reservation.runId === runId, "Dispatch intent no longer current");
  const binding = { planId: plan.planId, authority: plan.authority, taskId, attemptId, runId };
  let observation;
  try { observation = adapter?.inspect(binding); }
  catch { throw new Error("Runtime dispatch disposition could not be checked"); }
  requireValue(observation?.state === "unknown", "Dispatch intent already has a runtime disposition or observation is unavailable");
  let preparable = false;
  try { preparable = adapter?.canPrepareDispatch?.(binding) === true; }
  catch { /* Unavailable custody is not authority to prepare. */ }
  requireValue(preparable, "Runtime cannot positively exclude a known or conflicting dispatch intent");
}
export function confirmQueueDispatch(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    const { reservation } = requireCurrentReservation(plan, task, attemptId);
    requireValue(reservation.phase === "uncertain" && reservation.runId === runId && queueRuntimeAvailable(plan, adapter), "Current dispatch intent and runtime custody required");
    const proof = inspectQueueRuntime(plan, taskId, attemptId, runId, adapter);
    requireValue(proof.state === "working" || proof.state === "settled", "Dispatch not positively confirmed");
    return updateReservation(task, attemptId, { ...reservation, phase: "dispatched", dispatchedRevision: plan.revision + 1 });
  });
}
/** Checks an already-held execution allocation, not authorization for a fresh
 * process or a new runId. No capacity reallocation for the same tree. */
export function verifyQueueContinuation(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string, cwd: string, adapter?: QueueRuntimeAdapter): void {
  authorize(plan, context);
  const task = plan.tasks.find(t => t.taskId === taskId);
  requireValue(task?.status === "in_progress", "Ordinary queue continuation requires in_progress");
  assertQueueContinuation(plan, task, attemptId, runId, cwd, adapter);
}
function assertQueueContinuation(plan: PlanSnapshot, task: PlanTask, attemptId: string, runId: string, cwd: string, adapter?: QueueRuntimeAdapter): void {
  const reservation = assertQueueExecution(plan, task, attemptId, cwd, adapter, true);
  requireValue((reservation.phase === "dispatched" || reservation.phase === "uncertain") && reservation.runId === runId &&
    inspectQueueRuntime(plan, task.taskId, attemptId, runId, adapter).state === "working", "Queue continuation requires the same supervised execution and active reservation");
}
export function releaseReservation(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, reason: string, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  queueText(reason); authorize(plan, context);
  const task = plan.tasks.find(t => t.taskId === taskId);
  requireValue(task, "Unknown task");
  const { reservation } = requireCurrentReservation(plan, task, attemptId);
  if (reservation.phase === "released") return plan;
  requireValue(queueRuntimeAvailable(plan, adapter), "Queue runtime unavailable; cannot release reservation");
  // Only a reservation with no durable intent can prove non-dispatch locally.
  // Once intent exists, the adapter must resolve that exact identity positively.
  const proof = reservation.runId === undefined ? "not_dispatched" : inspectQueueRuntime(plan, taskId, attemptId, reservation.runId, adapter).state;
  requireValue(proof === "settled" || (proof === "not_dispatched" && reservation.phase !== "dispatched"), "Cannot release queue reservation without positive dispatch/tree settlement proof");
  const released = updateReservation(task, attemptId, { ...reservation, phase: "released",
    ...(proof === "settled" && { dispatchedRevision: reservation.dispatchedRevision ?? plan.revision + 1 }),
    release: { revision: plan.revision + 1, reason, proof } });
  return changeTask(plan, context, taskId, () => task.status === "in_progress" ? setStatus(released, plan, "blocked", reason) : released);
}
function replayedQueueRepair(plan: PlanSnapshot, taskId: string, attemptId: string, input: RepairInput, replacement?: true): boolean {
  const duplicate = plan.tasks.find(t => t.repairs?.some(d => d.decisionId === input.decisionId));
  if (!duplicate) return false;
  const decision = duplicate.repairs!.find(d => d.decisionId === input.decisionId)!;
  requireValue(duplicate.taskId === taskId && decision.attemptId === attemptId && decision.replacement === replacement && decision.reviewRef === input.reviewRef &&
    decision.artifactVersion === input.artifactVersion && decision.reason === input.reason, "Conflicting repair decision ID");
  return true;
}
/** Same-tree post-review repair. Replay returns the identical snapshot and
 * cannot authorize another send. Transport integration is separate. */
export function recordQueueRepair(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string, cwd: string, input: RepairInput, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  authorize(plan, context); requireQueue(plan); validateRepair(input);
  if (replayedQueueRepair(plan, taskId, attemptId, input)) return plan;
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "in_review", "Queue repair requires in_review");
    const round = (task.repairs?.length ?? 0) + 1;
    requireValue(round <= 3, "Queue repair limit reached");
    assertQueueContinuation(plan, task, attemptId, runId, cwd, adapter);
    return { ...task, queueReview: { attemptId, dependencies: captureDependencies(plan, task)!, revision: plan.revision + 1 },
      repairs: [...task.repairs ?? [], { ...input, attemptId, round, revision: plan.revision + 1 }] };
  });
}
/** Charges a replacement round before reserving the next attempt. Ordinarily
 * the decision applies only to the immediate successor. Explicit infrastructure
 * retries can carry it across a proved non-send; no replay resets the budget. */
export function recordQueueReplacementRepair(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, input: RepairInput): PlanSnapshot {
  authorize(plan, context); requireQueue(plan); validateRepair(input);
  if (replayedQueueRepair(plan, taskId, attemptId, input, true)) return plan;
  return changeTask(plan, context, taskId, task => {
    const { reservation } = requireCurrentReservation(plan, task, attemptId);
    requireValue(needsReplacementRepair(task) && ["pending", "in_review", "failed", "blocked"].includes(task.status), "Replacement repair requires a previously reviewed task eligible for a new attempt");
    requireValue(reservation.phase === "released", "Replacement repair requires release of the prior reservation");
    requireValue(!task.repairs?.some(repair => repair.replacement && repair.attemptId === attemptId), "A replacement repair is already recorded for this attempt");
    const round = (task.repairs?.length ?? 0) + 1;
    requireValue(round <= 3, "Queue repair limit reached");
    return { ...task, repairs: [...task.repairs ?? [], { ...input, attemptId, replacement: true, round, revision: plan.revision + 1 }] };
  });
}
/** Explicit retry of a replacement that definitely never crossed transport.
 * The authorization remains the immutable repair decision; the attempt is new,
 * and beginQueueDispatch must append a different run ID if one was used. */
export function retryQueueInfrastructure(plan: PlanSnapshot, context: CommandContext, taskId: string, input: InfrastructureRetryInput, adapter?: QueueRuntimeAdapter): PlanSnapshot {
  requireQueue(plan); validateInfrastructureRetry(input);
  return changeTask(plan, context, taskId, task => {
    const { attempt, reservation } = requireCurrentReservation(plan, task, input.predecessorAttemptId);
    requireValue(isDefiniteUnsentRetryPredecessor(task, attempt), "Infrastructure retry requires definite non-send release and no conflicting block");
    const decision = task.repairs?.at(-1);
    const predecessorLink = reservation.infrastructureRetry;
    requireValue(decision?.replacement === true && decision.decisionId === input.repairDecisionId &&
      (predecessorLink ? predecessorLink.repairDecisionId === decision.decisionId : decision.attemptId === task.attempts.at(-2)?.attemptId),
      "Infrastructure retry must reuse the current replacement repair decision");
    const next = newAttempt(task, plan, undefined, input.reason, adapter, { repairDecisionId: decision.decisionId, predecessorAttemptId: attempt.attemptId });
    if (reservation.runId !== undefined) {
      const observation = inspectQueueRuntime(plan, taskId, attempt.attemptId, reservation.runId, adapter);
      requireValue(observation.state === "not_dispatched" && !observation.proposal, "Runtime cannot reaffirm definite non-send of the predecessor intent");
    }
    return next;
  });
}
/** Explicit parent reverification; do not silently rebase a stale attempt or
 * reuse the old evidence mapping. Add new criterion evidence after this call. */
export function revalidateQueueReview(plan: PlanSnapshot, context: CommandContext, taskId: string): PlanSnapshot {
  requireQueue(plan);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "in_review", "Queue reverification requires in_review");
    const dependencies = captureDependencies(plan, task);
    requireValue(dependencies, "Queue review dependencies are not currently accepted");
    return { ...task, queueReview: { attemptId: task.attempts.at(-1)?.attemptId, dependencies, revision: plan.revision + 1 } };
  });
}
function transition(plan: PlanSnapshot, context: CommandContext, taskId: string, from: readonly TaskStatus[], to: TaskStatus, reason: string): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(from.includes(task.status), `Cannot transition ${task.status} to ${to}`);
    return setStatus(task, plan, to, reason);
  });
}
export function block(plan: PlanSnapshot, context: CommandContext, taskId: string, reason: string): PlanSnapshot {
  return transition(plan, context, taskId, ["pending", "in_progress", "in_review", "blocked"], "blocked", reason);
}
export function submitReview(plan: PlanSnapshot, context: CommandContext, taskId: string, reason: string): PlanSnapshot {
  return transition(plan, context, taskId, ["pending", "in_progress", "blocked", "in_review"], "in_review", reason);
}
export function reject(plan: PlanSnapshot, context: CommandContext, taskId: string, reason: string): PlanSnapshot {
  return transition(plan, context, taskId, ["in_review"], "failed", reason);
}
export function skip(plan: PlanSnapshot, context: CommandContext, taskId: string, reason: string): PlanSnapshot {
  return transition(plan, context, taskId, ["pending", "in_progress", "blocked", "in_review", "failed"], "skipped", reason);
}
export function cancel(plan: PlanSnapshot, context: CommandContext, taskId: string, reason: string): PlanSnapshot {
  return transition(plan, context, taskId, ["pending", "in_progress", "blocked", "in_review", "failed"], "cancelled", reason);
}
export function reopen(plan: PlanSnapshot, context: CommandContext, taskId: string, reason: string): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(["accepted", "failed", "skipped", "cancelled"].includes(task.status), "Reopen requires terminal state");
    return { ...setStatus(task, plan, "pending", reason), queueReview: undefined, ...(task.status === "accepted" ? { decisions: [...task.decisions, { revision: plan.revision + 1, kind: "invalidate" as const, reason, criteria: {} }] } : {}) };
  });
}
/** Worker payload is data only: a parent must authorize recording it. */
export function recordResult(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, result: ResultReference): PlanSnapshot {
  authorize(plan, context);
  keys(result, ["eventId", "runId", "ref", "kind", "reason"]);
  const task = plan.tasks.find(t => t.taskId === taskId);
  requireValue(task, "Unknown task");
  const targetAttempt = task.attempts.find(a => a.attemptId === attemptId);
  requireValue(targetAttempt, "Unknown attempt");
  requireAttemptAuthority(plan, targetAttempt);
  const existing = task.attempts.flatMap(a => a.results).find(r => r.eventId === result.eventId);
  if (existing) {
    requireValue(existing.runId === result.runId && existing.ref === result.ref && (existing.kind ?? "result") === (result.kind ?? "result") && existing.reason === result.reason && task.attempts.some(a => a.attemptId === attemptId && a.results.includes(existing)), "Conflicting event");
    return plan;
  }
  return changeTask(plan, context, taskId, task => {
    requireValue(task.attempts.some(a => a.attemptId === attemptId), "Unknown attempt");
    const recorded = { ...task, attempts: task.attempts.map(a => a.attemptId === attemptId ? { ...a, results: [...a.results, result] } : a) };
    // Completion is observation, never acceptance. Old attempts and terminal tasks
    // retain late events without changing the parent's decision.
    if (task.attempts.at(-1)?.attemptId !== attemptId || !["in_progress", "blocked", "in_review"].includes(task.status) || result.kind === "process_exit") return recorded;
    // A delayed child proposal cannot supersede the parent's explicit blocker
    // or revive an assignment already released as never dispatched.
    if (plan.queue && (targetAttempt.reservation?.release?.proof === "not_dispatched" ||
      (task.status === "blocked" && task.blockers?.at(-1)?.revision === task.statusHistory.at(-1)?.revision))) return recorded;
    if (result.kind === "ping") return setStatus(recorded, plan, "blocked", result.reason!);
    if (result.kind === "failure") return setStatus(recorded, plan, "failed", result.reason!);
    return setStatus(recorded, plan, "in_review", result.reason ?? "Worker result requires parent review");
  });
}
/** Explicit conservative copy: preserve history, never inherit live ownership.
 * Revision remains chronological; plan identity and branch authority are new. */
export function detachPlan(plan: PlanSnapshot, authority: Authority, entryId: string, reason: string): PlanSnapshot {
  validate(plan); text(reason); text(entryId);
  requireValue(authority.branchInstanceId !== plan.authority.branchInstanceId, "Detach requires new branch authority");
  requireValue(!plan.queue || plan.tasks.every(task => task.attempts.every(attempt => attempt.reservation?.phase === "released")), "Cannot detach a queue plan with outstanding reservations; reconcile on original branch");
  const explanation = `Inherited attempt requires explicit retry after detach: ${reason}`;
  // Queue control data stays with the original branch. The explicit source
  // pointer still identifies that historical audit; no slot or lease is copied.
  return snapshot({ ...plan, schemaVersion: 1, queue: undefined, planId: randomUUID(), authority, revision: plan.revision + 1,
    source: { planId: plan.planId, authority: plan.authority, revision: plan.revision, entryId, reason },
    tasks: plan.tasks.map(task => ({
      ...(["in_progress", "blocked", "in_review"].includes(task.status) && task.attempts.length ? setStatus(task, plan, "blocked", explanation) : task),
      workArea: undefined, blockers: undefined, queueReview: undefined, repairs: undefined,
      evidence: task.evidence.map(evidence => ({ ...evidence, queue: undefined })),
      decisions: task.decisions.map(decision => ({ ...decision, dependencies: undefined, evidenceAfter: undefined })),
      attempts: task.attempts.map(attempt => ({ ...attempt, reservation: undefined, origin: attempt.origin ?? { planId: plan.planId, authority: plan.authority } })),
    })),
  });
}
export function serializePlan(plan: PlanSnapshot): string { validate(plan); return JSON.stringify(plan); }
/** Import/roundtrip only, not a command for replacing an authoritative store. */
export function deserializePlan(json: string): PlanSnapshot { return snapshot(JSON.parse(json)); }
