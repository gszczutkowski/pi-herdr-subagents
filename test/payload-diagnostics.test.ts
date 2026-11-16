import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { DEFAULT_CONTEXT_PROTECTION, parseContextProtection } from "../pi-extension/subagents/context-policy.ts";
import { providerPayloadBytes, payloadWarningBudget, registerPayloadDiagnostics } from "../pi-extension/subagents/payload-diagnostics.ts";

const roleNames = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"] as const;
const savedRole = roleNames.map(name => process.env[name]);
before(() => { for (const name of roleNames) delete process.env[name]; });
after(() => roleNames.forEach((name, i) => { if (savedRole[i] === undefined) delete process.env[name]; else process.env[name] = savedRole[i]; }));

const config = (budgets: Record<string, number> = {}) => parseContextProtection({ providerPayloadWarningBytes: budgets });

test("byte budgets are provider-specific, validated, opt-in and model overrides win", () => {
  assert.deepEqual(DEFAULT_CONTEXT_PROTECTION.providerPayloadWarningBytes, {});
  const c = config({ codex: 2000, "codex/model": 3000 });
  assert.equal(payloadWarningBudget(c, { provider: "codex", id: "model" }), 3000);
  assert.equal(payloadWarningBudget(c, { provider: "codex", id: "other" }), 2000);
  assert.equal(payloadWarningBudget(c, { provider: "other", id: "model" }), undefined);
  assert.equal(payloadWarningBudget(c), undefined);
  for (const raw of [null, [], 1024, { "": 2000 }, { "bad\nname": 2000 }, { codex: 1023 }, { codex: NaN }, { codex: 1.5 }, { codex: Infinity }, JSON.parse('{"__proto__":2000}')]) {
    assert.throws(() => parseContextProtection({ providerPayloadWarningBytes: raw }), /providerPayloadWarningBytes/);
  }
});

test("measurement counts complete UTF-8 JSON including schemas, images and opaque reasoning without rewriting", () => {
  const payload = { input: [{ text: "日本語 🚀", image: "data:image/png;base64," + "x".repeat(4000), encrypted_content: "opaque".repeat(300) }], tools: [{ parameters: { description: "schema".repeat(200) } }] };
  const copy = structuredClone(payload);
  assert.equal(providerPayloadBytes(payload), Buffer.byteLength(JSON.stringify(payload), "utf8"));
  assert.ok(providerPayloadBytes(payload)! > JSON.stringify(payload).length);
  assert.deepEqual(payload, copy);
  assert.equal(providerPayloadBytes(undefined), undefined);
  assert.equal(providerPayloadBytes(1n), undefined);
  const cycle: any = {}; cycle.self = cycle;
  assert.equal(providerPayloadBytes(cycle), undefined);
});

function fixture(enabled = true) {
  const handlers = new Map<string, Function>(); const commands = new Map<string, any>();
  const notifications: string[] = []; const statuses: any[] = [];
  const ctx: any = { hasUI: true, model: { provider: "synthetic", id: "model" }, ui: {
    notify: (text: string) => notifications.push(text), setStatus: (...args: any[]) => statuses.push(args),
  }, abort() { assert.fail("advisory hook must not abort or compact"); }, compact() { assert.fail("no compaction from payload hook"); } };
  registerPayloadDiagnostics({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd) } as any,
    { ...config({ synthetic: 2000 }), enabled });
  return { handlers, commands, ctx, notifications, statuses };
}

test("threshold boundaries warn once, recover below threshold and never return a replacement or leak payloads", async () => {
  const f = fixture(); const hook = f.handlers.get("before_provider_request")!;
  for (const size of [1999, 2000, 2001]) {
    const payload = { content: "x".repeat(size - 14) };
    assert.equal(providerPayloadBytes(payload), size);
    assert.equal(hook({ payload }, f.ctx), undefined);
  }
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /2000 UTF-8 bytes/);
  hook({ payload: { secret: "DO_NOT_LOG_THIS" } }, f.ctx);
  hook({ payload: { content: "x".repeat(3000) } }, f.ctx);
  assert.equal(f.notifications.length, 2);
  f.handlers.get("after_provider_response")!({ status: 400 }, f.ctx);
  await f.commands.get("context-bytes").handler("", f.ctx);
  const report = f.notifications.at(-1)!;
  assert.match(report, /HTTP=400/); assert.match(report, /No hard send limit/);
  assert.doesNotMatch(f.notifications.join("\n"), /DO_NOT_LOG_THIS|overflow detected/);
  f.handlers.get("session_tree")!({}, f.ctx);
  await f.commands.get("context-bytes").handler("", f.ctx);
  assert.match(f.notifications.at(-1)!, /observed=0/);
  const disabled = fixture(false);
  disabled.handlers.get("before_provider_request")!({ payload: "x".repeat(5000) }, disabled.ctx);
  assert.deepEqual(disabled.notifications, []);
});

test("headless observations never require UI; child sessions register no diagnostics", async () => {
  const f = fixture();
  f.ctx.hasUI = false;
  f.ctx.ui = new Proxy({}, { get() { assert.fail("headless diagnostics must not access UI"); } });
  assert.equal(f.handlers.get("before_provider_request")!({ payload: "x".repeat(3000) }, f.ctx), undefined);
  await f.commands.get("context-bytes").handler("", f.ctx);
  f.handlers.get("session_shutdown")!({}, f.ctx);
  for (const name of roleNames) {
    process.env[name] = "synthetic-child";
    try {
      registerPayloadDiagnostics(new Proxy({}, { get() { assert.fail("child must register nothing"); } }) as any, config());
    } finally { delete process.env[name]; }
  }
});

test("native Codex serializer is observed offline; direct callback failure stops transport, extension exceptions do not gate it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "payload-native-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const errors: any[] = [];
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => {
        registerPayloadDiagnostics(pi, config());
        pi.on("before_provider_request", () => { throw new Error("synthetic extension warning, not a gate"); });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir) }));
    await session.bindExtensions({ onError: error => errors.push(error) });
    const jwt = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic`;
    const model: any = { provider: "openai-codex", id: "synthetic-model", api: "openai-codex-responses", baseUrl: "https://example.invalid", reasoning: false,
      input: ["text", "image"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    let observed: any; let network = 0;
    const stream = codexStream(model, { messages: [{ role: "user", content: "Synthetic 日本語", timestamp: 1 }] }, {
      apiKey: jwt, transport: "sse", fetch: async () => { network++; throw new Error("Network forbidden"); },
      onPayload: async payload => {
        observed = await session!.extensionRunner!.emitBeforeProviderRequest(payload);
        assert.deepEqual(observed, payload);
        throw new Error("OFFLINE_CAPTURE_COMPLETE");
      },
    });
    const result = await stream.result();
    assert.equal(network, 0);
    assert.ok(observed.input.length > 0); assert.ok(providerPayloadBytes(observed)! > 0);
    assert.match(result.errorMessage!, /OFFLINE_CAPTURE_COMPLETE/);
    assert.ok(errors.some(error => error.event === "before_provider_request"), "runner reports but swallows extension error");
  } finally { session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
