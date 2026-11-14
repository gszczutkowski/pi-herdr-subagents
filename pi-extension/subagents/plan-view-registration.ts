import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanPersistence } from "./plan-persistence.ts";
import { renderPlan } from "./plan-view.ts";

export const PLAN_WIDGET = "subagent-plan";

/** Presentation only; never appends entries, sends messages, or starts a model turn. */
export function registerPlanView(pi: ExtensionAPI, persistence: PlanPersistence) {
  let latest: ExtensionContext | undefined;
  let expanded = false;
  const refresh = (ctx: ExtensionContext) => {
    latest = ctx;
    if (!ctx.hasUI) return;
    const view = persistence.read(ctx.sessionManager);
    if (!view.snapshot && !view.error) {
      ctx.ui.setWidget(PLAN_WIDGET, undefined);
    } else if (ctx.mode === "tui") {
      ctx.ui.setWidget(PLAN_WIDGET, (_tui, theme) => ({
        render: width => renderPlan(persistence.read(ctx.sessionManager), width, text => theme.fg("muted", text), expanded),
        invalidate() {}, // Stateless: re-read source and theme on every render.
      }));
    } else {
      ctx.ui.setWidget(PLAN_WIDGET, renderPlan(view, 120, undefined, expanded));
    }
  };
  pi.registerCommand("plan-view", {
    description: "Show durable plan: expand, full, compact (no model turn)",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "expand" || action === "full") expanded = true;
      else if (action === "compact") expanded = false;
      else if (!action) expanded = !expanded;
      else {
        if (ctx.hasUI) ctx.ui.notify("Usage: /plan-view [expand|full|compact]", "warning");
        return;
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
    if (ctx.hasUI) ctx.ui.setWidget(PLAN_WIDGET, undefined);
  });
  return refresh;
}
