import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager,
  type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import childExtension from "../pi-extension/subagents/subagent-done.ts";

/** Native replacement lifecycle used by /new, /resume and /fork; entirely offline. */
export async function withCompletionRuntime(respond: (index: number) => Partial<AssistantMessage>,
  run: (fixture: { runtime: AgentSessionRuntime; dir: string; shutdowns: () => number }) => Promise<void>,
  extensions: Array<(pi: any) => void> = []): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "completion-runtime-"));
  const keys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_ACTIVITY_FILE",
    "PI_SUBAGENT_ASSIGNMENT_FILE", "PI_SUBAGENT_INITIAL_SKILLS", "PI_DENY_TOOLS"];
  const previous = keys.map(key => process.env[key]);
  let runtime: AgentSessionRuntime | undefined;
  let shutdowns = 0;
  let requests = 0;
  const errors: unknown[] = [];
  try {
    keys.forEach(key => { delete process.env[key]; });
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_ID = basename(dir);
    process.env.PI_SUBAGENT_AUTO_EXIT = "0";
    const manager = SessionManager.create(dir, dir);
    process.env.PI_SUBAGENT_SESSION = manager.getSessionFile();
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
        resourceLoaderOptions: { noContextFiles: true, noPromptTemplates: true, noThemes: true, noSkills: true,
          extensionFactories: [pi => pi.registerProvider("completion-test", { apiKey: "offline", baseUrl: "https://example.invalid", api: "completion-test-api",
            models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple(model) {
              assert.ok(requests < 8, "unexpected agent loop");
              const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "finished" }],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                ...respond(requests++) };
              const stream = createAssistantMessageEventStream();
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: message.stopReason as any, message }); stream.end(); return stream;
            } }), childExtension, ...extensions] } });
      return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }), services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir, sessionManager: manager });
    const bind = async () => {
      const session = runtime!.session;
      await session.setModel(session.extensionRunner!.getModelRegistry().find("completion-test", "model")!);
      await session.bindExtensions({ onError: error => errors.push(error), shutdownHandler: () => { shutdowns++; } });
    };
    runtime.setRebindSession(bind);
    await bind();
    await run({ runtime, dir, shutdowns: () => shutdowns });
    assert.deepEqual(errors, [], "no ignored runtime extension errors");
  } finally {
    await runtime?.dispose();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(dir, { recursive: true, force: true });
  }
}
