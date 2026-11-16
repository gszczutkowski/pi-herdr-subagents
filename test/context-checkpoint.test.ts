import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PlanPersistence, PLAN_ENTRY } from "../pi-extension/subagents/plan-persistence.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";
import {
  clipCheckpointText, CONTEXT_CHECKPOINT_BYTES, CONTEXT_CHECKPOINT_CONTEXT_TYPE, CONTEXT_CHECKPOINT_ENTRY,
  CONTEXT_CHECKPOINT_ITEMS, CONTEXT_CHECKPOINT_PLAN_BYTES, CONTEXT_CHECKPOINT_PREFIX, CONTEXT_CHECKPOINT_STATE_BYTES,
  decodeContextCheckpoint, checkpointContext, registerContextCheckpoint, validateCheckpointWorkingState,
  type CheckpointWorkingState, type ContextCheckpointInput,
} from "../pi-extension/subagents/context-checkpoint.ts";

const workingState: CheckpointWorkingState = {
  goal: "Finish checkpoint implementation 日本語 🚀", decisions: ["Use native branch entries"],
  nextSteps: ["Verify retain-none compaction"], verification: ["node --test test/context-checkpoint.test.ts"], refs: ["test/context-checkpoint.test.ts"],
};
function withRole<T>(child: boolean, fn: () => T): T {
  const names = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"] as const;
  const prior = names.map(name => process.env[name]);
  for (const name of names) delete process.env[name];
  if (child) process.env.PI_SUBAGENT_ID = "checkpoint-child";
  try { return fn(); }
  finally { names.forEach((name, i) => { if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i]; }); }
}
function registration(sm: SessionManager, plans: PlanPersistence, child = false, append?: ExtensionAPI["appendEntry"]) {
  const events = new Map<string, Function>();
  const tools = new Map<string, any>();
  let appends = 0;
  const controller = withRole(child, () => registerContextCheckpoint({
    on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
    appendEntry: (type, data) => { appends++; if (append) append(type, data); else sm.appendCustomEntry(type, data); },
    sendMessage() { assert.fail("Checkpoint must never send a model message"); },
    sendUserMessage() { assert.fail("Checkpoint must never start a turn"); },
  } as ExtensionAPI, plans));
  const ctx = { sessionManager: sm } as unknown as ExtensionContext;
  return {
    controller, ctx, events, tools, appends: () => appends,
    invoke: (params: ContextCheckpointInput) => tools.get("context_checkpoint").execute("checkpoint-call", params, undefined, undefined, ctx),
    project: (messages: any[] = sm.buildSessionContext().messages) => previewCheckpoint(messages, controller.read(ctx)),
  };
}
function fixture(conversation = true) {
  const dir = mkdtempSync(join(tmpdir(), "context-checkpoint-"));
  const sm = SessionManager.create(dir, dir);
  if (conversation) sm.appendMessage({ role: "user", content: "RAW_CONVERSATION_MUST_NOT_BE_CAPTURED", timestamp: 1 });
  const plans = new PlanPersistence((type, data) => { sm.appendCustomEntry(type, data); }, false);
  return { dir, sm, plans, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const save = (state: CheckpointWorkingState = workingState): ContextCheckpointInput => ({ action: "save", ...state });
const checkpointText = (messages: any[]) => messages.filter(message => message.role === "custom" && message.customType === CONTEXT_CHECKPOINT_CONTEXT_TYPE).map(message => message.content).join("\n");
// Formatting-only preview for the storage/bounds tests below. Native hook
// ordering, receipt dedup and provider prefixes are tested separately.
function previewCheckpoint(messages: any[], view: Parameters<typeof checkpointContext>[0]) {
  const retained = messages.filter(message => !(message.role === "custom" && message.customType === CONTEXT_CHECKPOINT_CONTEXT_TYPE && message.details?.preview));
  const content = checkpointContext(view);
  return content ? [...retained, { role: "custom", customType: CONTEXT_CHECKPOINT_CONTEXT_TYPE, content, details: { preview: true } }] : retained;
}

test("native retain-none compaction, reopen and extension reload preserve explicit state and plan pointer", async () => {
  const { sm, plans, cleanup } = fixture();
  try {
    const plan = plans.create(sm, 0, "Checkpoint plan");
    const r = registration(sm, plans);
    const saved = await r.invoke(save());
    assert.deepEqual(JSON.parse(saved.content[0].text), { status: "saved", entryId: saved.details.entryId, durable: true });
    assert.ok(Buffer.byteLength(saved.content[0].text) < 200);
    assert.doesNotMatch(saved.content[0].text, /Finish checkpoint|planSummary/);
    assert.match((await r.invoke({ action: "read" })).content[0].text, /Finish checkpoint implementation/);
    assert.deepEqual(saved.details.checkpoint.workingState, workingState);
    assert.equal(saved.details.checkpoint.originSessionId, sm.getSessionId());
    assert.equal(saved.details.checkpoint.reason, "save");
    assert.deepEqual(saved.details.checkpoint.plan, { planId: plan.planId, revision: 0, entryId: sm.getBranch().findLast(e => e.type === "custom" && e.customType === PLAN_ENTRY)!.id });
    const custom = sm.getLeafEntry();
    assert.equal(custom?.type, "custom");
    assert.equal((custom as any).customType, CONTEXT_CHECKPOINT_ENTRY);
    assert.doesNotMatch(JSON.stringify((custom as any).data), /RAW_CONVERSATION_MUST_NOT_BE_CAPTURED/);
    const compactId = sm.appendCompaction("No working state retained", null, 10000);
    assert.equal((sm.getEntry(compactId) as any).firstKeptEntryId, compactId);
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /Finish checkpoint|Checkpoint plan/);
    const bytes = readFileSync(sm.getSessionFile()!, "utf8");
    assert.match(checkpointText(r.project()), /Finish checkpoint implementation 日本語 🚀/);
    assert.doesNotMatch(checkpointText(r.project()), /planSummary|Checkpoint plan/, "working notes do not duplicate the captured plan summary");
    const reopened = SessionManager.open(sm.getSessionFile()!);
    const restoredPlans = new PlanPersistence(() => assert.fail("Read must not mutate plan"), false);
    const reopenedRuntime = registration(reopened, restoredPlans);
    const reload = registration(reopened, restoredPlans);
    assert.deepEqual(reopenedRuntime.controller.read(reopenedRuntime.ctx), r.controller.read(r.ctx));
    assert.deepEqual(reload.controller.read(reload.ctx).checkpoint?.workingState, workingState);
    assert.match(checkpointText(reload.project()), /Finish checkpoint/);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), bytes);
    assert.equal(reload.appends(), 0);
    assert.equal(sm.getEntries().filter(entry => entry.type === "custom_message").length, 0);
  } finally { cleanup(); }
});

test("branch before save restores no checkpoint; abandoned future never leaks into a sibling", async () => {
  const { sm, plans, cleanup } = fixture();
  try {
    const beforeSave = sm.getLeafId()!;
    const r = registration(sm, plans);
    await r.invoke(save({ ...workingState, goal: "ABANDONED_FUTURE" }));
    const savedLeaf = sm.getLeafId()!;
    const previousProjection = r.project([]);
    sm.branch(beforeSave);
    const sibling = sm.appendMessage({ role: "user", content: "Sibling branch", timestamp: 2 });
    // A full-file scan is forbidden, including when there are newer abandoned entries.
    sm.getEntries = () => { throw new Error("Use getBranch only"); };
    assert.equal(r.controller.read(r.ctx).checkpoint, undefined);
    assert.equal(checkpointText(r.project(previousProjection)), "");
    await r.invoke(save({ ...workingState, goal: "SIBLING_ONLY" }));
    const siblingLeaf = sm.getLeafId()!;
    assert.match(checkpointText(r.project(previousProjection)), /SIBLING_ONLY/);
    assert.doesNotMatch(checkpointText(r.project(previousProjection)), /ABANDONED_FUTURE/);
    sm.branch(savedLeaf);
    assert.match(checkpointText(r.project([])), /ABANDONED_FUTURE/);
    assert.doesNotMatch(checkpointText(r.project([])), /SIBLING_ONLY/);
    sm.branch(sibling);
    assert.equal(r.controller.read(r.ctx).checkpoint, undefined);
    sm.branch(siblingLeaf);
    const detachedRead = r.controller.read(r.ctx);
    detachedRead.checkpoint!.workingState!.goal = "Do not mutate native data";
    assert.equal(r.controller.read(r.ctx).checkpoint?.workingState?.goal, "SIBLING_ONLY");
  } finally { cleanup(); }
});

test("all compaction reasons freshly capture plan changes, preserve explicit state and deduplicate proactive/native captures", async () => {
  const { sm, plans, cleanup } = fixture();
  try {
    let plan = plans.create(sm, 0, "Plan for captures");
    const r = registration(sm, plans);
    await r.invoke(save());
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      plan = plans.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, `${reason} task`));
      const result = r.events.get("session_before_compact")!({ reason, branchEntries: [{ raw: "DO_NOT_CAPTURE_EVENT" }] }, r.ctx);
      assert.equal(result, undefined);
      const checkpoint = r.controller.read(r.ctx).checkpoint!;
      assert.equal(checkpoint.reason, reason);
      assert.equal(checkpoint.plan?.revision, plan.revision);
      assert.match(checkpoint.planSummary, new RegExp(`${reason} task`));
      assert.deepEqual(checkpoint.workingState, workingState);
      assert.doesNotMatch(JSON.stringify(checkpoint), /DO_NOT_CAPTURE_EVENT|RAW_CONVERSATION/);
      sm.appendCompaction(`Compacted ${reason}`, null, 1000);
    }
    plan = plans.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, "Proactive change"));
    assert.equal(r.controller.capture(r.ctx, "proactive").status, "saved");
    const count = r.appends();
    const checkpointLeaf = sm.getLeafId();
    assert.equal(r.events.get("session_before_compact")!({ reason: "manual" }, r.ctx), undefined);
    assert.equal(sm.getLeafId(), checkpointLeaf);
    assert.equal(r.controller.capture(r.ctx, "overflow").status, "unchanged");
    assert.equal(r.appends(), count);
    assert.equal(plans.read(sm).snapshot?.revision, plan.revision); // no plan commands or acceptance
    assert.ok(plans.read(sm).snapshot?.tasks.every(task => task.status === "pending"));
    const disk = readFileSync(sm.getSessionFile()!, "utf8");
    for (let i = 0; i < 5; i++) { r.controller.read(r.ctx); await r.invoke({ action: "read" }); r.project(r.project()); }
    assert.equal(r.appends(), count);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), disk);
    assert.equal(r.events.has("before_agent_start"), true);
    assert.deepEqual([...r.events.keys()].sort(), ["before_agent_start", "context", "session_before_compact", "turn_end"]);
  } finally { cleanup(); }
});

test("automatic first capture is plan-only rather than an invented conversation summary", () => {
  const { sm, plans, cleanup } = fixture();
  try {
    const r = registration(sm, plans);
    assert.equal(r.controller.capture(r.ctx, "threshold").status, "saved");
    const checkpoint = r.controller.read(r.ctx).checkpoint!;
    assert.equal(checkpoint.workingState, undefined);
    assert.equal(checkpoint.plan, undefined);
    assert.match(checkpoint.planSummary, /No readable active plan/);
    assert.doesNotMatch(JSON.stringify(checkpoint), /RAW_CONVERSATION/);
    assert.equal(r.controller.capture(r.ctx, "proactive").status, "unchanged");
  } finally { cleanup(); }
});

test("foreign fork remains inherited/read-only through every automatic capture until explicit save", async () => {
  const { dir, sm, plans, cleanup } = fixture();
  try {
    const parent = registration(sm, plans);
    await parent.invoke(save());
    const parentDisk = readFileSync(sm.getSessionFile()!, "utf8");
    const fork = SessionManager.forkFrom(sm.getSessionFile()!, dir, dir);
    const forkPlans = new PlanPersistence(() => assert.fail("No plan mutation"), false);
    const r = registration(fork, forkPlans);
    assert.equal(r.controller.read(r.ctx).inherited, true);
    assert.equal(r.controller.read(r.ctx).writable, false);
    const inheritedDisk = readFileSync(fork.getSessionFile()!, "utf8");
    for (const reason of ["manual", "threshold", "overflow", "proactive"] as const) {
      assert.equal(r.controller.capture(r.ctx, reason).status, "skipped");
      r.events.get("session_before_compact")!({ reason }, r.ctx);
    }
    assert.equal(r.appends(), 0);
    assert.equal(readFileSync(fork.getSessionFile()!, "utf8"), inheritedDisk);
    assert.match(checkpointText(r.project()), /INHERITED, READ-ONLY/);
    assert.match(checkpointText(r.project()), /No authority is transferred/);
    fork.appendCompaction("Inherited state omitted", null, 10000);
    assert.match(checkpointText(r.project()), /INHERITED, READ-ONLY/);
    await r.invoke(save({ ...workingState, goal: "Explicit local fork state" }));
    const local = r.controller.read(r.ctx);
    assert.equal(local.inherited, false); assert.equal(local.writable, true);
    assert.equal(local.checkpoint?.originSessionId, fork.getSessionId());
    assert.equal(local.checkpoint?.workingState?.goal, "Explicit local fork state");
    assert.doesNotMatch(checkpointText(r.project()), /INHERITED/);
    assert.equal(r.controller.capture(r.ctx, "proactive").status, "unchanged");
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), parentDisk);
  } finally { cleanup(); }
});

test("child, no-session and setup-only cannot save/capture, even proactively", async () => {
  const { sm, plans, cleanup } = fixture(false);
  try {
    sm.appendCustomEntry("setup-only", {});
    assert.equal(existsSync(sm.getSessionFile()!), false);
    const setup = registration(sm, plans);
    await assert.rejects(() => setup.invoke(save()), /durable session/);
    assert.equal(setup.controller.capture(setup.ctx, "proactive").status, "skipped");
    const ephemeral = SessionManager.inMemory();
    ephemeral.appendMessage({ role: "user", content: "Not durable", timestamp: 1 });
    const noSession = registration(ephemeral, plans);
    await assert.rejects(() => noSession.invoke(save()), /--no-session/);
    assert.equal(noSession.controller.capture(noSession.ctx, "manual").status, "skipped");
    assert.equal(noSession.appends(), 0);
    sm.appendMessage({ role: "user", content: "Now durable", timestamp: 2 });
    const parent = registration(sm, plans);
    await parent.invoke(save());
    const disk = readFileSync(sm.getSessionFile()!, "utf8");
    const child = registration(sm, plans, true);
    assert.equal(child.tools.has("context_checkpoint"), false); // parent-only exposure
    assert.equal(child.controller.read(child.ctx).writable, false);
    assert.match(child.controller.read(child.ctx).error!, /Child/);
    for (const reason of ["manual", "threshold", "overflow", "proactive"] as const) {
      assert.equal(child.controller.capture(child.ctx, reason).status, "skipped");
      child.events.get("session_before_compact")!({ reason }, child.ctx);
    }
    assert.equal(child.appends(), 0);
    assert.match(checkpointText(child.project()), /READ-ONLY/);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), disk);
  } finally { cleanup(); }
});

test("malformed and unsupported latest schemas fail closed without falling back or overwriting", async () => {
  for (const kind of ["unsupported-type", "unsupported-version", "malformed", "oversized", "bad-unicode"]) {
    const { sm, plans, cleanup } = fixture();
    try {
      const r = registration(sm, plans);
      await r.invoke(save({ ...workingState, goal: "MUST_NOT_FALL_BACK" }));
      const valid = r.controller.read(r.ctx).checkpoint!;
      const validLeaf = sm.getLeafId()!;
      const staleProjection = r.project([]);
      const type = kind === "unsupported-type" ? `${CONTEXT_CHECKPOINT_PREFIX}v99` : CONTEXT_CHECKPOINT_ENTRY;
      const data = kind === "unsupported-version" ? { ...valid, version: 99 } : kind === "malformed" ? { ...valid, workingState: { goal: 42 } } :
        kind === "oversized" ? { ...valid, planSummary: "🚀".repeat(2000) } : kind === "bad-unicode" ? { ...valid, workingState: { ...workingState, goal: "\ud800" } } : valid;
      sm.appendCustomEntry(type, data);
      const disk = readFileSync(sm.getSessionFile()!, "utf8");
      const view = r.controller.read(r.ctx);
      assert.equal(view.checkpoint, undefined, kind);
      assert.equal(view.writable, false, kind);
      assert.match(view.error!, /schema\/version/, kind);
      assert.doesNotMatch(checkpointText(r.project(staleProjection)), /MUST_NOT_FALL_BACK/);
      assert.equal(r.controller.capture(r.ctx, "proactive").status, "skipped");
      await assert.rejects(() => r.invoke(save()), /schema\/version/);
      assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), disk);
      assert.equal(r.appends(), 1);
      sm.branch(validLeaf);
      assert.equal(r.controller.read(r.ctx).checkpoint?.workingState?.goal, "MUST_NOT_FALL_BACK");
    } finally { cleanup(); }
  }
});

test("bounded Unicode state, total JSON escaping budget and replaceable projections preserve unrelated messages", async () => {
  const { sm, plans, cleanup } = fixture();
  try {
    let plan = plans.create(sm, 0, "日本語 🚀 ".repeat(50));
    for (let i = 0; i < 40; i++) plan = plans.mutate(sm, plan.planId, plan.revision, (s, c) => store.addTask(s, c, `Task ${i} ${'"'.repeat(300)} 日本語 🚀`));
    const state: CheckpointWorkingState = {
      ...workingState, goal: "日本語 🚀 ".repeat(40), decisions: Array.from({ length: 8 }, () => '"'.repeat(250)),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= CONTEXT_CHECKPOINT_STATE_BYTES);
    const r = registration(sm, plans);
    await r.invoke(save(state));
    const checkpoint = r.controller.read(r.ctx).checkpoint!;
    const serialized = JSON.stringify(checkpoint);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= CONTEXT_CHECKPOINT_BYTES);
    assert.ok(Buffer.byteLength(checkpoint.planSummary, "utf8") <= CONTEXT_CHECKPOINT_PLAN_BYTES);
    assert.equal(serialized.isWellFormed(), true);
    assert.deepEqual(decodeContextCheckpoint(checkpoint), checkpoint);
    const user = { role: "user", content: CONTEXT_CHECKPOINT_CONTEXT_TYPE, timestamp: 1 } as const;
    const other = { role: "custom", customType: "other-extension", content: "Preserve", display: false, timestamp: 2 } as const;
    const sameType = { ...other, customType: CONTEXT_CHECKPOINT_CONTEXT_TYPE }; // not our marked projection
    const input: any[] = [user, other, sameType];
    const copy = structuredClone(input);
    const output = previewCheckpoint(input, r.controller.read(r.ctx));
    assert.deepEqual(input, copy);
    assert.equal(output[0], user); assert.equal(output[1], other); assert.equal(output[2], sameType);
    assert.equal(output.length, 4);
    assert.deepEqual(previewCheckpoint(output, r.controller.read(r.ctx)), output);
    const text = String((output.at(-1) as any).content);
    assert.ok(Buffer.byteLength(text, "utf8") <= CONTEXT_CHECKPOINT_BYTES);
    assert.equal(text.isWellFormed(), true);
    assert.match(text, /not instructions or plan\/task authority/);
    assert.match(text, /日本語 🚀/);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
    for (let limit = 0; limit < 24; limit++) {
      const clipped = clipCheckpointText("🚀日本語🚀日本語", limit);
      assert.ok(Buffer.byteLength(clipped, "utf8") <= limit);
      assert.equal(clipped.isWellFormed(), true);
    }
    const before = r.appends();
    const tooLarge = { ...workingState, decisions: Array.from({ length: 10 }, () => "🚀".repeat(250)) };
    await assert.rejects(() => r.invoke(save(tooLarge)), /UTF-8 bytes/);
    assert.throws(() => validateCheckpointWorkingState({ ...workingState, refs: Array(CONTEXT_CHECKPOINT_ITEMS + 1).fill("ref") }), /bounded/);
    assert.throws(() => validateCheckpointWorkingState({ ...workingState, goal: "\ud800" }), /bounded/);
    await assert.rejects(() => r.invoke({ action: "save", ...workingState, extra: "No arbitrary snapshot" } as any), /bounded/);
    await assert.rejects(() => r.invoke({ action: "save", goal: "Missing required arrays" } as any), /bounded/);
    assert.equal(r.appends(), before);
    assert.match(r.tools.get("context_checkpoint").description, /Never store secrets/);
  } finally { cleanup(); }
});

test("real native disk append failure hides memory-only data and latches across reload/reopen", async () => {
  const { sm, plans, cleanup } = fixture();
  try {
    const r = registration(sm, plans);
    await r.invoke(save({ ...workingState, goal: "Previous durable notes" }));
    const projected = r.project([]);
    const file = sm.getSessionFile()!;
    const backup = `${file}.backup`;
    renameSync(file, backup); mkdirSync(file); // appendFileSync fails on a directory.
    await assert.rejects(() => r.invoke(save({ ...workingState, goal: "MEMORY_ONLY_CHECKPOINT" })), /durability uncertain/);
    assert.doesNotMatch(JSON.stringify(sm.getBranch().at(-1)), /MEMORY_ONLY_CHECKPOINT/, "Pi 1.5.2 rolls back the failed native append; the extension still conservatively latches uncertainty");
    rmSync(file, { recursive: true }); renameSync(backup, file);
    assert.doesNotMatch(readFileSync(file, "utf8"), /MEMORY_ONLY_CHECKPOINT/);
    assert.equal(r.controller.read(r.ctx).checkpoint, undefined);
    assert.doesNotMatch(checkpointText(r.project(projected)), /Previous durable notes|MEMORY_ONLY_CHECKPOINT/);
    assert.match(checkpointText(r.project(projected)), /durability uncertain/);
    // Re-evaluate the module, not just the controller factory, as /reload does.
    const reimported = await import(new URL(`../pi-extension/subagents/context-checkpoint.ts?reload=${Date.now()}`, import.meta.url).href);
    const moduleReload = withRole(false, () => reimported.registerContextCheckpoint({
      on() {}, registerTool() {}, appendEntry() { assert.fail("Reload must not append"); },
    } as unknown as ExtensionAPI, plans));
    assert.equal(moduleReload.read(r.ctx).checkpoint, undefined);
    assert.equal(moduleReload.capture(r.ctx, "proactive").status, "failed");
    const reloaded = registration(sm, plans);
    assert.equal(reloaded.controller.read(reloaded.ctx).checkpoint, undefined);
    assert.equal(reloaded.controller.capture(reloaded.ctx, "proactive").status, "failed");
    assert.deepEqual(reloaded.events.get("session_before_compact")!({ reason: "manual" }, reloaded.ctx), { cancel: true });
    await assert.rejects(() => reloaded.invoke(save()), /fresh Pi process/);
    const reopened = SessionManager.open(file);
    const resumed = registration(reopened, plans);
    assert.equal(resumed.controller.read(resumed.ctx).checkpoint, undefined); // conservative process-wide latch, no hidden reconciliation writes
    assert.equal(resumed.controller.read(resumed.ctx).writable, false);
    assert.equal(reloaded.appends(), 0); assert.equal(resumed.appends(), 0);
  } finally { cleanup(); }
});

test("automatic append failure cancels native compaction and does not expose error contents", () => {
  const { sm, plans, cleanup } = fixture();
  try {
    const r = registration(sm, plans, false, () => { throw new Error("SECRET_ERROR_CONTENT"); });
    const warnings: string[] = [];
    const ctx = { ...r.ctx, hasUI: true, ui: { notify: (text: string) => warnings.push(text) } } as ExtensionContext;
    assert.deepEqual(r.events.get("session_before_compact")!({ reason: "overflow" }, ctx), { cancel: true });
    assert.equal(r.appends(), 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /durability uncertain/);
    assert.doesNotMatch(checkpointText(r.project()), /SECRET_ERROR_CONTENT/);
    assert.equal(r.controller.read(r.ctx).checkpoint, undefined);
  } finally { cleanup(); }
});

test("actual Pi lifecycle and model-issued checkpoint tool survive native retain-none compaction", async () => {
  const { dir, sm, cleanup } = fixture(false);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const errors: unknown[] = [], projections: string[] = [];
    let requests = 0;
    let plans!: PlanPersistence;
    let controller!: ReturnType<typeof registerContextCheckpoint>;
    let runtimeCtx!: ExtensionContext;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1000 } });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        plans = new PlanPersistence((type, data) => pi.appendEntry(type, data), false);
        controller = withRole(false, () => registerContextCheckpoint(pi, plans));
        pi.on("session_start", (_event, ctx) => { runtimeCtx = ctx; });
        pi.on("context_with_system", event => { projections.push(checkpointText(event.messages)); });
        pi.on("session_before_compact", event => ({
          compaction: { summary: "Retain none; omit checkpoint from summary", firstKeptEntryId: null as any, tokensBefore: event.preparation.tokensBefore },
        }));
        pi.registerProvider("checkpoint-test", {
          baseUrl: "https://example.invalid", apiKey: "test", api: "checkpoint-test-api",
          models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model) {
            const first = requests++ === 0;
            const message: any = {
              role: "assistant", content: first ? [{ type: "toolCall", id: "checkpoint-save", name: "context_checkpoint", arguments: save() }] : [{ type: "text", text: "Checkpoint persisted" }],
              provider: model.provider, model: model.id, api: model.api, stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: sm }));
    const model = session.extensionRunner!.getModelRegistry().find("checkpoint-test", "model");
    assert.ok(model);
    await session.setModel(model);
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.prompt("Save concise working state");
    assert.equal(requests, 2);
    assert.equal(projections[0], "");
    assert.equal(projections[1], "", "the persistent save receipt and its call already carry the replacement notes");
    const plan = plans.create(sm, 0, "Runtime plan pointer");
    assert.equal(controller.capture(runtimeCtx, "proactive").status, "saved");
    const captures = sm.getEntries().filter(entry => entry.type === "custom" && entry.customType === CONTEXT_CHECKPOINT_ENTRY).length;
    await session.compact();
    const compact = sm.getLeafEntry();
    assert.equal(compact?.type, "compaction");
    assert.equal((compact as any).firstKeptEntryId, compact!.id);
    assert.equal(sm.getEntries().filter(entry => entry.type === "custom" && entry.customType === CONTEXT_CHECKPOINT_ENTRY).length, captures);
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /Finish checkpoint implementation/);
    await session.prompt("Continue from the persisted checkpoint");
    assert.equal(requests, 3);
    assert.match(projections[2], /Finish checkpoint implementation/);
    assert.doesNotMatch(projections[2], new RegExp(plan.planId), "no stale duplicate plan summary");
    assert.equal(sm.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === CONTEXT_CHECKPOINT_CONTEXT_TYPE).length, 1);
    assert.deepEqual(errors, []);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    assert.deepEqual(registration(reopened, plans).controller.read({ sessionManager: reopened } as ExtensionContext).checkpoint?.workingState, workingState);
  } finally { session?.dispose(); cleanup(); }
});
