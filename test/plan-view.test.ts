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
  let failAppend = false;
  const pi = {
    appendEntry: (type: string, data: unknown) => {
      sm.appendCustomEntry(type, data);
      if (failAppend) { failAppend = false; throw new Error("Injected append failure"); }
    },
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
  return { dir, sm, p, ctx, tools, commands, widgets, notices, emit, readWidget, update, failNextAppend: () => { failAppend = true; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    await f.commands.get("plan-view").handler("full", f.ctx);
    const output = f.readWidget();
    assert.match(output, /1\/8 accepted/);
    assert.match(output, /Role\/owner: worker/);
    assert.match(output, /Reason: Needs decision/);
    for (const task of plan.tasks) assert.ok(output.includes(`| ${task.status} |`));
    await assert.rejects(() => f.update({ action: "add", planId: plan.planId, title: "Conflict" }, 0), /Revision conflict/);
    assert.equal(f.readWidget(), output);
  } finally { f.cleanup(); }
});

test("registered plan-view command expands long plans without checklist state or writes", async () => {
  const f = fixture();
  try {
    assert.deepEqual([...f.commands.keys()], ["plan-view"]); // Existing /plan is not replaced.
    let plan = f.p.create(f.sm, 0, "Long plan");
    for (let i = 1; i <= 30; i++) plan = f.p.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, `Task ${i} 界`));
    const leaf = f.sm.getLeafId();
    assert.match(f.readWidget(), /24 more tasks/);
    assert.doesNotMatch(f.readWidget(), /T30 /);
    for (const mode of ["expand", "full"]) {
      await f.commands.get("plan-view").handler(mode, f.ctx);
      assert.match(f.readWidget(), /T30 Task 30/);
      assert.match(f.readWidget(), /0\/30 accepted/);
      assert.equal(f.sm.getLeafId(), leaf);
    }
    const factory = f.widgets.get(PLAN_WIDGET);
    const component = factory({}, { fg: (_: string, text: string) => text });
    for (const width of [1, 12, 40, 120]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    await f.commands.get("plan-view").handler("compact", f.ctx);
    assert.match(f.readWidget(), /24 more tasks/);
    await f.commands.get("plan-view").handler("", f.ctx);
    assert.match(f.readWidget(), /T30 Task 30/);
    await f.commands.get("plan-view").handler("invalid", f.ctx);
    assert.match(f.notices.at(-1)!, /Usage/);
    assert.deepEqual(f.p.read(f.sm).snapshot, plan);
  } finally { f.cleanup(); }
});

test("details command exposes criteria, attempts, results, checks, decisions and links; text tool works without TUI", async () => {
  const f = fixture();
  try {
    let plan = f.p.create(f.sm, 0, "Details");
    const beforeTask = f.sm.getLeafId()!;
    const criterionId = randomUUID();
    const artifactId = randomUUID();
    const mutate = (fn: (p: store.PlanSnapshot, c: store.CommandContext) => store.PlanSnapshot) => { plan = f.p.mutate(f.sm, plan.planId, plan.revision, fn); };
    mutate((p, c) => store.addTask(p, c, "Detailed task", { owner: "reviewer", scope: "Small scope", criteria: [{ criterionId, text: "All checks pass" }], artifacts: [{ artifactId, ref: "file:///tmp/report.md" }] }));
    const id = plan.tasks[0].taskId;
    mutate((p, c) => store.startAttempt(p, c, id, "file:///tmp/child-one.jsonl"));
    mutate((p, c) => store.attachRun(p, c, id, p.tasks[0].attempts[0].attemptId, "run-one"));
    mutate((p, c) => store.recordResult(p, c, id, p.tasks[0].attempts[0].attemptId, { eventId: "result-one", runId: "run-one", ref: "file:///tmp/result-one.md" }));
    mutate((p, c) => store.retry(p, c, id, "file:///tmp/child-two.jsonl"));
    mutate((p, c) => store.attachRun(p, c, id, p.tasks[0].attempts[1].attemptId, "run-two"));
    mutate((p, c) => store.recordResult(p, c, id, p.tasks[0].attempts[1].attemptId, { eventId: "result-two", runId: "run-two", ref: "https://example.com/result" }));
    mutate((p, c) => store.addEvidence(p, c, id, { criterionId, artifactId, resultEventId: "result-two", ref: "node --test: 2 passed" }));
    mutate((p, c) => store.accept(p, c, id, { [criterionId]: p.tasks[0].evidence.map(e => e.evidenceId) }, "Parent verified"));
    await f.commands.get("plan-view").handler("details T1", f.ctx);
    const text = f.readWidget();
    for (const expected of ["All checks pass", "Small scope", "run-one", "run-two", "child-one.jsonl", "child-two.jsonl", "result-one.md", "https://example.com/result", "2 passed", "Parent verified", "report.md", "Status history:", "✓"]) assert.ok(text.includes(expected), expected);
    const leaf = f.sm.getLeafId();
    await f.commands.get("plan-view").handler(`details ${id}`, f.ctx);
    assert.equal(f.readWidget(), text);
    assert.equal(f.sm.getLeafId(), leaf);
    mutate((p, c) => store.editTask(p, c, id, { scope: "Changed scope" }));
    assert.match(f.readWidget(), /invalidate/);
    assert.match(f.readWidget(), /Status: in_review/);
    assert.match(f.readWidget(), /○.*All checks pass/);
    const noUI = { ...f.ctx, mode: "print", hasUI: false, ui: new Proxy({}, { get() { throw new Error("No UI access allowed"); } }) };
    const result = await f.tools.get("plan_read").execute("read", { taskId: id }, undefined, undefined, noUI);
    assert.deepEqual(result.details.snapshot.tasks, plan.tasks);
    assert.match(result.content[0].text, /node --test: 2 passed/);
    await f.commands.get("plan-view").handler(`details ${id}`, noUI);
    const component = f.widgets.get(PLAN_WIDGET)({}, { fg: (_: string, text: string) => text });
    for (const width of [1, 12, 30, 80]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    f.sm.branch(beforeTask);
    f.emit("session_tree");
    assert.match(f.readWidget(), /Task not on the active branch/);
    assert.doesNotMatch(f.readWidget(), /Detailed task/);
    await f.commands.get("plan-view").handler("details T1", f.ctx);
    assert.match(f.notices.at(-1)!, /Unknown task/);
    await f.commands.get("plan-view").handler("full", f.ctx);
    assert.match(f.readWidget(), /0\/0 accepted/);
  } finally { f.cleanup(); }
});

test("append failure immediately marks the widget read-only; reconciliation and observer errors cannot alter commands", async () => {
  const f = fixture();
  try {
    const plan = f.p.create(f.sm, 0, "Errors");
    const unsubscribe = f.p.subscribe(() => { throw new Error("Broken observer"); });
    f.failNextAppend();
    await assert.rejects(() => f.update({ action: "add", planId: plan.planId, title: "Durable task" }, plan.revision), /append failed/);
    assert.match(f.readWidget(), /Read-only: Plan append failed/);
    assert.match(f.readWidget(), /Durable task/);
    const read = await f.tools.get("plan_read").execute("read", { reconcile: true }, undefined, undefined, f.ctx);
    assert.equal(read.details.writable, true);
    assert.doesNotMatch(f.readWidget(), /Read-only/);
    const next = await f.update({ action: "add", planId: plan.planId, title: "Next task" }, read.details.snapshot.revision);
    assert.equal(next.tasks.length, 2);
    unsubscribe();
  } finally { f.cleanup(); }
});

test("details previews are explicitly bounded with the full structured task available", async () => {
  const f = fixture();
  try {
    let plan = f.p.create(f.sm, 0, "Long details");
    plan = f.p.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Long task", { scope: "界".repeat(8000) }));
    await f.commands.get("plan-view").handler("details T1", f.ctx);
    const lines = f.readWidget(80).split("\n");
    assert.equal(lines.length, 120);
    assert.match(lines.at(-1)!, /Details truncated; use plan_read/);
    const result = await f.tools.get("plan_read").execute("read", { taskId: plan.tasks[0].taskId }, undefined, undefined, { ...f.ctx, hasUI: false, mode: "json" });
    assert.equal(result.details.snapshot.tasks[0].scope, plan.tasks[0].scope);
  } finally { f.cleanup(); }
});

test("completed task rows survive actual runtime removal and disk reopen with zero agents", async () => {
  const f = fixture();
  const { observeSubagentCompletion } = await import("../pi-extension/subagents/index.ts");
  const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
  const previousCtx = runtime.latestCtx;
  try {
    let plan = f.p.create(f.sm, 0, "Retained");
    const mutate = (fn: (p: store.PlanSnapshot, c: store.CommandContext) => store.PlanSnapshot) => { plan = f.p.mutate(f.sm, plan.planId, plan.revision, fn); };
    for (const status of ["in_review", "accepted", "failed", "skipped", "cancelled"] as const) {
      const criterionId = randomUUID();
      mutate((p, c) => store.addTask(p, c, `Retained ${status}`, { criteria: [{ criterionId, text: "Checked" }] }));
      const id = plan.tasks.at(-1)!.taskId;
      if (status === "in_review" || status === "accepted") mutate((p, c) => store.submitReview(p, c, id, "Submitted, not process success"));
      if (status === "accepted") {
        mutate((p, c) => store.addEvidence(p, c, id, { criterionId, ref: "check" }));
        mutate((p, c) => store.accept(p, c, id, { [criterionId]: p.tasks.at(-1)!.evidence.map(e => e.evidenceId) }, "Parent acceptance"));
      }
      if (status === "failed") {
        mutate((p, c) => store.startAttempt(p, c, id));
        mutate((p, c) => store.attachRun(p, c, id, p.tasks.at(-1)!.attempts[0].attemptId, "failed-run"));
        mutate((p, c) => store.recordResult(p, c, id, p.tasks.at(-1)!.attempts[0].attemptId, { eventId: "failed-event", runId: "failed-run", kind: "failure", reason: "failed", ref: "report" }));
      }
      if (status === "skipped" || status === "cancelled") mutate((p, c) => store[status === "skipped" ? "skip" : "cancel"](p, c, id, "Explicit"));
    }
    const before = f.readWidget();
    const running = { id: randomUUID(), lifecycle: { delivery: "pending" } } as any;
    runtime.latestCtx = f.ctx;
    runtime.runningSubagents.set(running.id, running);
    // The real watcher settlement path deletes the last process and clears its widget.
    await observeSubagentCompletion(running, Promise.resolve({ supervisionEnded: true } as any));
    assert.equal(runtime.runningSubagents.has(running.id), false);
    assert.equal(f.widgets.get("subagent-status"), undefined);
    assert.equal(f.readWidget(), before);
    assert.match(before, /1\/5 accepted/);
    const reopened = SessionManager.open(f.sm.getSessionFile()!);
    assert.equal(renderPlan(f.p.restore(reopened), 200).join("\n"), before);
    assert.deepEqual(f.p.read(reopened).snapshot, plan);
  } finally { runtime.latestCtx = previousCtx; f.cleanup(); }
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

test("unaccepted dependencies and restored uncertainty are explicit, including RPC string widgets", async () => {
  const f = fixture();
  try {
    let plan = f.p.create(f.sm, 0, "Dependencies");
    plan = f.p.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Prerequisite"));
    const prerequisite = plan.tasks[0].taskId;
    plan = f.p.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Dependent", { dependencies: [prerequisite] }));
    plan = f.p.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.startAttempt(p, c, p.tasks[1].taskId));
    assert.match(f.readWidget(), /Waiting on: T1/);
    assert.doesNotMatch(f.readWidget(), /Recovery uncertain/);
    f.emit("session_start");
    assert.match(f.readWidget(), /Recovery uncertain; runtime presence not verified/);
    await f.commands.get("plan-view").handler("full", { ...f.ctx, mode: "rpc" });
    assert.ok(Array.isArray(f.widgets.get(PLAN_WIDGET)));
    assert.match(f.widgets.get(PLAN_WIDGET).join("\n"), /Waiting on: T1/);
    assert.equal(f.p.read(f.sm).snapshot?.tasks[1].status, "in_progress");
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
