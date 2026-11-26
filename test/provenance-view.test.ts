import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OPEN_ACCENT } from "../pi-extension/subagents/frame.ts";
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
    const command = (args: string) => commands.get("subagents-tree").handler(args, ctx);
    const component = () => widgets.get("subagent-history-tree")({}, { fg: (_c: string, s: string) => `\x1b[90m${s}\x1b[39m` });
    const render = () => stripTerminalSequences(component().render(100).join("\n"));
    assert.equal(widgetWrites, 0, "even populated history is not shown by default");
    const before = sm.getEntries().length;
    await command("compact");
    assert.equal(render().includes("nested-id"), false);
    await command("expand");
    assert.match(render(), /╭─ Subagent tree · 3 sessions · 2 explicit events/);
    assert.match(render(), /└─ - nested-id/);
    assert.equal(component().render(100)[0].startsWith(`${OPEN_ACCENT}╭`), true);
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
    // Selecting before the assignment hides the entire delegated subtree but not the requested view.
    sm.branch(checkpoint);
    await emit("session_tree", {}, ctx);
    assert.match(render(), /╭─ Subagent tree ─/);
    assert.match(render(), /No branch-authorized history yet\./);
    assert.doesNotMatch(render(), /nested-id|Explicit bounded question|0 sessions/);
    assert.equal(readHistory(historyAnchors(sm)).length, 0);
    await emit("session_shutdown", {}, ctx);
    const stoppedWrites = widgetWrites;
    recordHistory(nested, "nested-run", "result", "After shutdown", "late");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(widgetWrites, stoppedWrites);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    assert.equal(readHistory(historyAnchors(reopened)).length, 4, "zero process registry needed on restart");
  } finally { await emit("session_shutdown", {}, {}); rmSync(dir, { recursive: true, force: true }); }
});

test("empty history stays hidden on native refreshes and can be opened and dismissed", async () => {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let factory: any;
  let reads = 0, observation = 0;
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
  } as any;
  const ctx = {
    mode: "tui", hasUI: true, sessionManager: {
      getBranch: () => { reads++; return []; }, getSessionFile: () => join(tmpdir(), "tree-test.jsonl"),
    },
    ui: { setWidget: (name: string, next: any) => { assert.equal(name, "subagent-history-tree"); factory = next; } },
  };
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  const command = (args: string) => commands.get("subagents-tree").handler(args, ctx);
  registerHistoryView(pi, () => { observation++; return join(tmpdir(), "missing-tree-test-directory"); });
  try {
    emit("session_start");
    emit("session_tree");
    emit("tool_execution_end", { toolName: "subagent" });
    assert.equal(factory, undefined);
    assert.equal(reads + observation, 0);
    await command("");
    const component = factory({}, { fg: (_c: string, line: string) => line });
    const lines = stripTerminalSequences(component.render(70).join("\n")).split("\n");
    assert.match(lines[0], /^╭─ Subagent tree ─/);
    assert.match(lines[1], /No branch-authorized history yet\./);
    assert.match(lines[2], /not a process status view/);
    assert.match(lines[3], /^╰─+╯$/);
    assert.match(lines[4], /^\/subagents-tree compact.*off$/);
    assert.ok(lines.slice(0, 4).every(line => visibleWidth(line) === 68));
    await command("off");
    const before = reads + observation;
    emit("session_tree");
    emit("tool_execution_end", { toolName: "plan_update" });
    assert.equal(factory, undefined);
    assert.equal(reads + observation, before);
    await command("expand");
    assert.ok(factory);
    emit("session_shutdown");
    assert.equal(factory, undefined);
    emit("session_start");
    assert.equal(factory, undefined);
  } finally { emit("session_shutdown"); }
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
