import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { registerContextCheckpoint } from "../pi-extension/subagents/context-checkpoint.ts";
import { contextReceipt, publicationState, registerContextPublication } from "../pi-extension/subagents/context-publication.ts";
import { registerRecoveryReport, type RecoveryView } from "../pi-extension/subagents/recovery-report.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";

// Explicit opt-in matrix runner, never production resolution via a user's global
// installation. With no override this uses only the locked repository packages.
const hostUrl = process.env.PI_CONTEXT_TEST_HOST_ROOT ? pathToFileURL(join(process.env.PI_CONTEXT_TEST_HOST_ROOT, "dist/index.js")).href :
  import.meta.resolve("@earendil-works/pi-coding-agent");
const host = await import(hostUrl);
const aiUrl = process.env.PI_CONTEXT_TEST_HOST_ROOT ? new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", hostUrl).href :
  import.meta.resolve("@earendil-works/pi-ai");
const ai = await import(aiUrl);
const codexUrl = new URL("api/openai-codex-responses.js", aiUrl);
const codex = await import(codexUrl.href);
const aiVersion = JSON.parse(readFileSync(new URL("../package.json", aiUrl), "utf8")).version;
assert.match(aiVersion, /^1\.(3|5)\./, "internal selector fixture is explicitly versioned to Pi 1.3.x/1.5.x");

// Test-only access to the actual pure delta selector; no copied approximation
// and no exports, private fields, globals, or patches added to production Pi.
const source = readFileSync(codexUrl, "utf8");
const selectorSource = source.slice(source.indexOf("function requestBodyWithoutInput("), source.indexOf("async function* startWebSocketOutputOnFirstEvent("));
assert.ok(selectorSource.includes("function getCachedWebSocketInputDelta("));
const selectTransport = new Function(`${selectorSource}; return { delta: getCachedWebSocketInputDelta, body: buildCachedWebSocketRequestBody };`)();
const token = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64")}.signature`;
const serializerModel: any = { id: "gpt-5.1-codex", name: "Synthetic", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function serialize(messages: any[]) {
  let body: any;
  // onPayload runs after native serialization and before any transport setup.
  // Always throw here: no fetch, WebSocket, credentials, refresh, or provider call.
  const result = await codex.stream(serializerModel, { messages }, { apiKey: token, sessionId: "offline-context-fixture",
    onPayload(value: any) { body = structuredClone(value); throw new Error("OFFLINE_CAPTURE_ONLY"); } }).result();
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /OFFLINE_CAPTURE_ONLY/);
  assert.ok(body); return body;
}
async function responseItems(response: any) {
  // Native normalization fills a missing tool result for isolated assistant
  // fixtures. A server response contains only the assistant's output items.
  return (await serialize([response])).input.filter((item: any) => item.type !== "function_call_output");
}
const notes = { goal: "EXACT_WORKING_STATE 日本語 🚀", decisions: ["Keep authority"], nextSteps: ["Review evidence"], verification: [], refs: ["test/synthetic.md"] };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function nativeFixture(options: { plan?: boolean; checkpoint?: boolean; recovery?: boolean; compact?: boolean; mutate?: boolean; receiptFlow?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-publication-"));
  const sm = host.SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Synthetic history", timestamp: 1 });
  const requests: any[] = [], responses: any[] = [], errors: unknown[] = [];
  const roles = [process.env.PI_SUBAGENT_ID, process.env.PI_SUBAGENT_SESSION];
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  let plans: ReturnType<typeof registerPlanTools>;
  let checkpoint!: ReturnType<typeof registerContextCheckpoint>;
  let ctx: any;
  let recovery: RecoveryView = options.recovery ? { diagnostics: ["Synthetic import uncertainty"] } : {};
  const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: !!options.compact, reserveTokens: 1000, keepRecentTokens: 0 }, retry: { enabled: false } });
  const loader = new host.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi: any) => {
      plans = registerPlanTools(pi);
      checkpoint = registerContextCheckpoint(pi, plans);
      registerRecoveryReport(pi, () => recovery);
      pi.on("session_start", (_event: any, context: any) => { ctx = context; });
      pi.on("session_before_compact", (event: any) => ({ compaction: { summary: "Synthetic retain-none summary without managed state",
        firstKeptEntryId: null, tokensBefore: event.preparation.tokensBefore } }));
      pi.registerTool({ name: "noop", label: "Noop", description: "Synthetic no-op", parameters: Type.Object({}), async execute() {
        if (options.mutate && requests.length === 3) {
          const plan = plans.read(sm).snapshot!;
          plans.mutate(sm, plan.planId, plan.revision, (p, c) => store.block(p, c, p.tasks[0].taskId, "EXTERNAL_RESULT_CHANGE"));
          recovery = { diagnostics: ["NEW_RECOVERY_DIAGNOSTIC"] };
        }
        return { content: [{ type: "text", text: "noop" }], details: {} };
      } });
      pi.registerProvider("publication-fixture", { baseUrl: "https://example.invalid", apiKey: "synthetic", api: "publication-fixture-api",
        models: [{ id: "model", name: "Synthetic", reasoning: false, input: ["text"], contextWindow: options.compact ? 6000 : 128000,
          maxTokens: 1000, cost: serializerModel.cost }],
        streamSimple(model: any, context: any) {
          requests.push(structuredClone(context));
          const index = requests.length - 1;
          const tool = index < (options.compact ? 1 : 6);
          let name = "noop", args: any = {};
          if (options.receiptFlow && tool) {
            const last = context.messages.findLast((item: any) => item.role === "toolResult" && item.toolName === "plan_update");
            const receipt = last ? JSON.parse(last.content.map((item: any) => item.text ?? "").join("")) : undefined;
            if (index === 0) name = "plan_read";
            else if (index === 4) { name = "context_checkpoint"; args = { action: "save", ...notes }; }
            else {
              name = "plan_update";
              const command = index === 1 ? { action: "create", title: "Model-created receipt plan" } : index === 2 ?
                { action: "add", planId: receipt.planId, title: "Model-created receipt task" } : index === 3 ?
                  { action: "attempt", planId: receipt.planId, taskId: receipt.tasks[0].taskId, mode: "start" } :
                  { action: "status", planId: receipt.planId, taskId: receipt.tasks[0].taskId, transition: "block", reason: "Parent decision needed" };
              args = { expectedRevision: receipt?.revision ?? 0, command };
            }
          }
          const message: any = { role: "assistant", content: tool ? [{ type: "toolCall", id: `call_${index}`, name, arguments: args }] : [{ type: "text", text: "Finished" }],
            provider: model.provider, model: model.id, api: model.api, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
            usage: options.compact && index === 0 ? { ...zeroUsage, input: 10000, totalTokens: 10000 } : zeroUsage };
          responses.push(structuredClone(message));
          const stream = ai.createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
          return stream;
        },
      });
    }],
  });
  let session: any;
  try {
    await loader.reload();
    ({ session } = await host.createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: sm }));
    const model = session.extensionRunner.getModelRegistry().find("publication-fixture", "model");
    assert.ok(model); await session.setModel(model);
    await session.bindExtensions({ onError: (error: any) => errors.push(error) });
    if (options.plan) {
      let plan = plans!.create(sm, 0, "EXACT_PLAN");
      plan = plans!.mutate(sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Synthetic task"));
    }
    if (options.checkpoint) await session.extensionRunner.getToolDefinition("context_checkpoint")?.execute?.("setup", { action: "save", ...notes }, undefined, undefined, ctx);
    // A setup-only native tool call has no model-visible receipt, so the first
    // before_agent_start must publish its notes. Model-issued saves are covered
    // by context-checkpoint.test.ts.
    if (options.checkpoint && !checkpoint.read(ctx).checkpoint) throw new Error("Checkpoint setup tool was not exposed by the host");
    return { dir, sm, session, requests, responses, errors, plans: plans!, ctx, checkpoint,
      async cleanup() { session.dispose(); rmSync(dir, { recursive: true, force: true }); } };
  } catch (error) { session?.dispose(); rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"].forEach((name, i) => { if (roles[i] === undefined) delete process.env[name]; else process.env[name] = roles[i]; }); }
}

for (const [name, options] of Object.entries({ empty: {}, plan: { plan: true }, checkpoint: { checkpoint: true }, recovery: { recovery: true },
  "plan-checkpoint": { plan: true, checkpoint: true }, all: { plan: true, checkpoint: true, recovery: true } })) {
  test(`native ${name}: 6/6 unchanged transitions qualify for Codex delta, no extra publications or turns`, async () => {
    const f = await nativeFixture(options);
    try {
      await f.session.prompt("Perform six synthetic tool turns, then stop");
      assert.equal(f.requests.length, 7); assert.deepEqual(f.errors, []);
      const expected = Object.values(options).filter(Boolean).length;
      const publications = f.sm.getBranch().filter((entry: any) => entry.type === "custom_message");
      assert.equal(publications.length, expected);
      const bodies = await Promise.all(f.requests.map(request => serialize(request.messages)));
      assert.ok(bodies[0].tools?.some((tool: any) => tool.name === "noop"), "native schemas are included in serializer fixture");
      for (let i = 1; i < bodies.length; i++) {
        const lastResponseItems = await responseItems(f.responses[i - 1]);
        const continuation = { lastRequestBody: bodies[i - 1], lastResponseItems, lastResponseId: `response_${i - 1}` };
        const delta = selectTransport.delta(bodies[i], continuation);
        assert.deepEqual(bodies[i].input.slice(0, bodies[i - 1].input.length + lastResponseItems.length), [...bodies[i - 1].input, ...lastResponseItems], `transition ${i} prefix`);
        assert.ok(delta, `transition ${i} lost its serialized prefix`);
        const sent = selectTransport.body({ continuation }, bodies[i]);
        assert.equal(sent.previous_response_id, `response_${i - 1}`);
        assert.deepEqual(sent.input, delta);
        assert.ok(Buffer.byteLength(JSON.stringify(sent)) < Buffer.byteLength(JSON.stringify(bodies[i])));
      }
      if (name === "empty") assert.doesNotMatch(JSON.stringify(f.requests), /No readable active plan|READ-ONLY checkpoint/);
      console.log(`Pi AI ${aiVersion} ${name}: 6/6 delta; ${expected} persistent publications; 7 requests`);
    } finally { await f.cleanup(); }
  });
}

test("negative control: identical request-time tail injections fail the native selector on all 6 transitions", async () => {
  const f = await nativeFixture();
  try {
    await f.session.prompt("Synthetic legacy projection regression");
    const bodies = await Promise.all(f.requests.map(request => serialize([...request.messages,
      { role: "user", content: "Unchanged ephemeral plan/checkpoint projection", timestamp: 0 }])));
    for (let i = 1; i < bodies.length; i++) {
      const continuation = { lastRequestBody: bodies[i - 1], lastResponseItems: await responseItems(f.responses[i - 1]), lastResponseId: `response_${i}` };
      assert.equal(selectTransport.delta(bodies[i], continuation), undefined);
      assert.equal(selectTransport.body({ continuation }, bodies[i]), bodies[i], "native selector falls back to the full request");
    }
  } finally { await f.cleanup(); }
});

test("native model mutations and checkpoint save use receipts without duplicate state publications", async () => {
  const f = await nativeFixture({ receiptFlow: true });
  try {
    await f.session.prompt("Read first, create and update a plan using receipt IDs, then save notes");
    assert.equal(f.requests.length, 7); assert.deepEqual(f.errors, []);
    assert.equal(f.sm.getBranch().filter((entry: any) => entry.type === "custom_message").length, 0);
    const state = f.plans.read(f.sm).snapshot!;
    assert.equal(state.revision, 3); assert.equal(state.tasks[0].status, "blocked");
    assert.equal(f.checkpoint.read(f.ctx).checkpoint?.workingState?.goal, notes.goal);
    for (let i = 1; i < f.requests.length; i++) {
      const previous = await serialize(f.requests[i - 1].messages), current = await serialize(f.requests[i].messages);
      assert.ok(selectTransport.delta(current, { lastRequestBody: previous, lastResponseItems: await responseItems(f.responses[i - 1]) }), `receipt transition ${i}`);
    }
  } finally { await f.cleanup(); }
});

test("native external state changes append after tool results and before the next dependent decision", async () => {
  const f = await nativeFixture({ plan: true, recovery: true, mutate: true });
  try {
    await f.session.prompt("Perform synthetic work");
    assert.equal(f.requests.length, 7); assert.deepEqual(f.errors, []);
    assert.doesNotMatch(JSON.stringify(f.requests[2]), /EXTERNAL_RESULT_CHANGE|NEW_RECOVERY_DIAGNOSTIC/);
    assert.match(JSON.stringify(f.requests[3]), /EXTERNAL_RESULT_CHANGE/);
    assert.match(JSON.stringify(f.requests[3]), /NEW_RECOVERY_DIAGNOSTIC/);
    for (let i = 1; i < f.requests.length; i++) {
      const previous = await serialize(f.requests[i - 1].messages), current = await serialize(f.requests[i].messages);
      const lastResponseItems = await responseItems(f.responses[i - 1]);
      assert.ok(selectTransport.delta(current, { lastRequestBody: previous, lastResponseItems }), `transition ${i}`);
    }
    const entries = f.sm.getBranch();
    const change = entries.findIndex((entry: any) => entry.type === "custom_message" && String(entry.content).includes("EXTERNAL_RESULT_CHANGE"));
    assert.equal(entries[change - 1].message?.role, "toolResult");
  } finally { await f.cleanup(); }
});

test("native between-turn auto-compaction retains exact state via read-only fallback, not a false delta guarantee", async () => {
  const f = await nativeFixture({ plan: true, checkpoint: true, recovery: true, compact: true });
  try {
    await f.session.prompt("Run a synthetic tool and compact before its dependent response");
    assert.equal(f.requests.length, 2, "restoration does not add a model turn"); assert.deepEqual(f.errors, []);
    assert.match(JSON.stringify(f.requests[1]), /EXACT_WORKING_STATE 日本語 🚀/);
    assert.match(JSON.stringify(f.requests[1]), /EXACT_PLAN/);
    assert.match(JSON.stringify(f.requests[1]), /Synthetic import uncertainty/);
    const branch = f.sm.getBranch();
    const compact = branch.findIndex((entry: any) => entry.type === "compaction");
    const response = branch.findIndex((entry: any, i: number) => i > compact && entry.type === "message" && entry.message.role === "assistant");
    assert.ok(compact > 0 && response > compact);
    assert.ok(!branch.slice(compact + 1, response).some((entry: any) => entry.type === "custom_message"), "host cannot persist this restoration before the response");
    const persisted = branch.slice(response + 1).filter((entry: any) => entry.type === "custom_message");
    assert.equal(persisted.length, 3, "the next actionable turn boundary makes restoration persistent");
    const previous = await serialize(f.requests[0].messages), current = await serialize(f.requests[1].messages);
    const lastResponseItems = await responseItems(f.responses[0]);
    assert.equal(selectTransport.delta(current, { lastRequestBody: previous, lastResponseItems }), undefined,
      "compaction resets continuation; the transient fallback is explicitly a remaining host limitation");
  } finally { await f.cleanup(); }
});

test("visible projection, not raw branch/process cache, governs reload/fork/omission/restoration dedup", () => {
  const dir = mkdtempSync(join(tmpdir(), "publication-projection-"));
  const sm = host.SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Synthetic branch", timestamp: 1 });
  const root = sm.getLeafId();
  let state = "Current exact state";
  const hooks = () => {
    const handlers = new Map<string, Function>();
    registerContextPublication({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any,
      { customType: "synthetic-state", read: () => state, absent: "State no longer available" });
    return handlers;
  };
  const persist = (sm: any, handlers: Map<string, Function>) => {
    const result = handlers.get("before_agent_start")!({}, { sessionManager: sm });
    if (result) return sm.appendCustomMessageEntry(result.message.customType, result.message.content, false, result.message.details);
  };
  try {
    const initial = hooks(); const publication = persist(sm, initial);
    assert.ok(publication);
    const disk = readFileSync(sm.getSessionFile()!, "utf8");
    assert.equal(persist(sm, hooks()), undefined, "extension reload");
    const reopened = host.SessionManager.open(sm.getSessionFile()!);
    assert.equal(persist(reopened, hooks()), undefined, "process restart/reopen");
    const fork = host.SessionManager.forkFrom(sm.getSessionFile()!, dir, dir);
    assert.equal(persist(fork, hooks()), undefined, "inherited visible data alone grants no extra publication authority");
    sm.appendContextEdit(publication, null);
    assert.ok(persist(sm, hooks()), "an omitted custom message does not count as visible state");
    sm.appendCompaction("Keep publication", sm.getLeafId(), 1000);
    assert.equal(persist(sm, hooks()), undefined, "retained partial history deduplicates");
    sm.appendCompaction("Omit publication", null, 1000);
    const native = sm.buildSessionContext().messages;
    const before = readFileSync(sm.getSessionFile()!, "utf8");
    const fallback = hooks().get("context")!({ messages: native }, { sessionManager: sm });
    assert.match(fallback.messages.at(-1).content, /Current exact state/);
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), before);
    assert.ok(persist(sm, hooks()));
    sm.branch(root);
    state = "Sibling exact state";
    assert.ok(persist(sm, hooks()));
    assert.doesNotMatch(JSON.stringify(sm.buildSessionContext().messages), /Current exact state/);
    assert.match(disk, /Current exact state/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all publication channels avoid hashing receipt-free history and unrelated markers", () => {
  let historyHashes = 0;
  const large = { toJSON() { historyHashes++; return "large unrelated history"; } };
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "unmarked", name: "ordinary", arguments: large }] },
    { role: "toolResult", toolCallId: "unmarked", content: large, details: {} },
    { role: "toolResult", toolCallId: "other-channel", content: large, details: { contextReceipt: {
      contentHash: "not-our-hash", callHash: "not-our-call", states: [{ customType: "unrelated-channel", identity: "unrelated" }] } } },
  ];
  for (const customType of ["plan", "checkpoint", "recovery"]) {
    const handlers = new Map<string, Function>();
    registerContextPublication({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any,
      { customType, read: () => "current", absent: "absent" });
    handlers.get("before_agent_start")!({}, { sessionManager: { buildSessionProjection: () => ({ messages }) } });
    handlers.get("turn_end")!({ entries: [], context: { contextMessages: messages } }, {});
    handlers.get("context")!({ messages: [{ role: "compactionSummary" }, ...messages] }, {});
  }
  assert.equal(historyHashes, 0, "operation count: unmarked payloads and other channels must not be serialized for hashes");
});

test("receipt dedup requires its visible call/content and an unbroken prior-state chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "publication-receipt-"));
  const sm = host.SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Synthetic receipt", timestamp: 1 });
  const handlers = new Map<string, Function>();
  const current = "Updated state";
  registerContextPublication({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any,
    { customType: "receipt-state", read: () => current, absent: "No state" });
  const prepare = () => handlers.get("before_agent_start")!({}, { sessionManager: sm });
  const args = { goal: current }, content = [{ type: "text", text: "Saved" }];
  try {
    const call = sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "save", name: "save", arguments: args }],
      api: "synthetic", provider: "synthetic", model: "synthetic", stopReason: "toolUse", timestamp: 2, usage: zeroUsage });
    const result = sm.appendMessage({ role: "toolResult", toolCallId: "save", toolName: "save", content, timestamp: 3, isError: false,
      details: contextReceipt(content, [publicationState("receipt-state", current)], args) });
    const tip = sm.getLeafId();
    assert.equal(prepare(), undefined, "the save receipt and its complete notes call are visible");
    sm.appendContextEdit(result, { content: "Receipt edited away" });
    assert.ok(prepare(), "details alone cannot certify replaced model content");
    sm.branch(tip);
    sm.appendContextEdit(call, { content: [{ type: "text", text: "Call no longer visible" }] });
    assert.ok(prepare(), "receipt without its replacement notes is insufficient");
    sm.branch(tip);
    sm.appendContextEdit(call, { content: [{ type: "toolCall", id: "save", name: "save", arguments: { goal: "Edited notes" } }] });
    assert.ok(prepare(), "an argument-only context edit cannot reuse a receipt for the original call");
    sm.branch(tip);
    sm.appendMessage({ role: "toolResult", toolCallId: "save", toolName: "save", content, timestamp: 4, isError: false,
      details: contextReceipt(content, [{ ...publicationState("receipt-state", "Different state"), previousIdentity: "missing-base" }], args) });
    assert.equal(prepare(), undefined, "a disconnected delta cannot override the last complete visible state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
