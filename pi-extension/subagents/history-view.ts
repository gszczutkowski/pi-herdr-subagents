import { watch, type FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { boundedSummary, historyAnchors, readHistory, type HistoryEvent } from "./history.ts";

export interface TreePresentation { expanded: boolean; collapsed: Set<string> }
const key = (identity: { sessionId: string; sessionFile: string }) => JSON.stringify([identity.sessionId, identity.sessionFile]);

/** Pure bounded projection. Nodes are sessions, runs remain explicit history entries. */
export function renderHistoryTree(events: readonly HistoryEvent[], state: TreePresentation, width: number): string[] {
  const nodes = new Map<string, { id: string; parent?: string; label: string; events: HistoryEvent[] }>();
  for (const event of events.slice(-2000)) {
    const { root, parent, child } = event.lineage;
    for (const identity of [root, parent, child]) {
      const id = key(identity);
      if (!nodes.has(id) && nodes.size < 200) nodes.set(id, { id: identity.sessionId, label: boundedSummary(identity.sessionId), events: [] });
    }
    const node = nodes.get(key(child));
    if (node) {
      node.parent = key(parent);
      node.events.push(event);
    }
  }
  const lines = [`Subagent tree · ${nodes.size} sessions · ${events.length} explicit events`];
  const visited = new Set<string>();
  const emit = (id: string, depth: number) => {
    if (lines.length >= 120 || depth > 16) return;
    const node = nodes.get(id);
    if (!node || visited.has(id)) return;
    visited.add(id);
    const children = [...nodes].filter(([, child]) => child.parent === id).map(([childId]) => childId);
    const collapsed = !state.expanded || state.collapsed.has(node.id);
    const latest = node.events.at(-1);
    const hasDetails = children.length > 0 || node.events.length > 0;
    lines.push(`${"  ".repeat(depth)}${hasDetails ? collapsed ? "+" : "-" : "·"} ${node.label}${latest ? ` · ${latest.kind}` : ""}`);
    if (collapsed) return;
    for (const event of node.events.slice(-3)) {
      lines.push(`${"  ".repeat(Math.min(depth + 1, 17))}${event.timestamp.slice(11, 16)} ${event.kind}: ${boundedSummary(event.summary)}`);
      if (lines.length >= 120) return;
    }
    for (const child of children) emit(child, depth + 1);
  };
  const roots = [...nodes].filter(([, n]) => !n.parent || !nodes.has(n.parent)).map(([id]) => id);
  for (const root of roots) emit(root, 0);
  // A collapsed parent intentionally hides descendants, not "missing parent".
  // Only walk unvisited components that cannot reach any already shown root.
  for (const [id] of nodes) {
    if (visited.has(id)) continue;
    let cursor: string | undefined = id;
    const path = new Set<string>();
    while (cursor && !path.has(cursor) && !visited.has(cursor)) { path.add(cursor); cursor = nodes.get(cursor)?.parent; }
    if (cursor && visited.has(cursor)) continue;
    lines.push("[cycle / disconnected lineage]"); emit(id, 0);
  }
  if (!nodes.size) lines.push("No branch-authorized history yet (not a process status view).");
  lines.push(state.expanded ? "/subagents-tree compact | toggle <sessionId>" : "/subagents-tree expand");
  return lines.slice(0, 120).map(line => truncateToWidth(line, Math.max(1, width)));
}

/** No watchers/timers in the extension factory and no model turns for UI refresh. */
export function registerHistoryView(pi: ExtensionAPI, defaultDirectory: (ctx: ExtensionContext) => string): void {
  const state: TreePresentation = { expanded: false, collapsed: new Set() };
  let context: ExtensionContext | undefined;
  let started = false;
  let events: HistoryEvent[] = [];
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { for (const watcher of watchers) watcher.close(); watchers = []; if (timer) clearTimeout(timer); timer = undefined; };
  const refresh = () => {
    const ctx = context;
    if (!ctx) return;
    events = readHistory(historyAnchors(ctx.sessionManager));
    if (ctx.hasUI) ctx.ui.setWidget("subagent-history-tree", (_tui, theme) => ({
      render: (width: number) => renderHistoryTree(events, state, width).map(line => theme.fg("muted", line)),
      invalidate() {},
    }));
  };
  const observe = () => {
    stop();
    if (!started || !context) return;
    const directories = new Set([defaultDirectory(context), ...historyAnchors(context.sessionManager).map(a => a.eventDirectory)]);
    for (const directory of directories) {
      try {
        const watcher = watch(directory, () => {
          if (!started || !context) return;
          if (!timer) timer = setTimeout(() => { timer = undefined; refresh(); }, 60);
        });
        watcher.on("error", () => { watcher.close(); });
        watchers.push(watcher);
      } catch { /* directory may not exist yet; command refresh always works */ }
    }
  };
  pi.on("session_start", (_event, ctx) => { started = true; context = ctx; refresh(); observe(); });
  pi.on("session_tree", (_event, ctx) => { context = ctx; refresh(); observe(); });
  pi.on("tool_execution_end", event => {
    if (["subagent", "subagent_resume", "plan_update"].includes(event.toolName)) { refresh(); observe(); }
  });
  pi.on("session_shutdown", () => { started = false; stop(); context = undefined; events = []; });
  pi.registerCommand("subagents-tree", {
    description: "Toggle/expand/compact provenance tree; toggle <sessionId> collapses a subtree. Never wakes a model.",
    handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/);
      if (!action) state.expanded = !state.expanded;
      else if (action === "expand") state.expanded = true;
      else if (action === "compact") state.expanded = false;
      else if (action === "toggle" && id) {
        state.expanded = true;
        if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      } else if (action !== "refresh") { ctx.ui.notify("Usage: /subagents-tree [expand|compact|refresh|toggle <sessionId>]", "warning"); return; }
      context = ctx; refresh();
      // Commands may refresh a session-start-owned resource, never create one in the factory.
      observe();
      if (!ctx.hasUI) return;
      if (ctx.mode !== "tui") ctx.ui.notify(renderHistoryTree(events, state, 100).join("\n"), "info");
    },
  });
}
