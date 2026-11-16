import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../pi-extension/subagents/index.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { bindPlanRun } from "../pi-extension/subagents/plan-runtime.ts";
import { PLAN_CONTEXT_TYPE } from "../pi-extension/subagents/plan-context.ts";
import { RECOVERY_CONTEXT_TYPE } from "../pi-extension/subagents/recovery-report.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { pauseDeliveries } from "../pi-extension/subagents/delivery.ts";

test("production hook order retries pending imports before durable publication and compaction fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-publication-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Synthetic parent assignment", timestamp: 1 });
  const custody = sm.appendCustomEntry("subagent-custody", { branchToken: "synthetic-branch" });
  const events = new Map<string, Function[]>(), tools = new Map<string, any>();
  const prior = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  const ctx: any = { sessionManager: sm, hasUI: false, scopedModels: [], modelRegistry: { find() {}, getAvailable() { return []; } } };
  let sends = 0;
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getAllTools() { return []; }, getSettings() { return {}; }, appendEntry(type: string, data: any) { sm.appendCustomEntry(type, data); },
    sendMessage() { sends++; }, sendUserMessage() { assert.fail("imports/publications must not start a turn"); } };
  extension(pi);
  const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
  const emit = async (name: string, event: any = {}) => {
    if (name === "before_agent_start") event.systemPromptOptions ??= { toolGuidelines: {} };
    for (const handler of events.get(name) ?? []) {
      const result: any = await handler(event, ctx);
      if (result?.message) event.publications = [...(event.publications ?? []), result.message];
      if (result?.messages) event.messages = result.messages;
    }
    return event;
  };
  const call = async (command: any, expectedRevision: number) => (await tools.get("plan_update").execute("setup", { command, expectedRevision }, undefined, undefined, ctx)).details;
  let durable: RuntimeStore | undefined;
  try {
    await emit("session_start", { reason: "startup" });
    let plan = await call({ action: "create", title: "Import ordering" }, 0);
    plan = await call({ action: "add", planId: plan.planId, title: "Synthetic worker" }, plan.revision);
    const taskId = plan.tasks[0].taskId;
    plan = await call({ action: "attempt", planId: plan.planId, taskId, mode: "start" }, plan.revision);
    const binding = bindPlanRun(runtime.plans, ctx, "run", { planId: plan.planId, taskId, attemptId: plan.tasks[0].attempts[0].attemptId, expectedRevision: plan.revision });
    durable = new RuntimeStore(join(dir, "runtime"), { sessionFile: canonicalSessionPath(sm.getSessionFile()!), headerId: sm.getSessionId(), checkpoint: custody, branchToken: "synthetic-branch" });
    runtime.store = durable; runtime.delivery.store = durable;
    durable.prepare({ id: "run", name: "Synthetic worker", task: "Verify ordering", sessionFile: join(dir, "child.jsonl"), startTime: 1, planTask: binding });
    const envelope: any = { message: { customType: "subagent_result", content: "Synthetic result", display: true,
      details: { eventId: "event", exitCode: 0, sessionFile: join(dir, "child.jsonl") } }, options: { triggerTurn: true, deliverAs: "steer" } };
    durable.enqueue("event", "run", envelope);
    const original = runtime.plans.mutate.bind(runtime.plans);
    let blocked = true;
    runtime.plans.mutate = (...args: any[]) => { if (blocked) throw new Error("Synthetic temporary storage unavailability"); return original(...args); };
    // Earlier ingestion failed while storage was unavailable; the durable outbox
    // is retained independently of handoff and is the only retry source.
    runtime.delivery.onEnvelope("run", envelope);
    assert.equal(runtime.planImportErrors.size, 1);
    assert.equal(runtime.plans.read(sm).snapshot.revision, 3);
    const failed = await emit("before_agent_start");
    const failure = failed.publications.find((message: any) => message.customType === RECOVERY_CONTEXT_TYPE);
    assert.match(failure.content, /Task import pending/);
    assert.match(failed.publications.find((message: any) => message.customType === PLAN_CONTEXT_TYPE).content, /revision=3/);

    blocked = false;
    const recovered = await emit("before_agent_start");
    const publication = recovered.publications.find((message: any) => message.customType === PLAN_CONTEXT_TYPE);
    assert.match(publication.content, /revision=4/); assert.match(publication.content, /in_review/);
    assert.equal(runtime.planImportErrors.size, 0);
    assert.equal(runtime.plans.read(sm).snapshot.tasks[0].attempts[0].results.length, 1);
    assert.equal(runtime.plans.read(sm).snapshot.tasks[0].status, "in_review", "import is not acceptance");
    const sessionBytes = readFileSync(sm.getSessionFile()!, "utf8");
    const manifestBytes = readFileSync(join(dir, "runtime", "manifest.json"), "utf8");
    const getEvent = durable.getEvent.bind(durable);
    let eventReads = 0;
    durable.getEvent = id => { eventReads++; return getEvent(id); };
    await emit("before_agent_start");
    assert.equal(eventReads, 0, "an empty publication phase never revisits successful historical outbox payloads");
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), sessionBytes, "successful replay appends no duplicate result");
    assert.equal(readFileSync(join(dir, "runtime", "manifest.json"), "utf8"), manifestBytes);
    assert.equal(sends, 0, "import retries do not re-deliver or wake a model");

    // The emergency post-compaction read-only projection also follows imports.
    const second = { ...envelope, message: { ...envelope.message, details: { ...envelope.message.details, eventId: "second-event" } } };
    durable.enqueue("second-event", "run", second);
    sm.appendCompaction("Synthetic retain-none", null, 10000);
    const restored = await emit("context", { messages: sm.buildSessionContext().messages });
    const fallback = restored.messages.find((message: any) => message.role === "custom" && message.customType === PLAN_CONTEXT_TYPE);
    assert.match(fallback.content, /revision=5/); assert.match(fallback.content, /in_review/);
    assert.equal(runtime.plans.read(sm).snapshot.tasks[0].attempts[0].results.length, 2);
    assert.equal(eventReads, 1, "a newly retained event imports only the append-only outbox tail");
    assert.equal(sends, 0);
  } finally {
    pauseDeliveries(runtime.delivery);
    await emit("session_shutdown", { reason: "quit" });
    prior.forEach((value, i) => { const key = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"][i]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    rmSync(dir, { recursive: true, force: true });
  }
});
