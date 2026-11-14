import { randomUUID } from "node:crypto";

export interface Authority { readonly sessionId: string; readonly branchInstanceId: string }
export interface CommandContext extends Authority { readonly expectedRevision: number }
export interface Attempt {
  readonly attemptId: string;
  readonly runIds: readonly string[];
  readonly childSession?: string;
  readonly results: readonly ResultReference[];
}
export interface ResultReference { readonly eventId: string; readonly runId: string; readonly ref: string }
export interface PlanTask { readonly taskId: string; readonly title: string; readonly attempts: readonly Attempt[] }
export interface PlanSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly planId: string;
  readonly title: string;
  readonly authority: Authority;
  readonly tasks: readonly PlanTask[];
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
function validate(plan: PlanSnapshot): void {
  requireValue(plan.schemaVersion === 1, "Unsupported schema version");
  requireValue(Number.isSafeInteger(plan.revision) && plan.revision >= 0, "Invalid revision");
  uuid(plan.planId); text(plan.title); text(plan.authority.sessionId); text(plan.authority.branchInstanceId);
  requireValue(Array.isArray(plan.tasks) && plan.tasks.length <= 1000, "Invalid tasks");
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    uuid(task.taskId); text(task.title);
    requireValue(!ids.has(task.taskId), "Duplicate task ID"); ids.add(task.taskId);
    requireValue(Array.isArray(task.attempts) && task.attempts.length <= 1000, "Invalid attempts");
    const attemptIds = new Set<string>();
    const runs = new Set<string>();
    const events = new Set<string>();
    for (const attempt of task.attempts) {
      uuid(attempt.attemptId);
      requireValue(!attemptIds.has(attempt.attemptId), "Duplicate attempt"); attemptIds.add(attempt.attemptId);
      if (attempt.childSession !== undefined) text(attempt.childSession);
      requireValue(Array.isArray(attempt.runIds) && attempt.runIds.length <= 1000, "Invalid runs");
      for (const runId of attempt.runIds) {
        text(runId); requireValue(!runs.has(runId), "Duplicate run ID"); runs.add(runId);
      }
      requireValue(Array.isArray(attempt.results) && attempt.results.length <= 1000, "Invalid results");
      for (const result of attempt.results) {
        text(result.eventId); text(result.ref);
        requireValue(attempt.runIds.includes(result.runId), "Unknown result run");
        requireValue(!events.has(result.eventId), "Duplicate event"); events.add(result.eventId);
      }
    }
  }
}
function snapshot(plan: PlanSnapshot): PlanSnapshot {
  const copy = structuredClone(plan); validate(copy); return freeze(copy);
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
export function addTask(plan: PlanSnapshot, context: CommandContext, title: string): PlanSnapshot {
  return update(plan, context, [...plan.tasks, { taskId: randomUUID(), title, attempts: [] }]);
}
/** References an existing runtime ID; this module never creates a second runtime identity. */
export function attachRun(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, runId: string): PlanSnapshot {
  return changeTask(plan, context, taskId, task => {
    requireValue(task.attempts.some(a => a.attemptId === attemptId), "Unknown attempt");
    return { ...task, attempts: task.attempts.map(a => a.attemptId === attemptId ? { ...a, runIds: [...a.runIds, runId] } : a) };
  });
}
function changeTask(plan: PlanSnapshot, context: CommandContext, taskId: string, change: (task: PlanTask) => PlanTask): PlanSnapshot {
  authorize(plan, context);
  requireValue(plan.tasks.some(t => t.taskId === taskId), "Unknown task");
  return update(plan, context, plan.tasks.map(t => t.taskId === taskId ? change(t) : t));
}
export function startAttempt(plan: PlanSnapshot, context: CommandContext, taskId: string, childSession?: string): PlanSnapshot {
  return changeTask(plan, context, taskId, task => ({ ...task, attempts: [...task.attempts, { attemptId: randomUUID(), runIds: [], ...(childSession === undefined ? {} : { childSession }), results: [] }] }));
}
export function retry(plan: PlanSnapshot, context: CommandContext, taskId: string, childSession?: string): PlanSnapshot {
  return startAttempt(plan, context, taskId, childSession);
}
/** Worker payload is data only: a parent must authorize recording it. */
export function recordResult(plan: PlanSnapshot, context: CommandContext, taskId: string, attemptId: string, result: ResultReference): PlanSnapshot {
  authorize(plan, context);
  const task = plan.tasks.find(t => t.taskId === taskId);
  requireValue(task, "Unknown task");
  const existing = task.attempts.flatMap(a => a.results).find(r => r.eventId === result.eventId);
  if (existing) {
    requireValue(JSON.stringify(existing) === JSON.stringify(result) && task.attempts.some(a => a.attemptId === attemptId && a.results.includes(existing)), "Conflicting event");
    return plan;
  }
  return changeTask(plan, context, taskId, task => {
    requireValue(task.attempts.some(a => a.attemptId === attemptId), "Unknown attempt");
    return { ...task, attempts: task.attempts.map(a => a.attemptId === attemptId ? { ...a, results: [...a.results, result] } : a) };
  });
}
export function serializePlan(plan: PlanSnapshot): string { validate(plan); return JSON.stringify(plan); }
/** Import/roundtrip only, not a command for replacing an authoritative store. */
export function deserializePlan(json: string): PlanSnapshot { return snapshot(JSON.parse(json)); }
