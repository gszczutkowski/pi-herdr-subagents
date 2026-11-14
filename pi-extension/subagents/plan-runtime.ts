import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanPersistence } from "./plan-persistence.ts";
import { attachRun, recordResult, type Authority, type ResultReference } from "./plan-store.ts";
import type { DeliveryEnvelope } from "./delivery.ts";

const id = () => Type.String({ minLength: 1, maxLength: 8192 });
export const PlanTaskParams = Type.Object({
  planId: id(), taskId: id(), attemptId: id(),
  expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false, description: "Optional binding to an existing parent-created current task attempt. Read plan_read first. Does not create a task/attempt or accept results." });
export type PlanTaskSelection = Static<typeof PlanTaskParams>;
export interface PlanTaskBinding {
  planId: string; taskId: string; attemptId: string; authority: Authority;
}
const BindingSchema = Type.Object({ planId: id(), taskId: id(), attemptId: id(),
  authority: Type.Object({ sessionId: id(), branchInstanceId: id() }, { additionalProperties: false }),
}, { additionalProperties: false });
export function isPlanTaskBinding(value: unknown): value is PlanTaskBinding {
  return Value.Check(BindingSchema, value);
}
const same = (a: PlanTaskBinding, b: PlanTaskBinding) => a.planId === b.planId && a.taskId === b.taskId &&
  a.attemptId === b.attemptId && a.authority.sessionId === b.authority.sessionId && a.authority.branchInstanceId === b.authority.branchInstanceId;

/** Parent-owned compare/append before transport. A saved binding can never be redirected. */
export function bindPlanRun(persistence: PlanPersistence, ctx: ExtensionContext, runId: string,
  selection?: PlanTaskSelection, saved?: PlanTaskBinding): PlanTaskBinding | undefined {
  if (!selection && !saved) return undefined;
  if (selection && !Value.Check(PlanTaskParams, selection)) throw new Error("Invalid planTask selection");
  if (saved && !isPlanTaskBinding(saved)) throw new Error("Invalid saved task binding");
  const view = persistence.read(ctx.sessionManager);
  const plan = view.snapshot;
  if (!plan || !view.writable) throw new Error(view.error ?? "No active plan");
  const binding: PlanTaskBinding = selection ? { planId: selection.planId, taskId: selection.taskId,
    attemptId: selection.attemptId, authority: { ...plan.authority } } : saved!;
  if (saved && !same(binding, saved)) throw new Error("Resume cannot redirect its original task binding");
  const task = plan.tasks.find(t => t.taskId === binding.taskId);
  if (!task || task.attempts.at(-1)?.attemptId !== binding.attemptId || !["in_progress", "blocked", "in_review"].includes(task.status)) {
    throw new Error("Binding requires an existing current nonterminal attempt; create retry explicitly");
  }
  persistence.mutate(ctx.sessionManager, binding.planId, selection?.expectedRevision ?? plan.revision,
    (p, c) => attachRun(p, c, binding.taskId, binding.attemptId, runId), binding.authority);
  return structuredClone(binding);
}

/** Import is independent of result handoff. The durable outbox is also the retry
 * source, including handed-off envelopes; no second task list or auto-accept. */
export function importPlanEnvelope(persistence: PlanPersistence, ctx: ExtensionContext,
  binding: PlanTaskBinding | undefined, runId: string, envelope: DeliveryEnvelope): void {
  if (!binding) return;
  if (!isPlanTaskBinding(binding)) throw new Error("Invalid result task binding");
  const d = envelope.message.details as Record<string, any>;
  const eventId = d?.eventId;
  if (typeof eventId !== "string") throw new Error("Missing canonical delivery event ID");
  const ping = envelope.message.customType === "subagent_ping";
  const failure = !!(d.errorMessage || d.error || (typeof d.exitCode === "number" && d.exitCode !== 0));
  const reason = String(ping ? d.message : d.errorMessage || d.error || `Process exited with code ${d.exitCode}`).slice(0, 8192) || "Child needs help";
  const result: ResultReference = { eventId, runId, ref: `${d.sessionFile || "runtime"}#${eventId}`,
    kind: ping ? "ping" : failure ? "failure" : "result", ...((ping || failure) ? { reason } : {}) };
  const plan = persistence.read(ctx.sessionManager).snapshot;
  if (!plan) throw new Error("Original plan branch is not selected");
  persistence.mutate(ctx.sessionManager, binding.planId, plan.revision,
    (p, c) => recordResult(p, c, binding.taskId, binding.attemptId, result), binding.authority);
}

export function recordDispatchFailure(persistence: PlanPersistence, ctx: ExtensionContext,
  binding: PlanTaskBinding | undefined, runId: string, error: unknown, dispatchId = "launch"): void {
  if (!binding) return;
  importPlanEnvelope(persistence, ctx, binding, runId, { message: { customType: "subagent_result", display: true,
    content: String(error), details: { eventId: `subagent:${runId}:dispatch-failure:${dispatchId}`, error: `Dispatch failed/uncertain: ${String(error)}` } },
    options: { triggerTurn: true, deliverAs: "steer" } });
}
