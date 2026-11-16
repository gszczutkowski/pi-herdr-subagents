import { randomUUID } from "node:crypto";

/** Pure parent command layer. Callers retain the current snapshot and supply trusted
 * session/branch context; worker proposals are data, never authority. This is not
 * an OS/security sandbox. No persistence, runtime hooks, or snapshot-replace command.
 * Revision checks only protect commands against the current snapshot supplied by
 * that caller; future storage adapters must serialize the compare-and-swap.
 */

export interface Authority { readonly sessionId: string; readonly branchInstanceId: string }
export interface CommandContext extends Authority { readonly expectedRevision: number }
export interface Attempt {
  readonly attemptId: string;
  readonly runIds: readonly string[];
  readonly childSession?: string;
  readonly origin?: { readonly planId: string; readonly authority: Authority };
  readonly results: readonly ResultReference[];
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
export interface Evidence { readonly evidenceId: string; readonly criterionId: string; readonly ref: string; readonly artifactId?: string; readonly resultEventId?: string }
export interface Decision { readonly revision: number; readonly kind: "accept" | "invalidate"; readonly reason: string; readonly criteria: Readonly<Record<string, readonly string[]>> }
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
}
export interface PlanSnapshot {
  readonly schemaVersion: 1;
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
  keys(plan, ["schemaVersion", "revision", "planId", "title", "authority", "tasks", "source"]);
  keys(plan.authority, ["sessionId", "branchInstanceId"]);
  requireValue(plan.schemaVersion === 1, "Unsupported schema version");
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
    keys(task, ["taskId", "title", "scope", "owner", "criteria", "dependencies", "artifacts", "attempts", "evidence", "decisions", "status", "statusReason", "statusHistory"]);
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
      keys(evidence, ["evidenceId", "criterionId", "ref", "artifactId", "resultEventId"]);
      uuid(evidence.evidenceId); uuid(evidence.criterionId); text(evidence.ref);
      requireValue(!evidenceIds.has(evidence.evidenceId), "Duplicate evidence"); evidenceIds.add(evidence.evidenceId);
      if (evidence.artifactId !== undefined) requireValue(artifacts.has(evidence.artifactId), "Unknown artifact");
      if (evidence.resultEventId !== undefined) requireValue(task.attempts.some(a => a.results.some(r => r.eventId === evidence.resultEventId)), "Unknown result reference");
    }
    let previousDecisionRevision = -1;
    for (const decision of task.decisions) {
      keys(decision, ["revision", "kind", "reason", "criteria"]);
      requireValue(decision.criteria !== null && typeof decision.criteria === "object" && !Array.isArray(decision.criteria) && Object.keys(decision.criteria).length <= 1000, "Invalid decision criteria");
      text(decision.reason);
      requireValue(["accept", "invalidate"].includes(decision.kind) && Number.isSafeInteger(decision.revision) && decision.revision >= 0 && decision.revision <= plan.revision && decision.revision > previousDecisionRevision, "Invalid decision");
      previousDecisionRevision = decision.revision;
      const index = task.statusHistory.findIndex(change => change.revision === decision.revision);
      const change = task.statusHistory[index];
      const before = task.statusHistory[index - 1];
      requireValue(change && before && change.reason === decision.reason && (decision.kind === "accept"
        ? before.status === "in_review" && change.status === "accepted"
        : before.status === "accepted" && ["pending", "in_review"].includes(change.status) && Object.keys(decision.criteria).length === 0), "Decision history mismatch");
      if (decision.kind === "accept") requireValue(Object.keys(decision.criteria).length > 0, "Empty acceptance decision");
      for (const [criterionId, refs] of Object.entries(decision.criteria)) {
        uuid(criterionId);
        requireValue(Array.isArray(refs) && refs.length > 0 && refs.length <= 1000 && refs.every(id => evidenceIds.has(id) && task.evidence.some(e => e.evidenceId === id && e.criterionId === criterionId)), "Unknown decision evidence");
      }
    }
    for (let i = 1; i < task.statusHistory.length; i++) {
      const change = task.statusHistory[i];
      const before = task.statusHistory[i - 1];
      if (change.status === "accepted" || before.status === "accepted") {
        requireValue(task.decisions.some(d => d.revision === change.revision && d.kind === (change.status === "accepted" ? "accept" : "invalidate")), "Missing lifecycle decision");
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
    requireValue(task.attempts.length === task.statusHistory.filter(change => change.status === "in_progress").length, "Attempt history mismatch");
    for (const attempt of task.attempts) {
      keys(attempt, ["attemptId", "runIds", "childSession", "results", "origin"]);
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
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(task: PlanTask): void {
    requireValue(!visiting.has(task.taskId), "Cyclic dependencies");
    if (visited.has(task.taskId)) return;
    visiting.add(task.taskId);
    requireValue(new Set(task.dependencies).size === task.dependencies.length, "Duplicate dependency");
    for (const id of task.dependencies) {
      requireValue(id !== task.taskId, "Self dependency");
      const dependency = plan.tasks.find(t => t.taskId === id);
      requireValue(dependency, "Missing dependency"); visit(dependency);
    }
    visiting.delete(task.taskId); visited.add(task.taskId);
  }
  plan.tasks.forEach(visit);
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
    return { ...setStatus(edited, plan, "in_review", "Task definition edited"), decisions: [...task.decisions, { revision: plan.revision + 1, kind: "invalidate", reason: "Task definition edited", criteria: {} }] };
  });
}
export function addEvidence(plan: PlanSnapshot, context: CommandContext, taskId: string, evidence: Omit<Evidence, "evidenceId">): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(task.criteria.some(c => c.criterionId === evidence.criterionId), "Unknown criterion");
    return { ...task, evidence: [...task.evidence, { ...evidence, evidenceId: randomUUID() }] };
  });
}
export function accept(plan: PlanSnapshot, context: CommandContext, taskId: string, criteria: Readonly<Record<string, readonly string[]>>, reason: string): PlanSnapshot {
  text(reason);
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "in_review", "Accept requires in_review");
    validateAcceptance(task, criteria);
    return { ...setStatus(task, plan, "accepted", reason), decisions: [...task.decisions, { revision: plan.revision + 1, kind: "accept", reason, criteria }] };
  });
}
/** References an existing runtime ID; this module never creates a second runtime identity. */
export function attachRun(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string): PlanSnapshot {
  authorize(plan, context);
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
function newAttempt(task: PlanTask, plan: PlanSnapshot, childSession: string | undefined, reason: string): PlanTask {
  return { ...setStatus(task, plan, "in_progress", reason), attempts: [...task.attempts, { attemptId: randomUUID(), origin: { planId: plan.planId, authority: plan.authority }, runIds: [], ...(childSession === undefined ? {} : { childSession }), results: [] }] };
}
export function startAttempt(plan: PlanSnapshot, context: CommandContext, taskId: string, childSession?: string): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(task.status === "pending", "Start requires pending");
    return newAttempt(task, plan, childSession, "Parent started attempt");
  });
}
export function retry(plan: PlanSnapshot, context: CommandContext, taskId: string, childSession?: string): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(["failed", "blocked", "in_review"].includes(task.status), "Retry requires failed, blocked or in_review");
    return newAttempt(task, plan, childSession, "Parent requested retry");
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
    return { ...setStatus(task, plan, "pending", reason), ...(task.status === "accepted" ? { decisions: [...task.decisions, { revision: plan.revision + 1, kind: "invalidate" as const, reason, criteria: {} }] } : {}) };
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
  const explanation = `Inherited attempt requires explicit retry after detach: ${reason}`;
  return snapshot({ ...plan, planId: randomUUID(), authority, revision: plan.revision + 1,
    source: { planId: plan.planId, authority: plan.authority, revision: plan.revision, entryId, reason },
    tasks: plan.tasks.map(task => ({
      ...(["in_progress", "blocked", "in_review"].includes(task.status) && task.attempts.length ? setStatus(task, plan, "blocked", explanation) : task),
      attempts: task.attempts.map(attempt => ({ ...attempt, origin: attempt.origin ?? { planId: plan.planId, authority: plan.authority } })),
    })),
  });
}
export function serializePlan(plan: PlanSnapshot): string { validate(plan); return JSON.stringify(plan); }
/** Import/roundtrip only, not a command for replacing an authoritative store. */
export function deserializePlan(json: string): PlanSnapshot { return snapshot(JSON.parse(json)); }
