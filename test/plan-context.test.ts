import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_CONTEXT_BYTES, PLAN_CONTEXT_TYPE, projectPlanContext, summarizePlan } from "../pi-extension/subagents/plan-context.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "plan-context-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Plan work", timestamp: 1 });
  const p = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
  return { sm, p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("native retain-none compaction, subsequent mutation and branch selection project current state without writes", () => {
  const { sm, p, cleanup } = fixture();
  try {
    let plan = p.create(sm, 0, "Current 日本語 🚀");
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, "Implementation"));
    const oldLeaf = sm.getLeafId()!;
    const previous = projectPlanContext(sm.buildSessionContext().messages, p.read(sm));
    const compactId = sm.appendCompaction("No retained plan details", null, 10000);
    const compact = sm.getEntry(compactId);
    assert.equal(compact?.type, "compaction");
    assert.equal((compact as any).firstKeptEntryId, compactId);
    const native = sm.buildSessionContext().messages;
    assert.ok(native.some(message => message.role === "compactionSummary"));
    assert.ok(!JSON.stringify(native).includes(plan.planId));
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.block(s, c, s.tasks[0].taskId, "Need approval 日本語 🚀"));
    const bytes = readFileSync(sm.getSessionFile()!, "utf8");
    const projected = projectPlanContext(native, p.read(sm));
    const text = String((projected.at(-1) as any).content);
    assert.match(text, new RegExp(`planId=${plan.planId} revision=2`));
    assert.match(text, /blocked.*Need approval 日本語 🚀/);
    assert.match(text, /plan_read/);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), bytes);
    assert.deepEqual(projectPlanContext(projected, p.read(sm)), projected);
    sm.branch(oldLeaf);
    const historical = String((projectPlanContext(previous, p.read(sm)).at(-1) as any).content);
    assert.match(historical, /revision=1/); assert.match(historical, /read-only/); assert.doesNotMatch(historical, /Need approval/);
    sm.resetLeaf();
    const none = projectPlanContext(previous, p.read(sm));
    assert.match(String((none.at(-1) as any).content), /No readable active plan/);
    assert.doesNotMatch(String((none.at(-1) as any).content), new RegExp(plan.planId));
  } finally { cleanup(); }
});

test("projection preserves unrelated messages, bounds Unicode and exposes counts and omitted details", () => {
  const { sm, p, cleanup } = fixture();
  try {
    let plan = p.create(sm, 0, "Unicode 🚀 日本語 ".repeat(250));
    for (let i = 0; i < 40; i++) plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, `Task ${i} 🚀 日本語 `.repeat(200)));
    plan = p.mutate(sm, plan.planId, plan.revision, (s, c) => store.block(s, c, s.tasks[39].taskId, "Approval 🚀 日本語 ".repeat(300)));
    const user: any = { role: "user", content: PLAN_CONTEXT_TYPE, timestamp: 2 };
    const unrelated: any = { role: "custom", customType: "other-extension", content: "Keep 🚀", display: false, timestamp: 3 };
    const sameType: any = { ...unrelated, customType: PLAN_CONTEXT_TYPE };
    const input = [user, unrelated, sameType];
    const copy = structuredClone(input);
    const output = projectPlanContext(input, p.read(sm));
    assert.deepEqual(input, copy); assert.deepEqual(output.slice(0, 3), input);
    assert.equal(output[0], user); assert.equal(output[1], unrelated);
    const text = String((output.at(-1) as any).content);
    assert.ok(Buffer.byteLength(text, "utf8") <= PLAN_CONTEXT_BYTES);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
    assert.doesNotMatch(text, /\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    assert.match(text, /accepted=0\/40/); assert.match(text, /blocked=1/); assert.match(text, /tasks omitted/); assert.match(text, /Details omitted/);
    assert.match(text, new RegExp(plan.tasks[39].taskId));
    assert.equal(projectPlanContext(output, p.read(sm)).length, 4);
    const child = new PlanPersistence(() => { throw new Error("No writes"); }, true);
    assert.match(summarizePlan(child.read(sm)), /read-only/);
    assert.doesNotMatch(summarizePlan(child.read(sm)), /parent-writable/);
    const foreign = { ...p.read(sm), writable: false, detachRequired: "foreign" as const, error: "Foreign inherited plan" };
    assert.match(summarizePlan(foreign), /read-only; foreign copy requires explicit detach/);
  } finally { cleanup(); }
});

test("registered tools and every context call share the actual persistence, with no send/append projection", async () => {
  const { sm, cleanup } = fixture();
  const prior = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  try {
    const events = new Map<string, Function>(); const tools = new Map<string, any>();
    let appends = 0;
    registerPlanTools({
      on: (name, handler) => events.set(name, handler),
      registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
      sendMessage() { assert.fail("Plan projection must not wake the model"); },
      sendUserMessage() { assert.fail("Plan projection must not start a turn"); },
      appendEntry: (type, data) => { appends++; sm.appendCustomEntry(type, data); },
    } as any);
    const ctx = { sessionManager: sm };
    const call = (command: any, expectedRevision: number) => tools.get("plan_update").execute("id", { command, expectedRevision }, undefined, undefined, ctx);
    const first = await call({ action: "create", title: "First" }, 0);
    const before = events.get("context")!({ messages: [] }, ctx);
    assert.match(before.messages.at(-1).content, /revision=0/);
    await call({ action: "add", planId: first.details.planId, title: "Latest" }, 0);
    const after = events.get("context")!({ messages: before.messages }, ctx);
    assert.match(after.messages.at(-1).content, /revision=1/); assert.match(after.messages.at(-1).content, /Latest/);
    assert.equal(after.messages.length, 1); assert.equal(appends, 2);
    assert.equal(events.has("before_agent_start"), false);
    assert.equal(sm.getEntries().filter(entry => entry.type === "custom_message").length, 0);
  } finally {
    for (const [i, name] of ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"].entries()) { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; }
    cleanup();
  }
});
