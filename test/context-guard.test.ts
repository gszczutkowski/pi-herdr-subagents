import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerContextGuard, prepareGuardCompaction } from "../pi-extension/subagents/context-guard.ts";
import { contextBudgets, DEFAULT_CONTEXT_PROTECTION, parseContextProtection } from "../pi-extension/subagents/context-policy.ts";

const roleNames = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"] as const;
const savedRole = roleNames.map(name => process.env[name]);
before(() => { for (const name of roleNames) delete process.env[name]; });
after(() => roleNames.forEach((name, index) => { if (savedRole[index] === undefined) delete process.env[name]; else process.env[name] = savedRole[index]; }));

const usage = (tokens = 0) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const model: any = { provider: "guard-test", id: "model", api: "guard-test-api", contextWindow: 128000, maxTokens: 1000 };
const assistant = (text: string, tokens = 0): any => ({ role: "assistant", content: [{ type: "text", text }],
  provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: Date.now(), usage: usage(tokens) });

function fixture(hostSettings: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "context-guard-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Earlier goal " + "history ".repeat(5000), timestamp: 1 });
  sm.appendMessage(assistant("Earlier verified work"));
  sm.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
  const latest = sm.appendMessage(assistant("Latest tool batch", 100000));
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let calls = 0; let captures = 0; let manual = 0;
  let tokens: number | null = 100000;
  const ctx: any = { model, sessionManager: sm, hasUI: false, isIdle: () => true, getContextUsage: () => ({ tokens, contextWindow: model.contextWindow }),
    modelRegistry: { complete: () => assert.fail("summary must use public routed streamSimple"),
      streamSimple: () => ({ result: async () => { calls++; return assistant("Summary of earlier goal and verified work"); } }) },
    compact: ({ onComplete }: any) => { manual++; onComplete({}); } };
  const pi: any = { on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (name: string, value: any) => commands.set(name, value),
    getSettings: () => hostSettings, sendMessage() { assert.fail("must not send messages"); }, sendUserMessage() { assert.fail("must not wake model"); } };
  const config = { ...DEFAULT_CONTEXT_PROTECTION, keepRecentTokens: 500 };
  registerContextGuard(pi, config, () => {
    captures++; sm.appendCustomEntry("checkpoint-test", { saved: true });
    return { status: "saved", view: { inherited: false, writable: true } };
  });
  const event = () => ({ outcome: "completed", message: assistant("Latest"), entries: [], context: { contextEntries: sm.buildSessionProjection().entries } });
  return { ctx, sm, pi, handlers, commands, config, latest, event, calls: () => calls, captures: () => captures, manual: () => manual,
    tokens: (value: number | null) => { tokens = value; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("shared budgets validate configuration and scale across small and large model windows", () => {
  assert.deepEqual(parseContextProtection(undefined), DEFAULT_CONTEXT_PROTECTION);
  for (const raw of [null, [], { enabled: "yes" }, { reserveTokens: NaN }, { reserveTokens: -1 }, { reservePercent: 41 }, { maxReportBytes: 12 }, { bogus: true }]) {
    assert.throws(() => parseContextProtection(raw), /contextProtection/);
  }
  const c = { ...DEFAULT_CONTEXT_PROTECTION };
  assert.deepEqual(contextBudgets(128000, c), { reserveTokens: 50000, thresholdTokens: 78000, keepRecentTokens: 20000 });
  assert.equal(contextBudgets(1000000, c)!.reserveTokens, 200000);
  const small = contextBudgets(33000, c)!;
  assert.equal(small.reserveTokens, 13200);
  assert.ok(small.keepRecentTokens <= small.thresholdTokens / 2);
  for (const value of [0, -1, Infinity, NaN]) assert.equal(contextBudgets(value, c), undefined);
});

test("boundary compaction checkpoints first, returns native drafts without manual abort or extra continuation", async () => {
  const f = fixture();
  try {
    const existing = { type: "custom", customType: "another-extension", data: { keep: true } };
    const e = { ...f.event(), entries: [existing], continue: true };
    const result = await f.handlers.get("turn_end")!(e, f.ctx);
    assert.equal(f.calls(), 1); assert.equal(f.manual(), 0); assert.equal(f.captures(), 1);
    assert.deepEqual(result.entries[0], existing);
    assert.equal(result.continue, undefined, "never schedules another response");
    const draft = result.entries.at(-1);
    assert.equal(draft.type, "compaction");
    f.sm.appendCompaction(draft.summary, draft.firstKeptEntryId, 100000, draft.details, true, draft.usage);
    assert.ok(f.sm.buildSessionContext().messages.some(message => message.role === "compactionSummary"));
    assert.ok(f.sm.getBranch().some(entry => entry.type === "custom" && entry.customType === "checkpoint-test"));
    assert.ok(f.sm.buildSessionContext().messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes("Latest tool batch")));
    f.tokens(null);
    await f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(f.calls(), 1, "unknown post-compaction usage must not retrigger");
  } finally { f.cleanup(); }
});

test("no proactive compaction when disabled, usage unknown, aborted, or already compacted by another extension", async () => {
  for (const setup of ["host-off", "config-off", "unknown", "aborted", "existing", "under-threshold"] as const) {
    const f = fixture(setup === "host-off" ? { compaction: { enabled: false } } : {});
    try {
      if (setup === "config-off") f.config.enabled = false;
      if (setup === "unknown") f.tokens(null);
      if (setup === "under-threshold") f.tokens(1000);
      const event = f.event();
      if (setup === "aborted") event.outcome = "aborted";
      if (setup === "existing") (event.entries as any[]).push({ type: "compaction" });
      assert.equal(await f.handlers.get("turn_end")!(event, f.ctx), undefined);
      assert.equal(f.calls(), 0); assert.equal(f.captures(), 0);
    } finally { f.cleanup(); }
  }
});

test("matching native model override selects the smaller retention budget", async () => {
  const f = fixture({ compaction: { keepRecentTokens: 500, modelOverrides: { "guard-test/model": { keepRecentTokens: 0 } } } });
  try {
    const result = await f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(result.entries.at(-1).firstKeptEntryId, f.latest);
    assert.equal(f.manual(), 0);
  } finally { f.cleanup(); }
});

test("failed/length summaries preserve history with a bounded cooldown and explicit retry", async () => {
  const f = fixture();
  try {
    let attempts = 0;
    f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { attempts++; return { ...assistant("Partial"), stopReason: "length" }; } });
    const before = f.sm.buildSessionContext().messages;
    await f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(attempts, 1);
    for (let i = 0; i < 2; i++) await f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(attempts, 1);
    await f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(attempts, 2);
    await f.commands.get("context-guard").handler("retry", f.ctx);
    await f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(attempts, 3);
    assert.deepEqual(f.sm.buildSessionContext().messages, before, "failed summary only appends model-invisible checkpoints");
  } finally { f.cleanup(); }
});

test("input uses native compaction only while idle; stale lifecycle and changed-branch completions are discarded", async () => {
  const f = fixture();
  try {
    f.ctx.isIdle = () => false;
    await f.handlers.get("input")!({}, f.ctx);
    assert.equal(f.manual(), 0);
    f.ctx.isIdle = () => true;
    await f.handlers.get("input")!({}, f.ctx);
    assert.equal(f.manual(), 1);
    for (const change of ["session_shutdown", "session_tree", "model_select", "branch"] as const) {
      let resolve!: (response: any) => void;
      f.ctx.modelRegistry.streamSimple = () => ({ result: () => new Promise(done => { resolve = done; }) });
      const promise = f.handlers.get("turn_end")!(f.event(), f.ctx);
      if (change === "branch") f.sm.appendMessage({ role: "user", content: "New input", timestamp: 3 });
      else f.handlers.get(change)!({}, f.ctx);
      resolve(assistant("Stale summary"));
      assert.equal(await promise, undefined);
    }
  } finally { f.cleanup(); }
});

test("cut selection uses edited context and preserves the latest assistant with oversized tool results", () => {
  const f = fixture();
  try {
    f.sm.appendContextEdit(f.sm.getBranch()[0].id, { content: "Edited earlier goal" });
    f.sm.appendMessage({ ...assistant(""), content: [{ type: "toolCall", id: "tool1", name: "probe", arguments: {} }] });
    const call = f.sm.getLeafId();
    f.sm.appendMessage({ role: "toolResult", toolCallId: "tool1", toolName: "probe", content: [{ type: "text", text: "large output ".repeat(2000) }], isError: false, timestamp: 4 });
    const prepared = prepareGuardCompaction(f.sm.buildSessionProjection().entries, 100)!;
    assert.equal(prepared.firstKeptEntryId, call);
    assert.match(JSON.stringify(prepared.messages), /Edited earlier goal/);
    assert.doesNotMatch(JSON.stringify(prepared.messages), /history history/);
  } finally { f.cleanup(); }
});

test("length stops, failed checkpoints and ineffective summaries cannot replace history", async () => {
  const f = fixture();
  try {
    const length = { ...f.event(), message: { ...assistant("Partial"), stopReason: "length" } };
    assert.equal(await f.handlers.get("turn_end")!(length, f.ctx), undefined);
    assert.equal(f.calls(), 0);
    f.ctx.modelRegistry.streamSimple = () => ({ result: async () => assistant("Oversized summary ".repeat(5000)) });
    assert.equal(await f.handlers.get("turn_end")!(f.event(), f.ctx), undefined);
    assert.equal(f.sm.getBranch().filter(entry => entry.type === "compaction").length, 0);
    registerContextGuard(f.pi, f.config, () => ({ status: "failed", view: { inherited: false, writable: false, error: "Checkpoint append failed" } }));
    let summaryCalls = 0;
    f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { summaryCalls++; return assistant("Must not be requested"); } });
    assert.equal(await f.handlers.get("turn_end")!(f.event(), f.ctx), undefined);
    assert.equal(summaryCalls, 0);
    await f.commands.get("context-guard").handler("retry", f.ctx);
    await f.handlers.get("input")!({}, f.ctx);
    assert.equal(f.manual(), 0);
  } finally { f.cleanup(); }
});

test("cancelled idle compaction cancels pending submission; resets cancel outstanding summary requests", async () => {
  const f = fixture();
  try {
    f.ctx.compact = ({ onError }: any) => onError(new Error("Compaction cancelled"));
    assert.deepEqual(await f.handlers.get("input")!({}, f.ctx), { action: "handled" });
    let complete!: (response: any) => void;
    let signal!: AbortSignal;
    f.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) => {
      signal = options.signal;
      return { result: () => new Promise(resolve => { complete = resolve; }) };
    };
    const pending = f.handlers.get("turn_end")!(f.event(), f.ctx);
    assert.equal(signal.aborted, false);
    f.handlers.get("session_shutdown")!({}, f.ctx);
    assert.equal(signal.aborted, true);
    complete(assistant("Stale response"));
    assert.equal(await pending, undefined);
  } finally { f.cleanup(); }
});

test("effective usage limits drive idle, turn and command budgets instead of virtual declarations", async () => {
  for (const declared of [0, 1000000]) {
    const f = fixture();
    try {
      f.ctx.model = { ...model, contextWindow: declared, maxTokens: 0 };
      f.ctx.getContextUsage = () => ({ tokens: 30000, contextWindow: 33000 });
      let budget = 0;
      f.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) => {
        budget = options.maxTokens;
        return { result: async () => assistant("Summary") };
      };
      const result = await f.handlers.get("turn_end")!(f.event(), f.ctx);
      assert.equal(result.entries.at(-1).type, "compaction");
      assert.equal(budget, 3300, "unknown virtual maxTokens must not produce a zero output budget");
      await f.handlers.get("input")!({}, f.ctx);
      assert.equal(f.manual(), 1);
      const notices: string[] = [];
      f.ctx.hasUI = true;
      f.ctx.ui = { notify: (message: string) => notices.push(message) };
      await f.commands.get("context-guard").handler("", f.ctx);
      assert.match(notices[0], /threshold=19800; reserve=13200/);
    } finally { f.cleanup(); }
  }
  for (const effective of [0, 1000000]) {
    const f = fixture();
    try {
      f.ctx.model = { ...model, contextWindow: 33000 };
      f.ctx.getContextUsage = () => ({ tokens: 100000, contextWindow: effective });
      assert.equal(await f.handlers.get("turn_end")!(f.event(), f.ctx), undefined);
      await f.handlers.get("input")!({}, f.ctx);
      assert.equal(f.captures(), 0);
      assert.equal(f.manual(), 0, "unknown or large effective window must not use a stale smaller selection");
    } finally { f.cleanup(); }
  }
});

for (const selection of ["physical", "virtual-unknown", "virtual-larger", "virtual-smaller"] as const) {
  test(`actual Pi tool scheduler compacts through routed summary without aborting: ${selection}`, { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-guard-native-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Earlier goal " + "history ".repeat(5000), timestamp: 1 });
  sm.appendMessage(assistant("Earlier verified work"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    let normalRequests = 0; let summaries = 0; let probes = 0; let captures = 0;
    const routes: string[] = [];
    const summaryBudgets: number[] = [];
    const errors: unknown[] = [];
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 500 } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => {
        registerContextGuard(pi, { ...DEFAULT_CONTEXT_PROTECTION, keepRecentTokens: 500 }, () => {
          captures++; pi.appendEntry("checkpoint-test", { saved: true });
          return { status: "saved", view: { inherited: false, writable: true } };
        });
        pi.registerTool({ name: "probe", label: "Probe", description: "Controlled test", parameters: { type: "object", properties: {} } as any,
          async execute() { probes++; return { content: [{ type: "text", text: "Verified output" }], details: {} }; } });
        pi.registerProvider("guard-test", { baseUrl: "https://example.invalid", apiKey: "test", api: "guard-test-api",
          models: [model.id, "summary"].map(id => ({ id, name: "Guard test", input: ["text"], reasoning: false, contextWindow: model.contextWindow,
            maxTokens: id === "summary" ? 512 : model.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
          streamSimple(dispatched, context, options) {
            const summaryRequest = JSON.stringify(context.messages).includes("Summarize this earlier conversation");
            let message: any;
            if (summaryRequest) {
              summaries++;
              summaryBudgets.push(options!.maxTokens!);
              assert.equal(dispatched.id, selection === "physical" ? model.id : "summary");
              message = { ...assistant("Summary preserving earlier goal"), model: dispatched.id };
            }
            else if (normalRequests++ === 0) message = { ...assistant("", 100000), stopReason: "toolUse",
              content: [{ type: "toolCall", id: "probe1", name: "probe", arguments: {} }] };
            else message = assistant("Finished after compaction", 1000);
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
            return stream;
          },
        });
        if (selection !== "physical") pi.registerVirtualModel({
          provider: "guard-router", id: "auto", name: "Guard virtual router",
          ...(selection === "virtual-larger" ? { contextWindow: 1000000, maxTokens: 100000 } :
            selection === "virtual-smaller" ? { contextWindow: 33000, maxTokens: 2000 } : {}),
          route(request, ctx) {
            routes.push(request.reason);
            return { model: ctx.modelRegistry.find(model.provider, request.reason === "direct" ? "summary" : model.id)!, thinkingLevel: "off" };
          },
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: sm }));
    const registry = session.extensionRunner!.getModelRegistry();
    const selected = selection === "physical" ? registry.find(model.provider, model.id)! : registry.find("guard-router", "auto")!;
    await session.setModel(selected);
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.prompt("Continue with the probe and finish");
    assert.deepEqual(errors, []);
    assert.equal(probes, 1); assert.equal(normalRequests, 2); assert.equal(summaries, 1); assert.equal(captures, 1);
    assert.deepEqual(summaryBudgets, [selection === "physical" ? 1000 : 512]);
    if (selection !== "physical") {
      assert.deepEqual(routes, ["user", "direct", "continuation"]);
      assert.equal(session.model!.provider, "guard-router", "summary routing cannot replace the selected virtual model");
      assert.equal(session.getContextUsage()!.contextWindow, model.contextWindow);
    }
    assert.equal(session.getLastAssistantText(), "Finished after compaction");
    assert.equal(sm.getBranch().filter(entry => entry.type === "compaction").length, 1);
    assert.ok(SessionManager.open(sm.getSessionFile()!).getBranch().some(entry => entry.type === "compaction"));
  } finally { session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
}
