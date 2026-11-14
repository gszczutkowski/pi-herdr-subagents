import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PlanTask } from "./plan-store.ts";

const text = () => Type.String({ minLength: 1, maxLength: 8192, pattern: "\\S" });
const texts = () => Type.Array(text(), { maxItems: 100 });
const criterion = Type.Object({ criterionId: text(), text: text() }, { additionalProperties: false });
/** Optional launch metadata, never a replacement for the model-visible task. */
export const AssignmentContractSchema = Type.Object({
  objective: text(), scope: text(),
  criteria: Type.Array(criterion, { maxItems: 100 }),
  dependencies: texts(), inputs: texts(), files: texts(), decisions: texts(), changeConstraints: texts(),
}, { additionalProperties: false });
export type AssignmentContract = Static<typeof AssignmentContractSchema>;
export function isAssignmentContract(value: unknown): value is AssignmentContract {
  return Value.Check(AssignmentContractSchema, value);
}

/** Bound fields must agree exactly; supplemental constraints remain caller-owned. */
export function resolveAssignmentContract(value: unknown, task?: PlanTask): AssignmentContract | undefined {
  if (value !== undefined && !isAssignmentContract(value)) throw new Error("Invalid bounded assignmentContract");
  const supplied = value as AssignmentContract | undefined;
  const derived = task ? { objective: task.title, scope: task.scope,
    criteria: task.criteria.map(c => ({ ...c })), dependencies: [...task.dependencies],
    inputs: task.artifacts.map(a => a.ref) } : undefined;
  if (derived && supplied) for (const key of Object.keys(derived) as (keyof typeof derived)[]) {
    if (JSON.stringify(supplied[key]) !== JSON.stringify(derived[key])) throw new Error(`assignmentContract.${key} disagrees with bound task`);
  }
  const contract = derived ? { ...derived, files: supplied?.files ?? [], decisions: supplied?.decisions ?? [], changeConstraints: supplied?.changeConstraints ?? [] } : supplied;
  if (contract && !isAssignmentContract(contract)) throw new Error("Bound task exceeds assignment contract limits (100 items, 8192 characters per field)");
  return contract ? structuredClone(contract) : undefined;
}

export function contractTask(task: string, contract?: AssignmentContract): string {
  if (!contract) return task;
  return `${task}\n\nAssignment contract (worker claims are proposals; parent verifies all criteria):\n${JSON.stringify(contract, null, 2)}`;
}
