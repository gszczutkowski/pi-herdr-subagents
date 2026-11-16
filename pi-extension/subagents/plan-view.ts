import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PlanView } from "./plan-persistence.ts";
import type { TaskStatus } from "./plan-store.ts";

const icons: Record<TaskStatus, string> = {
  pending: "○", in_progress: "◐", blocked: "!", in_review: "◇",
  accepted: "✓", failed: "×", skipped: "–", cancelled: "⊘",
};

/** Persisted task state only: process exit and result delivery never check a box. */
export const COMPACT_TASK_LIMIT = 6;

export function planLines(view: PlanView, expanded = false): string[] {
  const plan = view.snapshot;
  if (!plan) return view.error ? [`Plan unavailable: ${view.error}`] : [];
  const lines = [`Plan: ${plan.title} — ${plan.tasks.filter(t => t.status === "accepted").length}/${plan.tasks.length} accepted`];
  if (view.error) lines.push(`Read-only: ${view.error}`);
  const tasks = expanded ? plan.tasks : plan.tasks.slice(0, COMPACT_TASK_LIMIT);
  for (const [index, task] of tasks.entries()) {
    lines.push(`${icons[task.status]} T${index + 1} ${task.title} | ${task.status} | Role/owner: ${task.owner}`);
    if (task.status === "blocked" || task.status === "failed") lines.push(`  Reason: ${task.statusReason}`);
    const waiting = task.dependencies.filter(id => plan.tasks.find(t => t.taskId === id)?.status !== "accepted");
    if (waiting.length) lines.push(`  Waiting on: ${waiting.map(id => `T${plan.tasks.findIndex(t => t.taskId === id) + 1}`).join(", ")}`);
    if (view.recoveryUncertain.includes(task.taskId)) lines.push("  Recovery uncertain; runtime presence not verified");
  }
  if (plan.tasks.length > COMPACT_TASK_LIMIT) lines.push(expanded
    ? "/plan-view compact — collapse task list"
    : `… ${plan.tasks.length - tasks.length} more tasks — /plan-view full`);
  return lines;
}

/** References are displayed verbatim as data, never executed or resolved as runtime state. */
export function taskDetailLines(view: PlanView, taskId: string): string[] {
  const task = view.snapshot?.tasks.find(t => t.taskId === taskId);
  if (!task) return ["Task not on the active branch; use /plan-view full"];
  const lines = [
    ...(view.error ? [`Read-only: ${view.error}`] : []),
    ...(view.recoveryUncertain.includes(task.taskId) ? ["Recovery uncertain; runtime presence not verified"] : []),
    `Task: ${task.title}`, `Task ID: ${task.taskId}`, `Status: ${task.status} — ${task.statusReason}`,
    `Role/owner: ${task.owner}`, `Scope: ${task.scope}`,
    `Dependencies: ${task.dependencies.join(", ") || "none"}`,
    "Criteria:",
    ...task.criteria.map(c => `  ${task.status === "accepted" ? "✓" : "○"} ${c.criterionId}: ${c.text}`),
    "Attempts (references, not liveness):",
  ];
  for (const attempt of task.attempts) {
    lines.push(`  Attempt: ${attempt.attemptId}`, `  Runs: ${attempt.runIds.join(", ") || "none"}`);
    if (attempt.childSession) lines.push(`  Session: ${attempt.childSession}`);
    if (attempt.origin) lines.push(`  Origin plan ${attempt.origin.planId}; authority ${attempt.origin.authority.sessionId}/${attempt.origin.authority.branchInstanceId}`);
    for (const result of attempt.results) lines.push(`  Result ${result.eventId} (${result.kind ?? "result"}, run ${result.runId}): ${result.ref}${result.reason ? ` — ${result.reason}` : ""}`);
  }
  lines.push("Checks / evidence (recorded references, not independently verified):");
  for (const evidence of task.evidence) lines.push(`  ${evidence.evidenceId} → criterion ${evidence.criterionId}: ${evidence.ref}${evidence.artifactId ? `; artifact ${evidence.artifactId}` : ""}${evidence.resultEventId ? `; result ${evidence.resultEventId}` : ""}`);
  lines.push("Decisions:");
  for (const decision of task.decisions) {
    lines.push(`  r${decision.revision} ${decision.kind}: ${decision.reason}`);
    for (const [criterionId, evidenceIds] of Object.entries(decision.criteria)) lines.push(`    ${criterionId} → ${evidenceIds.join(", ")}`);
  }
  lines.push("Artifacts:", ...task.artifacts.map(a => `  ${a.artifactId}: ${a.ref}`));
  lines.push("Status history:", ...task.statusHistory.map(change => `  r${change.revision} ${change.status}: ${change.reason}`));
  lines.push(`/plan-view full — back; plan_read taskId=${task.taskId} — full structured details`);
  return lines;
}

/** No ANSI or terminal controls from persisted user/model text. */
export function displayText(text: string): string {
  // eslint-disable-next-line no-control-regex -- persisted text must not control the terminal
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function renderPlan(view: PlanView, width: number, style: (text: string) => string = text => text, expanded = false, taskId?: string): string[] {
  if (width <= 0) return [];
  if (taskId && view.snapshot) {
    const lines = taskDetailLines(view, taskId).flatMap(line => wrapTextWithAnsi(displayText(line), width));
    // Keep a widget bounded even for the maximum-size persisted history.
    const visible = lines.length > 120 ? [...lines.slice(0, 119), `Details truncated; use plan_read with taskId=${taskId}`] : lines;
    return visible.map(line => truncateToWidth(style(line), width));
  }
  return planLines(view, expanded).map(line => truncateToWidth(style(displayText(line)), width));
}
