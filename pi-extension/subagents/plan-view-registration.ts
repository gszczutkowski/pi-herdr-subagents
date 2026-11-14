import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanPersistence } from "./plan-persistence.ts";
import { renderPlan } from "./plan-view.ts";

export const PLAN_WIDGET = "subagent-plan";

/** Presentation only; never appends entries, sends messages, or starts a model turn. */
export function registerPlanView(pi: ExtensionAPI, persistence: PlanPersistence) {
  let latest: ExtensionContext | undefined;
  let expanded = false;
  let taskId: string | undefined;
  const refresh = (ctx: ExtensionContext) => {
    latest = ctx;
    if (!ctx.hasUI) return;
    const view = persistence.read(ctx.sessionManager);
    if (!view.snapshot && !view.error) {
      ctx.ui.setWidget(PLAN_WIDGET, undefined);
    } else if (ctx.mode === "tui") {
      ctx.ui.setWidget(PLAN_WIDGET, (_tui, theme) => ({
        render: width => renderPlan(persistence.read(ctx.sessionManager), width, text => theme.fg("muted", text), expanded, taskId),
        invalidate() {}, // Stateless: re-read source and theme on every render.
      }));
    } else {
      ctx.ui.setWidget(PLAN_WIDGET, renderPlan(view, 120, undefined, expanded, taskId));
    }
  };
  pi.registerCommand("plan-view", {
    description: "Show durable plan: expand, full, compact, details <Tn|taskId> (no model turn)",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action.startsWith("details ")) {
        const selector = action.slice("details ".length).trim();
        const tasks = persistence.read(ctx.sessionManager).snapshot?.tasks ?? [];
        const index = /^T[1-9]\d*$/i.test(selector) ? Number(selector.slice(1)) - 1 : -1;
        const task = index >= 0 ? tasks[index] : tasks.find(t => t.taskId === selector);
        if (!task) {
          refresh(ctx);
          if (ctx.hasUI) ctx.ui.notify("Unknown task on the active branch; use /plan-view full or plan_read", "warning");
          return;
        }
        taskId = task.taskId;
      } else {
        if (action === "expand" || action === "full") expanded = true;
        else if (action === "compact") expanded = false;
        else if (!action) expanded = !expanded;
        else {
          if (ctx.hasUI) ctx.ui.notify("Usage: /plan-view [expand|full|compact|details <Tn|taskId>]", "warning");
          return;
        }
        taskId = undefined;
      }
      refresh(ctx);
    },
  });
  persistence.subscribe(sm => {
    if (latest?.sessionManager === sm) refresh(latest);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    latest = undefined;
    expanded = false;
    taskId = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(PLAN_WIDGET, undefined);
  });
  return refresh;
}
