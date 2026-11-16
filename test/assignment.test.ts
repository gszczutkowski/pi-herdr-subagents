import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { OPEN_ACCENT } from "../pi-extension/subagents/frame.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ASSIGNMENT_ENTRY_TYPE, ASSIGNMENT_ENV, registerSubagentAssignment,
  type SubagentAssignment,
} from "../pi-extension/subagents/assignment.ts";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";
import type { SubagentLaunchContext } from "../pi-extension/subagents/harness/types.ts";

function fixture(run: (dir: string, data: SubagentAssignment, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-assignment-"));
  const env = { ...process.env };
  const data: SubagentAssignment = {
    version: 1, childId: "child-1", sessionFile: join(dir, "child.jsonl"),
    sender: "Planner", recipient: "Implementation", role: "worker",
    task: "Exact task\n\nKeep  two spaces, `code`, and 日本語.\n", skills: ["review", "lint"],
  };
  const file = join(dir, "assignment.json");
  writeFileSync(file, JSON.stringify(data));
  process.env[ASSIGNMENT_ENV] = file;
  process.env.PI_SUBAGENT_ID = data.childId;
  try { run(dir, data, file); } finally {
    for (const name of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function bootstrap(data: SubagentAssignment, inherited: any[] = []) {
  const entries = [...inherited];
  let start: Function = () => {};
  let render: Function = () => {};
  const pi = {
    registerEntryRenderer: (_type: string, renderer: Function) => { render = renderer; },
    appendEntry: (customType: string, value: unknown) => entries.push({ type: "custom", customType, data: value }),
    on: (_event: string, handler: Function) => { start = handler; },
  };
  registerSubagentAssignment(pi as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionFile: () => data.sessionFile, getEntries: () => entries } };
  return { entries, start: (reason = "startup") => start({ reason }, ctx), render };
}

describe("structured subagent assignment", () => {
  it("bootstraps through real Pi lifecycle bindings before the task and never adds it to provider context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assignment-runtime-"));
    const envNames = [ASSIGNMENT_ENV, "PI_SUBAGENT_ID"];
    const previous = envNames.map((name) => process.env[name]);
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const sm = SessionManager.create(dir, dir);
      const data: SubagentAssignment = {
        version: 1, childId: "runtime-child", sessionFile: sm.getSessionFile()!,
        sender: "Parent agent", recipient: "Runtime child", role: "worker", task: "EXACT_RUNTIME_TASK", skills: [],
      };
      process.env.PI_SUBAGENT_ID = data.childId;
      process.env[ASSIGNMENT_ENV] = join(dir, "assignment.json");
      writeFileSync(process.env[ASSIGNMENT_ENV]!, JSON.stringify(data));
      const requests: string[] = [];
      const errors: unknown[] = [];
      const settingsManager = SettingsManager.inMemory({});
      const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager, noSkills: true, noPromptTemplates: true,
        noThemes: true, noContextFiles: true,
        extensionFactories: [registerSubagentAssignment, (pi) => {
          pi.registerProvider("assignment-test", {
            baseUrl: "https://example.invalid", apiKey: "test-only", api: "assignment-test-api",
            models: [{ id: "model", name: "model", reasoning: false, input: ["text"],
              contextWindow: 128000, maxTokens: 100,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
            streamSimple(model, context) {
              requests.push(JSON.stringify(context.messages));
              const message: AssistantMessage = {
                role: "assistant", content: [{ type: "text", text: "ok" }],
                provider: model.provider, model: model.id, api: model.api,
                stopReason: "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              const stream = createAssistantMessageEventStream();
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: "stop", message });
              stream.end();
              return stream;
            },
          });
        }],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, sessionManager: sm }));
      const model = session.extensionRunner!.getModelRegistry().find("assignment-test", "model");
      assert.ok(model);
      await session.setModel(model);
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      const firstVisible = sm.getEntries().find((entry) => entry.type === "custom" || entry.type === "message");
      assert.equal(firstVisible?.type, "custom");
      await session.prompt(data.task);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].split(data.task).length - 1, 1);
      assert.ok(!requests[0].includes("Runtime child"), "display metadata must not enter model context");
      await session.reload();
      assert.equal(sm.getEntries().filter((entry) => entry.type === "custom" && entry.customType === ASSIGNMENT_ENTRY_TYPE).length, 1);
      assert.deepEqual(errors, []);
    } finally {
      session?.dispose();
      envNames.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends the first new entry after inherited history and only once on reload/resume", () => fixture((_dir, data) => {
    const inherited = [
      { type: "message", message: { role: "user", content: "parent history" } },
      { type: "custom", customType: ASSIGNMENT_ENTRY_TYPE, data: { ...data, childId: "parent" } },
    ];
    const harness = bootstrap(data, inherited);
    harness.start();
    assert.deepEqual(harness.entries.slice(0, 2), inherited);
    assert.deepEqual(harness.entries[2], { type: "custom", customType: ASSIGNMENT_ENTRY_TYPE, data });
    harness.start("reload");
    harness.start("resume");
    // A replacement extension instance reconstructs deduplication from persisted history.
    const resumed = bootstrap(data, harness.entries);
    resumed.start();
    assert.equal(resumed.entries.length, 3);
  }));

  it("does not leak inherited launch metadata into a nested child or another session", () => fixture((_dir, data) => {
    process.env.PI_SUBAGENT_ID = "nested-child";
    const nested = bootstrap(data);
    nested.start();
    assert.equal(nested.entries.length, 0);
    process.env.PI_SUBAGENT_ID = data.childId;
    const unrelated = bootstrap({ ...data, sessionFile: `${data.sessionFile}.other` });
    unrelated.start();
    assert.equal(unrelated.entries.length, 0);
  }));

  it("ignores absent, corrupt, or invalid metadata without disrupting task delivery", () => fixture((_dir, data, file) => {
    for (const text of ["not json", "null", JSON.stringify({ ...data, skills: [42] })]) {
      writeFileSync(file, text);
      const harness = bootstrap(data);
      assert.doesNotThrow(() => harness.start());
      assert.equal(harness.entries.length, 0);
    }
    delete process.env[ASSIGNMENT_ENV];
    const harness = bootstrap(data);
    harness.start();
    assert.equal(harness.entries.length, 0);
  }));

  it("guards older Pi APIs without injecting a second model-facing message", () => {
    assert.doesNotThrow(() => registerSubagentAssignment({} as ExtensionAPI));
    assert.doesNotThrow(() => registerSubagentAssignment({ appendEntry() { throw Error("must not append"); } } as unknown as ExtensionAPI));
  });

  it("renders full task and English labels at narrow and wide widths", () => fixture((_dir, data) => {
    const { render } = bootstrap(data);
    const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
    const card = render({ data }, { expanded: false }, theme);
    const rendered = card.render(100);
    assert.ok(rendered[0].startsWith(`${OPEN_ACCENT}╭`));
    assert.ok(rendered.at(-1).startsWith(`${OPEN_ACCENT}╰`));
    assert.ok(rendered.slice(1, -1).every((line: string) => line.startsWith(`${OPEN_ACCENT}│`) && stripVTControlCharacters(line).endsWith("│")));
    const text = rendered.join("\n");
    for (const label of ["Message from Planner", "Sender: Planner", "Recipient: Implementation", "Role: worker", "Skills: review, lint", "Task:"]) {
      assert.ok(text.includes(label), label);
    }
    assert.ok(text.includes("Keep  two spaces, `code`, and 日本語."));
    for (const width of [0, 1, 2, 3, 4, 5, 8, 20, 80]) {
      card.invalidate();
      const lines = card.render(width);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
      if (width >= 4) {
        assert.equal((lines.join("\n").match(/日|本|語/g) ?? []).length, 3);
      }
    }
  }));

  for (const taskDelivery of ["direct", "artifact"] as const) {
    it(`writes scoped metadata without changing ${taskDelivery} task/skill delivery`, () => fixture((dir, data) => {
      process.env.PI_SUBAGENT_NAME = "Planner";
      const context: SubagentLaunchContext = {
        params: { id: data.childId, name: data.recipient, task: data.task, agent: "worker", skills: "review, lint" },
        runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "request", thinkingSource: "request" },
        parentThinking: "off", surface: "pane-1", artifactDir: dir, sessionDir: dir,
        subagentSessionFile: data.sessionFile, effectiveCwd: dir, effectiveAutoExit: true,
        effectiveInteractive: false, inheritsConversationContext: taskDelivery === "direct", taskDelivery,
        roleBlock: "ROLE", modeHint: "MODE", summaryInstruction: "SUMMARY", subagentsDir: dir,
        shellQuote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
      };
      const { command } = new PiHarnessDriver().buildCommand(context);
      const metadataFile = join(dir, `context/subagent-assignment-${data.childId}.json`);
      assert.ok(command.includes(`${ASSIGNMENT_ENV}='${metadataFile}'`));
      assert.deepEqual(JSON.parse(readFileSync(metadataFile, "utf8")), data);
      assert.ok(command.includes("PI_SUBAGENT_INITIAL_SKILLS='review, lint'"));
      assert.ok(!command.includes("'/skill:"));
      const taskPath = command.match(/'@([^']+\.md)'/)![1];
      assert.equal(readFileSync(taskPath, "utf8"), taskDelivery === "direct"
        ? `ROLE\n\n${data.task}` : `ROLE\n\nMODE\n\n${data.task}\n\nSUMMARY`);
      assert.equal(command.includes(data.task), false, "both prompt shapes use a controlled artifact");
    }));
  }

  it("persists a display-only card with real SessionManager, preserving fork history and model context", () => fixture((dir, data) => {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "inherited history", timestamp: Date.now() });
    const sessionData = { ...data, sessionFile: sm.getSessionFile()! };
    writeFileSync(process.env[ASSIGNMENT_ENV]!, JSON.stringify(sessionData));
    const before = sm.getEntries().length;
    let start: Function = () => {};
    registerSubagentAssignment({
      registerEntryRenderer() {},
      appendEntry: (customType: string, value: unknown) => sm.appendCustomEntry(customType, value),
      on: (_event: string, handler: Function) => { start = handler; },
    } as unknown as ExtensionAPI);
    start({ reason: "startup" }, { sessionManager: sm });
    assert.equal(sm.getEntries()[before].type, "custom");
    sm.appendMessage({ role: "user", content: data.task, timestamp: Date.now() });
    const reloaded = SessionManager.open(sm.getSessionFile()!);
    assert.equal(reloaded.getEntries().filter((entry) => entry.type === "custom" && entry.customType === ASSIGNMENT_ENTRY_TYPE).length, 1);
    const modelMessages = reloaded.buildSessionContext().messages;
    assert.deepEqual(modelMessages.map((message: any) => message.content), ["inherited history", data.task]);
    start({ reason: "resume" }, { sessionManager: reloaded });
    assert.equal(reloaded.getEntries().length, sm.getEntries().length);
  }));
});
