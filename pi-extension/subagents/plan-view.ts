import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PlanView } from "./plan-persistence.ts";
import type { TaskStatus } from "./plan-store.ts";

const icons: Record<TaskStatus, string> = {
  pending: "○", in_progress: "◐", blocked: "!", in_review: "◇",
  accepted: "✓", failed: "×", skipped: "–", cancelled: "⊘",
};

/** Persisted task state only: process exit and result delivery never check a box. */
export function planLines(view: PlanView): string[] {
  const plan = view.snapshot;
  if (!plan) return view.error ? [`Plan unavailable: ${view.error}`] : [];
  const lines = [`Plan: ${plan.title} — ${plan.tasks.filter(t => t.status === "accepted").length}/${plan.tasks.length} accepted`];
  if (view.error) lines.push(`Read-only: ${view.error}`);
  for (const [index, task] of plan.tasks.entries()) {
    lines.push(`${icons[task.status]} T${index + 1} ${task.title} | ${task.status} | Role/owner: ${task.owner}`);
    if (task.status === "blocked" || task.status === "failed") lines.push(`  Reason: ${task.statusReason}`);
    const waiting = task.dependencies.filter(id => plan.tasks.find(t => t.taskId === id)?.status !== "accepted");
    if (waiting.length) lines.push(`  Waiting on: ${waiting.map(id => `T${plan.tasks.findIndex(t => t.taskId === id) + 1}`).join(", ")}`);
    if (view.recoveryUncertain.includes(task.taskId)) lines.push("  Recovery uncertain; runtime presence not verified");
  }
  return lines;
}

/** No ANSI or terminal controls from persisted user/model text. */
export function displayText(text: string): string {
  // eslint-disable-next-line no-control-regex -- persisted text must not control the terminal
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function renderPlan(view: PlanView, width: number, style: (text: string) => string = text => text): string[] {
  if (width <= 0) return [];
  return planLines(view).map(line => truncateToWidth(style(displayText(line)), width));
}
