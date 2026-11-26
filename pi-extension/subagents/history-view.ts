import { watch, type FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { borderBottom, borderLine, borderTop, OPEN_ACCENT } from "./frame.ts";
import { boundedSummary, historyAnchors, readHistory, type HistoryEvent } from "./history.ts";

export interface TreePresentation { expanded: boolean; collapsed: Set<string> }
const key = (identity: { sessionId: string; sessionFile: string }) => JSON.stringify([identity.sessionId, identity.sessionFile]);
const WIDGET = "subagent-history-tree";
const MAX_BODY = 116; // Leave room for the truncation notice, borders and command hint.

/** Pure bounded projection. Nodes are sessions, runs remain explicit history entries. */
function projectHistoryTree(events: readonly HistoryEvent[], state: TreePresentation) {
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
  const title = nodes.size ? `Subagent tree · ${nodes.size} sessions · ${events.length} explicit events` : "Subagent tree";
  const body: string[] = [];
  let truncated = false;
  const add = (line: string) => {
    if (body.length >= MAX_BODY) { truncated = true; return false; }
    body.push(line);
    return true;
  };
  const visited = new Set<string>();
  const emit = (id: string, depth: number, prefix = "", last = true) => {
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) return;
    if (depth > 16 || body.length >= MAX_BODY) { truncated = true; return; }
    visited.add(id);
    const children = [...nodes].filter(([, child]) => child.parent === id).map(([childId]) => childId);
    const collapsed = !state.expanded || state.collapsed.has(node.id);
    const latest = node.events.at(-1);
    const hasDetails = children.length > 0 || node.events.length > 0;
    const edge = depth === 0 ? "" : last ? "└─ " : "├─ ";
    add(`${prefix}${edge}${hasDetails ? collapsed ? "+" : "-" : "·"} ${node.label}${latest ? ` · ${latest.kind}` : ""}`);
    if (collapsed) return;
    const indent = prefix + (depth === 0 ? "" : last ? "   " : "│  ");
    for (const event of node.events.slice(-3)) {
      if (!add(`${indent}${children.length ? "│  " : "   "}${event.timestamp.slice(11, 16)} ${event.kind}: ${boundedSummary(event.summary)}`)) return;
    }
    children.forEach((child, i) => emit(child, depth + 1, indent, i === children.length - 1));
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
    if (!add("[cycle / disconnected lineage]")) break;
    emit(id, 0);
  }
  if (truncated) body.push("… more history omitted");
  if (!nodes.size) body.push("No branch-authorized history yet.", "This is not a process status view.");
  const hint = state.expanded ? "/subagents-tree compact | toggle <sessionId> | off" : "/subagents-tree expand | off";
  return { title, body, hint };
}

export function renderHistoryTree(events: readonly HistoryEvent[], state: TreePresentation, width: number): string[] {
  const { title, body, hint } = projectHistoryTree(events, state);
  return [title, ...body, hint].map(line => truncateToWidth(line, Math.max(1, width)));
}

function historyWidget(events: readonly HistoryEvent[], state: TreePresentation, muted: (line: string) => string) {
  const { title, body, hint } = projectHistoryTree(events, state);
  let cache: { width: number; lines: string[] } | undefined;
  return {
    invalidate() { cache = undefined; },
    render(width: number): string[] {
      if (!Number.isFinite(width) || width <= 0) return [];
      if (cache?.width === width) return cache.lines;
      // Match the clear-pi frames' right margin, but keep text usable in tiny terminals.
      const available = Math.max(1, Math.floor(width) - 2);
      const fit = (line: string, limit = available) => truncateToWidth(line, limit, "…");
      const lines = available < 12
        ? [title, ...body, hint].map(line => muted(fit(line)))
        : [borderTop(title, "", available, OPEN_ACCENT),
          ...body.map(line => borderLine(` ${muted(fit(line, available - 4))}`, " ", available, OPEN_ACCENT)),
          borderBottom(available, OPEN_ACCENT), muted(fit(hint))];
      cache = { width, lines };
      return lines;
    },
  };
}

/** No watchers/timers in the extension factory and no model turns for UI refresh. */
export function registerHistoryView(pi: ExtensionAPI, defaultDirectory: (ctx: ExtensionContext) => string): void {
  const state: TreePresentation = { expanded: false, collapsed: new Set() };
  let context: ExtensionContext | undefined;
  let started = false;
  let open = false;
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { for (const watcher of watchers) watcher.close(); watchers = []; if (timer) clearTimeout(timer); timer = undefined; };
  const hide = () => {
    stop();
    if (open && context) context.ui.setWidget(WIDGET, undefined);
    open = false;
  };
  const refresh = () => {
    const ctx = context;
    if (!open || !ctx) return;
    const events = readHistory(historyAnchors(ctx.sessionManager));
    ctx.ui.setWidget(WIDGET, (_tui, theme) => historyWidget(events, state, line => theme.fg("muted", line)));
  };
  const observe = () => {
    stop();
    if (!started || !open || !context) return;
    const directories = new Set([defaultDirectory(context), ...historyAnchors(context.sessionManager).map(a => a.eventDirectory)]);
    for (const directory of directories) {
      try {
        const watcher = watch(directory, () => {
          if (!started || !open || !watchers.includes(watcher)) return;
          if (!timer) timer = setTimeout(() => { timer = undefined; refresh(); }, 60);
        });
        watcher.on("error", () => { watcher.close(); });
        watchers.push(watcher);
      } catch { /* directory may not exist yet; command refresh always works */ }
    }
  };
  pi.on("session_start", () => {
    hide();
    started = true;
    state.expanded = false;
    state.collapsed.clear();
  });
  pi.on("session_tree", (_event, ctx) => { if (open) { context = ctx; refresh(); observe(); } });
  pi.on("tool_execution_end", event => {
    if (open && ["subagent", "subagent_resume", "plan_update"].includes(event.toolName)) { refresh(); observe(); }
  });
  pi.on("session_shutdown", () => { started = false; hide(); context = undefined; });
  pi.registerCommand("subagents-tree", {
    description: "Open or hide the recorded subagent history tree: expand|compact|refresh|toggle <sessionId>|off",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const [action, id, extra] = args.trim().split(/\s+/);
      if (action === "toggle" ? !id || !!extra : !!id || !["", "expand", "compact", "refresh", "off"].includes(action)) {
        ctx.ui.notify("Usage: /subagents-tree [expand|compact|refresh|toggle <sessionId>|off]", "warning");
        return;
      }
      if (action === "off") { hide(); context = undefined; return; }
      if (!action || action === "expand") state.expanded = !action && open ? !state.expanded : true;
      else if (action === "compact") state.expanded = false;
      else if (action === "toggle") {
        state.expanded = true;
        if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderHistoryTree(readHistory(historyAnchors(ctx.sessionManager)), state, 100).join("\n"), "info");
        return;
      }
      if (!started) return;
      context = ctx;
      open = true;
      refresh();
      observe();
    },
  });
}
