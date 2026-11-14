import { randomUUID } from "node:crypto";

export interface Authority { readonly sessionId: string; readonly branchInstanceId: string }
export interface CommandContext extends Authority { readonly expectedRevision: number }
export interface PlanTask { readonly taskId: string; readonly title: string; readonly runIds: readonly string[] }
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
    requireValue(Array.isArray(task.runIds) && task.runIds.length <= 1000, "Invalid runs");
    for (const runId of task.runIds) text(runId);
    requireValue(new Set(task.runIds).size === task.runIds.length, "Duplicate run ID");
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
  return update(plan, context, [...plan.tasks, { taskId: randomUUID(), title, runIds: [] }]);
}
/** References an existing runtime ID; this module never creates a second runtime identity. */
export function attachRun(plan: PlanSnapshot, context: CommandContext, taskId: string, runId: string): PlanSnapshot {
  text(runId);
  const task = plan.tasks.find(task => task.taskId === taskId);
  requireValue(task, "Unknown task");
  return update(plan, context, plan.tasks.map(task => task.taskId === taskId ? { ...task, runIds: [...task.runIds, runId] } : task));
}
export function serializePlan(plan: PlanSnapshot): string { validate(plan); return JSON.stringify(plan); }
/** Import/roundtrip only, not a command for replacing an authoritative store. */
export function deserializePlan(json: string): PlanSnapshot { return snapshot(JSON.parse(json)); }
