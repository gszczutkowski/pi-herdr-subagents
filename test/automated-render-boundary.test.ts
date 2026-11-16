import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { visibleWidth } from "@earendil-works/pi-tui";
import { nativeFixture } from "./automated-boundary-fixture.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_WIDGET } from "../pi-extension/subagents/plan-view-registration.ts";
import { registerHistoryView, renderHistoryTree } from "../pi-extension/subagents/history-view.ts";
import { createLineage } from "../pi-extension/subagents/lineage.ts";
import { historyAnchors, readHistory, recordHistory } from "../pi-extension/subagents/history.ts";
import extension from "../pi-extension/subagents/index.ts";

test("registered plan/history regions resize and invalidate independently without writes or model wakes", async () => {
  const f = nativeFixture();
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), widgets = new Map<string, any>();
  const renderers = new Map<string, any>();
  const pi: any = {
    on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool() {}, registerShortcut() {}, getAllTools: () => [],
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    appendEntry: (type: string, data: any) => f.sm.appendCustomEntry(type, data),
    sendMessage: () => assert.fail("rendering must not wake model"),
    sendUserMessage: () => assert.fail("presentation must not request model work"),
  };
  // Collect the production response renderer without starting runtime resources.
  extension(pi); handlers.clear(); commands.clear();
  const saved = { id: process.env.PI_SUBAGENT_ID, session: process.env.PI_SUBAGENT_SESSION };
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  const persistence = registerPlanTools(pi);
  if (saved.id !== undefined) process.env.PI_SUBAGENT_ID = saved.id;
  if (saved.session !== undefined) process.env.PI_SUBAGENT_SESSION = saved.session;
  const ctx: any = { ...f.ctx, mode: "tui", hasUI: true, ui: {
    setWidget: (name: string, factory: any) => widgets.set(name, factory), notify() {},
  } };
  const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  try {
    const criterionId = randomUUID();
    f.mutate((p, c) => store.addTask(p, c, "Detailed 界👩‍💻é", { scope: "界".repeat(8000),
      criteria: [{ criterionId, text: "Checked" }], artifacts: [{ artifactId: randomUUID(), ref: "file:///report/界.md" }] }));
    const detailed = f.read().tasks[0].taskId;
    for (let i = 0; i < 35; i++) f.mutate((p, c) => store.addTask(p, c, `Task ${i} 界`));
    const beforeLineage = f.sm.getLeafId()!;
    f.sm.appendCustomEntry("subagent-custody", { branchToken: "view-token" });
    const lineage = createLineage(f.sm, join(f.dir, "child.jsonl"), f.dir, f.dir,
      { checkpoint: f.sm.getLeafId()!, branchToken: "view-token" }, (type, data) => f.sm.appendCustomEntry(type, data))!;
    recordHistory(lineage, "view-run", "result", "Explicit proposal 界🙂", "result");
    registerHistoryView(pi, () => lineage.eventDirectory);
    await emit("session_start");
    const leaf = f.sm.getLeafId();
    await commands.get("plan-view").handler("full", ctx);
    await commands.get("subagents-tree").handler("expand", ctx);
    const theme = { fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m`,
      bg: (_color: string, text: string) => text, bold: (text: string) => text };
    const actualPlan = widgets.get(PLAN_WIDGET)({}, theme);
    const tree = widgets.get("subagent-history-tree")({}, theme);
    assert.match(actualPlan.render(200).join("\n"), /T36 Task 34/);
    assert.match(tree.render(200).join("\n"), /Explicit proposal/);
    const result = renderers.get("subagent_result")({ content: "Independent assistant summary", details: {
      name: "Worker 界", task: "Render proposal", response: "Independent assistant summary",
      structuredResult: { status: "complete", summary: "Proposal 界".repeat(100), artifacts: ["file:///report/界.md"],
        checks: [{ criterionIds: [criterionId], ref: "report#check", outcome: "passed" }], unmetCriterionIds: [], risks: [] },
    } }, { expanded: true, outputPad: 1 }, theme);
    for (const width of [1, 2, 8, 24, 80, 160]) {
      for (const component of [actualPlan, tree, result]) {
        const lines = component.render(width);
        assert.ok(lines.length > 0);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `column bound ${width}`);
      }
      assert.ok(tree.render(width).length <= 120);
    }
    assert.match(result.render(160).join("\n"), /report#check/);
    theme.fg = (_color, text) => `\u001b[35m${text}\u001b[0m`;
    for (const component of [actualPlan, tree, result]) {
      component.invalidate();
      assert.ok(component.render(80).some((line: string) => line.includes("\u001b[35m")));
    }
    await commands.get("plan-view").handler(`details ${detailed}`, ctx);
    const details = widgets.get(PLAN_WIDGET)({}, theme);
    assert.equal(details.render(80).length, 120);
    assert.match(details.render(80).at(-1)!, /Details truncated/);
    assert.equal(f.sm.getLeafId(), leaf, "presentation appends neither plan nor model entries");
    // Removing only lineage anchors clears history, not the persistent plan region.
    f.sm.branch(beforeLineage); await emit("session_tree");
    assert.match(widgets.get("subagent-history-tree")({}, theme).render(160).join("\n"), /No branch-authorized history/);
    assert.equal(persistence.read(f.sm).snapshot!.tasks.length, 36);
    f.sm.branch(f.sm.getBranch().find(e => e.type === "message")!.id); await emit("session_tree");
    assert.equal(widgets.get(PLAN_WIDGET), undefined, "a branch without a plan clears the stale task region");
    assert.equal(readHistory(historyAnchors(f.sm)).length, 0);
  } finally { await emit("session_shutdown"); f.cleanup(); }
});

test("authorized history data remains bounded with cyclic and missing-parent components", () => {
  const identity = (id: string) => ({ sessionId: id, sessionFile: `/sessions/${id}.jsonl` });
  const events = Array.from({ length: 2100 }, (_, i): any => ({ id: String(i), timestamp: "2026-01-01T12:00:00Z",
    kind: "result", summary: "界é👩‍💻".repeat(200), lineage: { root: identity("root"),
      parent: identity(i % 2 ? "cycle-a" : "cycle-b"), child: identity(i % 2 ? "cycle-b" : "cycle-a") } }));
  events.push({ ...events[0], id: "missing", lineage: { root: identity("root"), parent: identity("absent"), child: identity("orphan") } });
  for (const width of [1, 8, 24, 120]) {
    const lines = renderHistoryTree(events, { expanded: true, collapsed: new Set() }, width);
    assert.ok(lines.length <= 120); assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  const text = renderHistoryTree(events, { expanded: true, collapsed: new Set() }, 160).join("\n");
  assert.match(text, /cycle \/ disconnected/); assert.match(text, /orphan/);
});
