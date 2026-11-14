import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_ENTRY } from "../pi-extension/subagents/plan-persistence.ts";
import { PLAN_WIDGET } from "../pi-extension/subagents/plan-view-registration.ts";
import { planLines, renderPlan } from "../pi-extension/subagents/plan-view.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "plan-view-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any[]>();
  const widgets = new Map<string, any>();
  const notices: string[] = [];
  const pi = {
    appendEntry: (type: string, data: unknown) => { sm.appendCustomEntry(type, data); },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => events.set(name, [...(events.get(name) ?? []), handler]),
  } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", hasUI: true, sessionManager: sm, ui: {
    setWidget: (name: string, value: any) => widgets.set(name, value),
    notify: (message: string) => notices.push(message),
  } } as unknown as ExtensionContext;
  const savedId = process.env.PI_SUBAGENT_ID;
  const savedSession = process.env.PI_SUBAGENT_SESSION;
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_SESSION;
  const p = registerPlanTools(pi);
  if (savedId !== undefined) process.env.PI_SUBAGENT_ID = savedId;
  if (savedSession !== undefined) process.env.PI_SUBAGENT_SESSION = savedSession;
  const emit = (name: string) => { for (const handler of events.get(name) ?? []) handler({}, ctx); };
  emit("session_start");
  const readWidget = (width = 200) => widgets.get(PLAN_WIDGET)?.({}, { fg: (_: string, text: string) => text }).render(width).join("\n") ?? "";
  const update = async (command: unknown, revision: number) => (await tools.get("plan_update").execute("call", { command, expectedRevision: revision }, undefined, undefined, ctx)).details;
  return { dir, sm, p, ctx, tools, commands, widgets, notices, emit, readWidget, update, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("registered tools and native store update the widget without model messages; all statuses and acceptance count", async () => {
  const f = fixture();
  try {
    assert.equal(f.readWidget(), "");
    let plan = await f.update({ action: "create", title: "Native plan" }, 0);
    assert.match(f.readWidget(), /0\/0 accepted/);
    plan = f.p.read(f.sm).snapshot!;
    const criterionId = randomUUID();
    const mutate = (fn: (p: store.PlanSnapshot, c: store.CommandContext) => store.PlanSnapshot) => { plan = f.p.mutate(f.sm, plan.planId, plan.revision, fn); };
    for (const status of ["pending", "in_progress", "blocked", "in_review", "accepted", "failed", "skipped", "cancelled"] as const) {
      mutate((p, c) => store.addTask(p, c, status, { owner: "worker", criteria: [{ criterionId, text: "Verified" }] }));
      const id = plan.tasks.at(-1)!.taskId;
      if (status === "in_progress" || status === "failed") mutate((p, c) => store.startAttempt(p, c, id));
      if (status === "blocked") mutate((p, c) => store.block(p, c, id, "Needs decision"));
      if (status === "in_review" || status === "accepted") mutate((p, c) => store.submitReview(p, c, id, "Review"));
      if (status === "accepted") {
        mutate((p, c) => store.addEvidence(p, c, id, { criterionId, ref: "test report" }));
        mutate((p, c) => store.accept(p, c, id, { [criterionId]: p.tasks.at(-1)!.evidence.map(e => e.evidenceId) }, "Checked"));
      }
      if (status === "failed") {
        mutate((p, c) => store.attachRun(p, c, id, p.tasks.at(-1)!.attempts[0].attemptId, "run"));
        mutate((p, c) => store.recordResult(p, c, id, p.tasks.at(-1)!.attempts[0].attemptId, { eventId: "fail", runId: "run", ref: "failure", kind: "failure", reason: "Failed" }));
      }
      if (status === "skipped" || status === "cancelled") mutate((p, c) => store[status === "skipped" ? "skip" : "cancel"](p, c, id, "Explicit"));
    }
    const output = f.readWidget();
    assert.match(output, /1\/8 accepted/);
    assert.match(output, /Role\/owner: worker/);
    assert.match(output, /Reason: Needs decision/);
    for (const task of plan.tasks) assert.ok(output.includes(`| ${task.status} |`));
    await assert.rejects(() => f.update({ action: "add", planId: plan.planId, title: "Conflict" }, 0), /Revision conflict/);
    assert.equal(f.readWidget(), output);
  } finally { f.cleanup(); }
});

test("Unicode, controls, zero width, resize and theme invalidation respect terminal columns", () => {
  const plan = store.addTask(store.createPlan("界👩‍💻é\u001b[31m", { sessionId: "s", branchInstanceId: "b" }), { sessionId: "s", branchInstanceId: "b", expectedRevision: 0 }, "界".repeat(100));
  const view = { snapshot: plan, writable: true, recoveryUncertain: [] };
  assert.equal(planLines(view).length, 2);
  for (const width of [1, 2, 8, 20, 80]) for (const line of renderPlan(view, width)) assert.ok(visibleWidth(line) <= width);
  assert.deepEqual(renderPlan(view, 0), []);
  assert.ok(renderPlan(view, 200).every(line => !line.includes("\u001b[31m")));
  const f = fixture();
  try {
    f.p.create(f.sm, 0, "Theme");
    const theme = { fg: (_: string, text: string) => `old:${text}` };
    const component = f.widgets.get(PLAN_WIDGET)({}, theme);
    assert.match(component.render(100)[0], /^old:/);
    theme.fg = (_, text) => `new:${text}`;
    component.invalidate();
    assert.match(component.render(100)[0], /^new:/);
  } finally { f.cleanup(); }
});

test("tree, reload, detach, malformed branch and empty branch never show stale tasks", () => {
  const f = fixture();
  try {
    const before = f.sm.getLeafId()!;
    let plan = f.p.create(f.sm, 0, "Original");
    plan = f.p.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Original task"));
    const original = f.sm.getLeafId()!;
    const detached = f.p.detach(f.sm, plan.planId, plan.revision, "Copy");
    assert.equal(f.p.read(f.sm).snapshot?.planId, detached.planId);
    f.emit("session_start");
    assert.match(f.readWidget(), /Original task/);
    f.sm.branch(original);
    f.emit("session_tree");
    assert.equal(f.p.read(f.sm).snapshot?.planId, plan.planId);
    f.sm.appendCustomEntry(PLAN_ENTRY, { invalid: true });
    f.emit("session_tree");
    assert.match(f.readWidget(), /Plan unavailable/);
    assert.doesNotMatch(f.readWidget(), /Original task/);
    f.sm.branch(before);
    f.emit("session_tree");
    assert.equal(f.readWidget(), "");
    f.emit("session_shutdown");
    assert.equal(f.widgets.get(PLAN_WIDGET), undefined);
  } finally { f.cleanup(); }
});
