import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_ENTRY, PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { preparePlanRead, type PlanRead } from "../pi-extension/subagents/plan-read.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

const roles = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"] as const;
const saved = roles.map(name => process.env[name]);
before(() => roles.forEach(name => { delete process.env[name]; }));
after(() => roles.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));

function largePlan(sessionId: string): store.PlanSnapshot {
  const initial = store.createPlan("Large plan", { sessionId, branchInstanceId: randomUUID() });
  const criterion = store.createCriterion("Parent checked");
  const plan: any = structuredClone(store.addTask(initial, { ...initial.authority, expectedRevision: 0 }, "Large task", { criteria: [criterion] }));
  const task = plan.tasks[0];
  const text = "Verified 日本語 🚀 ".repeat(50);
  task.criteria.push(...Array.from({ length: 9 }, () => store.createCriterion(text)));
  task.artifacts = Array.from({ length: 20 }, () => ({ artifactId: randomUUID(), ref: text }));
  task.attempts = Array.from({ length: 2 }, (_, attempt) => ({ attemptId: randomUUID(), runIds: [`run-${attempt}`],
    origin: { planId: plan.planId, authority: plan.authority }, results: Array.from({ length: 120 }, (_, i) => ({
      eventId: `event-${attempt}-${i}`, runId: `run-${attempt}`, ref: `${i}: ${text}`, kind: "result",
    })) }));
  task.evidence = Array.from({ length: 120 }, (_, i) => ({ evidenceId: randomUUID(), criterionId: criterion.criterionId,
    ref: `${i}: ${text}`, resultEventId: `event-0-${i}` }));
  task.statusHistory.push({ revision: 2, status: "in_progress", reason: "Started" },
    { revision: 3, status: "in_review", reason: "Result" }, { revision: 4, status: "in_progress", reason: "Retry" },
    { revision: 5, status: "in_review", reason: "Result" });
  for (let i = 0; i < 60; i++) {
    const revision = 6 + i;
    const accept = i % 2 === 0;
    const reason = `${i}: ${text}`;
    task.decisions.push({ revision, kind: accept ? "accept" : "invalidate", reason,
      criteria: accept ? { [criterion.criterionId]: [task.evidence[0].evidenceId] } : {} });
    task.statusHistory.push({ revision, status: accept ? "accepted" : "in_review", reason });
  }
  task.status = "in_review";
  task.statusReason = task.statusHistory.at(-1).reason;
  plan.revision = task.statusHistory.at(-1).revision;
  return store.deserializePlan(JSON.stringify(plan));
}

function fixture(large = true) {
  const dir = mkdtempSync(join(tmpdir(), "plan-read-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Synthetic plan", timestamp: 1 });
  const plan = large ? largePlan(sm.getSessionId()) : store.createPlan("Small plan", { sessionId: sm.getSessionId(), branchInstanceId: randomUUID() });
  sm.appendCustomEntry(PLAN_ENTRY, plan);
  const tools = new Map<string, any>();
  const persistence = registerPlanTools({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {},
    appendEntry: (type: string, data: any) => sm.appendCustomEntry(type, data) } as any, { publish: false });
  const ctx = { sessionManager: sm, hasUI: false };
  const read = async (params: any = {}) => {
    const result = await tools.get("plan_read").execute("read", params, undefined, undefined, ctx);
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 40000, "UTF-8 byte bound");
    assert.ok(text.split("\n").length <= 2000, "line bound");
    return { data: JSON.parse(text), details: result.details };
  };
  return { dir, sm, ctx, persistence, tools, plan, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const stateReceipts = (details: any) => details.contextReceipt?.states ?? [];

test("large task sections exhaustively enumerate results, evidence and decisions, without writes or hidden full snapshots", async () => {
  const f = fixture();
  try {
    const original = readFileSync(f.sm.getSessionFile()!, "utf8");
    const task = f.plan.tasks[0];
    const first = await f.read({ taskId: task.taskId });
    assert.equal(first.data.partial, true);
    assert.ok(first.data.sections.some((item: any) => item.section === "results"));
    assert.equal(first.details.snapshot, undefined);
    const expected: Record<string, readonly unknown[]> = { results: task.attempts.flatMap(attempt => attempt.results.map(result => ({ attemptId: attempt.attemptId, ...result }))),
      evidence: task.evidence, decisions: task.decisions, criteria: task.criteria, artifacts: task.artifacts, dependencies: task.dependencies,
      statusHistory: task.statusHistory, attempts: task.attempts.map(({ results, runIds, ...attempt }) => ({ ...attempt, runCount: runIds.length, resultCount: results.length })),
      runs: task.attempts.flatMap(attempt => attempt.runIds.map(runId => ({ attemptId: attempt.attemptId, runId }))) };
    for (const [section, all] of Object.entries(expected)) {
      let params: any = { taskId: task.taskId, section, limit: 100 };
      const collected: unknown[] = [];
      do {
        const { data, details } = await f.read(params);
        assert.equal(data.offset, collected.length);
        assert.equal(data.total, all.length);
        assert.deepEqual(stateReceipts(details), [], "partial collection cannot certify the whole plan context");
        assert.equal(details.snapshot, undefined);
        collected.push(...data.items);
        params = data.next;
        if (params) {
          assert.equal(params.planId, f.plan.planId);
          assert.equal(params.expectedRevision, f.plan.revision);
          assert.ok(data.returned > 0, "cursor must make progress");
        }
      } while (params);
      assert.deepEqual(collected, all, section);
    }
    assert.equal(readFileSync(f.sm.getSessionFile()!, "utf8"), original);
  } finally { f.cleanup(); }
});

test("default small reads preserve snapshot details and context receipts; explicit pages remain partial", async () => {
  const f = fixture(false);
  try {
    const read = await f.read();
    assert.deepEqual(read.data.snapshot, f.plan);
    assert.equal(read.data.partial, undefined);
    assert.equal(stateReceipts(read.details).length, 1);
    const page = await f.read({ section: "tasks" });
    assert.equal(page.data.returned, 0);
    assert.deepEqual(stateReceipts(page.details), []);
    const plan = f.persistence.mutate(f.sm, f.plan.planId, f.plan.revision, (p, c) => store.addTask(p, c, "Small task"));
    const task = await f.read({ taskId: plan.tasks[0].taskId });
    assert.deepEqual(task.data.snapshot.tasks, plan.tasks);
    assert.deepEqual(stateReceipts(task.details), []);
  } finally { f.cleanup(); }
});

test("task overview exceeding the line bound provides navigable task pages instead of truncated JSON", async () => {
  const f = fixture(false);
  try {
    const one = store.addTask(f.plan, { ...f.plan.authority, expectedRevision: 0 }, "Task").tasks[0];
    const plan = store.deserializePlan(JSON.stringify({ ...f.plan, revision: 1,
      tasks: Array.from({ length: 400 }, (_, i) => ({ ...one, taskId: randomUUID(), title: `Task ${i}` })) }));
    f.sm.appendCustomEntry(PLAN_ENTRY, plan);
    const first = await f.read();
    assert.equal(first.data.partial, true);
    let next = first.data.sections[0].read;
    const ids: string[] = [];
    while (next) {
      const { data } = await f.read(next);
      ids.push(...data.items.map((item: any) => item.taskId));
      next = data.next;
    }
    assert.deepEqual(ids, plan.tasks.map(task => task.taskId));
  } finally { f.cleanup(); }
});

test("oversized individual decisions are recoverable exactly through bounded Unicode JSON fragments", async () => {
  const plan: any = structuredClone(largePlan("synthetic-parent"));
  const task = plan.tasks[0];
  const criterionId = task.criteria[0].criterionId;
  task.evidence = Array.from({ length: 600 }, () => ({ evidenceId: randomUUID(), criterionId, ref: "Proof" }));
  task.decisions[0].criteria = { [criterionId]: task.evidence.map((item: any) => item.evidenceId) };
  task.decisions[0].reason = "日本語🚀".repeat(1300);
  task.statusHistory.find((item: any) => item.revision === task.decisions[0].revision).reason = task.decisions[0].reason;
  // Other historical decisions still reference actual evidence after replacement.
  for (const decision of task.decisions.slice(1)) if (decision.kind === "accept") decision.criteria = { [criterionId]: [task.evidence[0].evidenceId] };
  const snapshot = store.deserializePlan(JSON.stringify(plan));
  const view = { snapshot, writable: false, detachRequired: "foreign" as const, error: "Foreign inherited plan is read-only", recoveryUncertain: [task.taskId] };
  const first = preparePlanRead(view, { taskId: task.taskId, section: "decisions", limit: 100 }).data as any;
  assert.equal(first.oversizedItem, true);
  assert.equal(first.returned, 0);
  assert.equal(first.next, null);
  assert.equal(first.writable, false);
  assert.equal(first.recoveryUncertainCount, 1);
  let params = { ...first.jsonRead, limit: 8192 };
  let json = "";
  while (params) {
    const { data } = preparePlanRead(view, params);
    const encoded = JSON.stringify(data, null, 2);
    assert.ok(Buffer.byteLength(encoded) <= 40000);
    assert.ok(encoded.split("\n").length <= 2000);
    assert.equal(data.offset, json.length);
    json += data.jsonText;
    params = data.next;
  }
  const restored = JSON.parse(json);
  assert.deepEqual(restored, view);
  assert.deepEqual(restored.snapshot.authority, snapshot.authority);
  assert.deepEqual(restored.snapshot.tasks[0].decisions[0], task.decisions[0]);
});

test("collection and JSON cursors reject stale revisions or plan identities before returning mixed pages", async () => {
  const f = fixture();
  try {
    const taskId = f.plan.tasks[0].taskId;
    const first = await f.read({ taskId, section: "results", limit: 1 });
    const json = await f.read({ taskId, section: "json", limit: 20 });
    f.persistence.mutate(f.sm, f.plan.planId, f.plan.revision, (p, c) => store.editTask(p, c, taskId, { title: "Changed" }));
    await assert.rejects(() => f.read(first.data.next), /Plan changed/);
    await assert.rejects(() => f.read(json.data.next), /Plan changed/);
    await assert.rejects(() => f.read({ section: "tasks", planId: randomUUID(), expectedRevision: f.plan.revision + 1 }), /Plan changed/);
    assert.equal((await f.read({ taskId })).data.partial, true);
  } finally { f.cleanup(); }
});

test("JSON cursors pin diagnostics as well as the snapshot across restore at an unchanged revision", async () => {
  const f = fixture(false);
  try {
    let plan = f.persistence.mutate(f.sm, f.plan.planId, f.plan.revision, (p, c) => store.addTask(p, c, "Running"));
    plan = f.persistence.mutate(f.sm, plan.planId, plan.revision, (p, c) => store.startAttempt(p, c, p.tasks[0].taskId));
    const first = await f.read({ section: "json", limit: 100 });
    assert.match(first.data.documentHash, /^[0-9a-f]{64}$/);
    assert.equal(first.data.next.documentHash, first.data.documentHash);
    assert.deepEqual(f.persistence.read(f.sm).recoveryUncertain, []);
    f.persistence.restore(f.sm);
    assert.equal(f.persistence.read(f.sm).snapshot?.revision, plan.revision);
    assert.deepEqual(f.persistence.read(f.sm).recoveryUncertain, [plan.tasks[0].taskId]);
    await assert.rejects(() => f.read(first.data.next), /Read document changed/);
    await assert.rejects(() => f.read({ section: "json", offset: 100 }), /documentHash/);
    let params: any = { section: "json", limit: 100 };
    let json = "";
    while (params) {
      const { data } = await f.read(params);
      json += data.jsonText;
      params = data.next;
    }
    assert.deepEqual(JSON.parse(json), f.persistence.read(f.sm));
    assert.deepEqual(JSON.parse(json).snapshot, plan);
  } finally { f.cleanup(); }
});

test("read parameters, section relationships and offsets are validated", async () => {
  const f = fixture();
  try {
    const taskId = f.plan.tasks[0].taskId;
    for (const params of [{ section: "bogus" }, { offset: -1 }, { section: "tasks", offset: 0.5 }, { section: "tasks", limit: 0 },
      { section: "tasks", limit: 101 }, { section: "json", limit: 8193 }, { taskId, section: "tasks" }, { section: "evidence" },
      { offset: 0 }, { limit: 1 }, { planId: f.plan.planId }, { expectedRevision: f.plan.revision },
      { taskId: randomUUID() }, { section: "tasks", offset: 2 }, { taskId, section: "json", offset: Number.MAX_SAFE_INTEGER },
      { section: "tasks", documentHash: "a".repeat(64) }, { section: "json", documentHash: "invalid" },
      { section: "json", documentHash: "a".repeat(64) }, { unknown: true }]) {
      await assert.rejects(() => f.read(params), /bounded|requires|require|accept|limit|Unknown|offset/i, JSON.stringify(params));
    }
    const end = await f.read({ section: "tasks", offset: 1 });
    assert.deepEqual(end.data.items, []);
    assert.equal(end.data.next, null);
    f.sm.resetLeaf();
    const empty = await f.read();
    assert.equal(empty.data.snapshot, undefined);
    await assert.rejects(() => f.read({ section: "tasks" }), /No active plan/);
  } finally { f.cleanup(); }
});

test("native Pi model-issued section cursors pass schema validation and return exact result messages", { timeout: 20000 }, async () => {
  const f = fixture();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const expected = f.plan.tasks[0].attempts.flatMap(attempt => attempt.results.map(result => ({ attemptId: attempt.attemptId, ...result })));
    const received: unknown[] = [];
    const errors: unknown[] = [];
    let requests = 0;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: f.dir, settingsManager,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => {
        registerPlanTools(pi, { publish: false });
        pi.registerProvider("plan-read-test", { baseUrl: "https://example.invalid", apiKey: "synthetic", api: "plan-read-test-api",
          models: [{ id: "model", name: "Read test", reasoning: false, input: ["text"], contextWindow: 1000000, maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context) {
            const last = context.messages.findLast(item => item.role === "toolResult");
            let next: PlanRead | null = { taskId: f.plan.tasks[0].taskId, section: "results", limit: 100 };
            if (last?.role === "toolResult") {
              assert.equal(last.isError, false);
              const page = JSON.parse(last.content.filter(item => item.type === "text").map(item => item.text).join(""));
              received.push(...page.items);
              next = page.next;
            }
            requests++;
            const message: any = { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
              content: next ? [{ type: "toolCall", id: `read-${requests}`, name: "plan_read", arguments: next }] : [{ type: "text", text: "All result messages verified" }],
              stopReason: next ? "toolUse" : "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: f.dir, agentDir: f.dir, sessionManager: f.sm, settingsManager, resourceLoader: loader }));
    await session.setModel(session.extensionRunner!.getModelRegistry().find("plan-read-test", "model")!);
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.prompt("Read all result messages through pages");
    assert.deepEqual(errors, []);
    assert.deepEqual(received, expected);
    assert.ok(requests > 3);
    assert.equal(session.getLastAssistantText(), "All result messages verified");
    assert.deepEqual(new PlanPersistence(() => {}, false).read(f.sm).snapshot, f.plan);
  } finally { session?.dispose(); f.cleanup(); }
});
