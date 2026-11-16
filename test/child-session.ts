import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import childExtension from "../pi-extension/subagents/subagent-done.ts";

/** Real Pi lifecycle, deterministic provider, isolated child environment; no network or terminal. */
export async function withChildSession<T>(options: {
  skills?: string;
  respond?: (index: number) => Partial<AssistantMessage>;
  extensions?: Array<(pi: any) => void>;
  liveContinuation?: boolean;
  autoExit?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  setup?: (manager: SessionManager) => void;
  sessionFile?: string;
  stream?: (model: any, context: any, streamOptions: any, index: number) => any;
}, run: (fixture: { session: AgentSession; dir: string; requests: any[]; shutdowns: () => number }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "child-session-"));
  const envNames = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_INITIAL_SKILLS", "PI_SUBAGENT_ASSIGNMENT_FILE", "PI_SUBAGENT_ACTIVITY_FILE", "PI_DENY_TOOLS"];
  const previous = envNames.map((name) => process.env[name]);
  let session: AgentSession | undefined;
  const errors: unknown[] = [];
  const requests: any[] = [];
  let shutdowns = 0;
  try {
    envNames.forEach((name) => { delete process.env[name]; });
    const agentDir = join(dir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_ID = `test-${basename(dir)}`;
    process.env.PI_SUBAGENT_AUTO_EXIT = options.autoExit === false ? "0" : "1";
    process.env.PI_SUBAGENT_INITIAL_SKILLS = options.skills ?? "";
    const manager = options.sessionFile ? SessionManager.open(options.sessionFile) : SessionManager.create(dir, dir);
    process.env.PI_SUBAGENT_SESSION = manager.getSessionFile();
    if (options.liveContinuation) process.env.PI_SUBAGENT_ACTIVITY_FILE = join(dir, "activity.json");
    options.setup?.(manager);
    for (const name of ["first", "second"]) {
      const skillDir = join(agentDir, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n---\nREQUIRED_${name.toUpperCase()}_INSTRUCTIONS`);
    }
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt ? [options.appendSystemPrompt] : [],
      appendSystemPromptOverride: () => options.appendSystemPrompt ? [options.appendSystemPrompt] : [],
      extensionFactories: [(pi) => {
        pi.registerProvider("child-test", { baseUrl: "https://example.invalid", apiKey: "test", api: "child-test-api",
          models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context, streamOptions) {
            requests.push(structuredClone(context));
            assert.ok(requests.length < 8, "unexpected agent loop");
            if (options.stream) return options.stream(model, context, streamOptions, requests.length - 1);
            const message: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
              content: [{ type: "text", text: "completed" }], stopReason: "stop", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              ...options.respond?.(requests.length - 1) };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: message.stopReason as any, message });
            stream.end();
            return stream;
          } });
      }, childExtension, ...(options.extensions ?? [])] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir, resourceLoader: loader, settingsManager, sessionManager: manager }));
    const model = session.extensionRunner!.getModelRegistry().find("child-test", "model");
    assert.ok(model);
    await session.setModel(model);
    await session.bindExtensions({ onError: (error) => errors.push(error), shutdownHandler: () => { shutdowns++; } });
    const result = await run({ session, dir, requests, shutdowns: () => shutdowns });
    assert.deepEqual(errors, [], "no silently ignored extension errors");
    return result;
  } finally {
    // SDK disposal is not a CLI shutdown event. Close session-scoped extension
    // watchers explicitly before invalidating their contexts.
    if (session?.extensionRunner) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session?.dispose();
    envNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    rmSync(dir, { recursive: true, force: true });
  }
}
