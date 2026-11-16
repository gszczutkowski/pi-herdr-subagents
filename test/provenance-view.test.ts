import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerHistoryView, renderHistoryTree } from "../pi-extension/subagents/history-view.ts";
import { createLineage } from "../pi-extension/subagents/lineage.ts";
import { historyAnchors, readHistory, recordHistory } from "../pi-extension/subagents/history.ts";

test("native tree widget command toggles, retains closed history and watches without a model wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tree-view-"));
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const widgets = new Map<string, any>();
  let widgetWrites = 0;
  const pi: any = { on: (name: string, fn: Function) => { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    sendMessage: () => assert.fail("no model wake"), sendUserMessage: () => assert.fail("no model turn") };
  const emit = async (name: string, event: any, ctx: any) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  try {
    const sm = SessionManager.create(dir, join(dir, "sessions"));
    sm.appendMessage({ role: "user", content: "Root", timestamp: Date.now() });
    sm.appendCustomEntry("subagent-custody", { branchToken: "token" });
    const checkpoint = sm.getLeafId()!;
    const lineage = createLineage(sm, join(dir, "child.jsonl"), dir, dir,
      { checkpoint, branchToken: "token" }, (type, data) => sm.appendCustomEntry(type, data))!;
    recordHistory(lineage, "run", "assignment", "Build 界🙂", "assignment");
    const nested = { ...lineage, parent: lineage.child, child: { sessionId: "nested-id", sessionFile: join(dir, "nested.jsonl") } };
    recordHistory(nested, "nested-run", "result", "Closed descendant: tests verified", "result");
    const ctx: any = { sessionManager: sm, hasUI: true, mode: "tui", ui: {
      setWidget: (name: string, factory: any) => { widgets.set(name, factory); widgetWrites++; }, notify: () => {} } };
    registerHistoryView(pi, () => lineage.eventDirectory);
    assert.equal(widgetWrites, 0, "factory does not start resources or access session");
    await emit("session_start", {}, ctx);
    const render = () => widgets.get("subagent-history-tree")({}, { fg: (_c: string, s: string) => s }).render(100).join("\n");
    assert.equal(render().includes("nested-id"), false);
    const before = sm.getEntries().length;
    await commands.get("subagents-tree").handler("expand", ctx);
    assert.ok(render().includes("nested-id"));
    await commands.get("subagents-tree").handler(`toggle ${lineage.child.sessionId}`, ctx);
    assert.equal(render().includes("nested-id"), false);
    await commands.get("subagents-tree").handler(`toggle ${lineage.child.sessionId}`, ctx);
    assert.ok(render().includes("nested-id"));
    assert.equal(sm.getEntries().length, before, "presentation does not append native/model entries");
    const writes = widgetWrites;
    recordHistory(nested, "nested-run", "ping", "Explicit bounded question", "ping");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(widgetWrites > writes, "actual filesystem watcher refreshed the UI");
    assert.ok(render().includes("Explicit bounded question"));
    await emit("session_shutdown", {}, ctx);
    const stoppedWrites = widgetWrites;
    recordHistory(nested, "nested-run", "result", "After shutdown", "late");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(widgetWrites, stoppedWrites);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    assert.equal(readHistory(historyAnchors(reopened)).length, 4, "zero process registry needed on restart");
    // Selecting before the assignment hides the entire delegated subtree.
    sm.branch(checkpoint);
    assert.equal(readHistory(historyAnchors(sm)).length, 0);
  } finally { await emit("session_shutdown", {}, {}); rmSync(dir, { recursive: true, force: true }); }
});

test("tree projection bounds narrow Unicode, cycles, disconnected parents and deep nesting", () => {
  const identity = (sessionId: string) => ({ sessionId, sessionFile: `/sessions/${sessionId}.jsonl` });
  const root = identity("root");
  const event = (parent: string, child: string, i: number): any => ({ id: String(i), timestamp: "2026-01-01T12:00:00Z",
    kind: "result", summary: "界🙂 é explicit summary", lineage: { root, parent: identity(parent), child: identity(child) } });
  const events = [event("b", "a", 1), event("a", "b", 2), event("missing", "leaf", 3),
    ...Array.from({ length: 300 }, (_, i) => event(`depth${i}`, `depth${i + 1}`, i + 4))];
  for (const width of [1, 2, 5, 20, 80, 120]) {
    const lines = renderHistoryTree(events, { expanded: true, collapsed: new Set() }, width);
    assert.ok(lines.length <= 120);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.ok(renderHistoryTree(events.slice(0, 3), { expanded: true, collapsed: new Set() }, 100).some(l => l.includes("cycle")));
});
