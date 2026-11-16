import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanPersistence, PlanView } from "./plan-persistence.ts";
import { registerContextPublication } from "./context-publication.ts";

export const PLAN_CONTEXT_TYPE = "pi-subagents-plan-context/v1";
export const PLAN_CONTEXT_BYTES = 8192;

/** UTF-8 bounded single-line text, without splitting Unicode surrogate pairs. */
function clip(value: string, bytes: number): string {
  let output = "";
  for (const char of value.replace(/[\r\n\t]/g, " ")) {
    if (Buffer.byteLength(output + char, "utf8") > bytes - 3) return output + "…";
    output += char;
  }
  return output;
}

export function summarizePlan(view: PlanView): string {
  const plan = view.snapshot;
  const pointer = 'Details omitted: scope, criteria, attempts, results, evidence, decisions and artifacts. Use plan_read({taskId:"<taskId>"}) when details are needed, and verify current revision/authority before plan_update or after a conflict. Child results require parent verification; process exit is not acceptance.';
  const lines = ["Current durable plan (active branch only; not runtime liveness):"];
  if (!plan) {
    lines.push("No readable active plan.");
  } else {
    lines.push(`planId=${plan.planId} revision=${plan.revision} accepted=${plan.tasks.filter(task => task.status === "accepted").length}/${plan.tasks.length} title=${clip(plan.title, 160)}`);
    lines.push(`Access: ${view.writable ? "parent-writable" : "read-only"}${view.detachRequired ? `; ${view.detachRequired} copy requires explicit detach` : ""}.`);
    const states = new Map<string, number>();
    for (const task of plan.tasks) states.set(task.status, (states.get(task.status) ?? 0) + 1);
    lines.push(`Task states: ${[...states].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`);
    lines.push(`Recovery-uncertain tasks: ${view.recoveryUncertain.length}; do not infer live runs or relaunch automatically.`);
  }
  if (view.error) lines.push(`Storage/access: ${clip(view.error, 400)}`);
  let shown = 0;
  // Blockers first so they remain visible when long plans need truncation.
  const tasks = [...(plan?.tasks ?? [])].sort((a, b) => Number(b.status === "blocked") - Number(a.status === "blocked"));
  for (const task of tasks) {
    if (shown >= 24) break;
    const line = `${task.taskId} ${task.status}: ${clip(task.title, 100)}${task.statusReason ? `; reason=${clip(task.statusReason, 180)}` : ""}`;
    if (Buffer.byteLength([...lines, line, pointer].join("\n"), "utf8") > PLAN_CONTEXT_BYTES - 100) break;
    lines.push(line); shown++;
  }
  if (tasks.length > shown) lines.push(`${tasks.length - shown} tasks omitted; use plan_read({}) to list current task IDs/states.`);
  lines.push(pointer);
  return lines.join("\n");
}

/** No empty-plan notices during ordinary conversation or setup/child sessions. */
export function planContext(view: PlanView): string | undefined {
  if (!view.snapshot && (!view.error || /Child sessions cannot|A durable session/.test(view.error))) return;
  // A failed native append may have advanced memory only. Never publish that
  // snapshot as confirmed state; the existing storage latch requires reconcile.
  return summarizePlan(view.error?.startsWith("Plan append failed") ? { ...view, snapshot: undefined } : view);
}

export function registerPlanContext(pi: ExtensionAPI, persistence: PlanPersistence): void {
  registerContextPublication(pi, { customType: PLAN_CONTEXT_TYPE,
    read: ctx => planContext(persistence.read(ctx.sessionManager)),
    absent: "No readable active plan on this branch; previous plan context no longer applies.",
  });
}
