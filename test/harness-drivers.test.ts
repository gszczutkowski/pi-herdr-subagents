import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { getSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import { __test__ as parentHarness } from "../pi-extension/subagents/index.ts";
import {
  getHarnessDriver,
  registerHarnessDriver,
  validateHarnessLaunch,
  PiHarnessDriver,
  ClaudeHarnessDriver,
  OpenCodeHarnessDriver,
  CodexHarnessDriver,
  GrokHarnessDriver,
  GenericHarnessDriver,
  type SubagentLaunchContext,
} from "../pi-extension/subagents/harness/index.ts";
import type { ResolvedRuntimePlan } from "../pi-extension/subagents/runtime-routing.ts";
import type { SubagentResultContext } from "../pi-extension/subagents/harness/types.ts";

function createMockLaunchContext(overrides?: Partial<SubagentLaunchContext>): SubagentLaunchContext {
  const runtimePlan: ResolvedRuntimePlan = {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    model: "anthropic/claude-sonnet-4-5",
    thinking: "medium",
    modelSource: "request",
    thinkingSource: "request",
  };

  return {
    params: {
      id: "abc12345",
      name: "worker",
      task: "Analyze the repository structure",
    },
    runtimePlan,
    effectiveModel: "anthropic/claude-sonnet-4-5",
    effectiveThinking: "medium",
    parentThinking: "medium",
    surface: "pane-1",
    artifactDir: "/tmp/artifacts",
    sessionDir: "/tmp/sessions",
    subagentSessionFile: "/tmp/sessions/subagent.jsonl",
    effectiveCwd: "/tmp/project",
    effectiveAutoExit: true,
    effectiveInteractive: false,
    inheritsConversationContext: true,
    taskDelivery: "direct",
    subagentsDir: "/path/to/subagents",
    shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
    ...overrides,
  };
}

function createMockResultContext(overrides?: Partial<SubagentResultContext>): SubagentResultContext {
  return {
    running: {
      id: "1",
      name: "test",
      task: "task",
      surface: "s1",
      startTime: Date.now(),
      sessionFile: "f",
      interactive: false,
    },
    completionResult: { reason: "done", exitCode: 0 },
    surface: "s1",
    readPane: () => "Finished repository inspection!\n__SUBAGENT_DONE_0__\n",
    closePane: () => {},
    artifactDir: "/tmp",
    ...overrides,
  };
}

describe("Harness Drivers Registry", () => {
  it("resolves default built-in drivers by id case-insensitively", () => {
    assert.equal(getHarnessDriver("pi").id, "pi");
    assert.equal(getHarnessDriver("PI").id, "pi");
    assert.equal(getHarnessDriver("claude").id, "claude");
    assert.equal(getHarnessDriver("CLAUDE").id, "claude");
    assert.equal(getHarnessDriver("opencode").id, "opencode");
    assert.equal(getHarnessDriver("OpenCode").id, "opencode");
    assert.equal(getHarnessDriver("codex").id, "codex");
    assert.equal(getHarnessDriver("CODEX").id, "codex");
    assert.equal(getHarnessDriver("grok").id, "grok");
    assert.equal(getHarnessDriver("GROK").id, "grok");
  });

  it("defaults to Pi harness when cli is undefined or empty", () => {
    assert.equal(getHarnessDriver(undefined).id, "pi");
    assert.equal(getHarnessDriver("").id, "pi");
    assert.equal(getHarnessDriver("   ").id, "pi");
  });

  it("returns a GenericHarnessDriver for unlisted CLI names", () => {
    const driver = getHarnessDriver("aider");
    assert.equal(driver.id, "aider");
    assert.equal(driver.name, "aider");
    assert.ok(driver instanceof GenericHarnessDriver);
  });

  it("allows registering custom harness drivers", () => {
    const customDriver = new GenericHarnessDriver("custom-agent", "Custom Agent Engine");
    registerHarnessDriver(customDriver);
    const resolved = getHarnessDriver("custom-agent");
    assert.equal(resolved.id, "custom-agent");
    assert.equal(resolved.name, "Custom Agent Engine");
  });
});

describe("harness launch validation", () => {
  it("rejects unsupported transfers and ignored native resume requests", () => {
    assert.throws(() => validateHarnessLaunch(getHarnessDriver("claude"), "fork"), /does not support session mode "fork"/);
    assert.throws(() => validateHarnessLaunch(getHarnessDriver("codex"), "lineage-only"), /does not support session mode "lineage-only"/);
    assert.throws(() => validateHarnessLaunch(getHarnessDriver("pi"), "standalone", "native-id"), /does not support resumeSessionId/);
    assert.doesNotThrow(() => validateHarnessLaunch(getHarnessDriver("pi"), "fork"));
    assert.doesNotThrow(() => validateHarnessLaunch(getHarnessDriver("claude"), "standalone", "native-id"));
  });
});

describe("declared harness capabilities", () => {
  it("limits Pi session transfer to Pi and native resume to commands that forward it", () => {
    for (const cli of ["pi", "claude", "codex", "opencode", "grok", "aider"]) {
      const driver = getHarnessDriver(cli);
      assert.deepEqual(driver.supportedSessionModes, cli === "pi"
        ? ["standalone", "lineage-only", "fork"] : ["standalone"]);
      assert.equal(driver.supportsNativeResume, ["claude", "opencode"].includes(cli));
    }
  });
});

describe("Pi Harness Driver", () => {
  const driver = new PiHarnessDriver();

  it("formats model using full provider/model reference", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "claude-sonnet-4-5", model: "anthropic/claude-sonnet-4-5" }),
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("supports turn interrupts and live activity snapshots", () => {
    assert.equal(driver.supportsTurnInterrupt, true);
    assert.equal(driver.hasActivitySnapshots, true);
  });

  it("builds correct pi invocation command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "anthropic/claude-sonnet-4-5",
      effectiveThinking: "high",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "pi");
    assert.ok(built.command.includes("pi --session '/tmp/sessions/subagent.jsonl'"));
    assert.ok(built.command.includes("--model 'anthropic/claude-sonnet-4-5'"));
    assert.ok(built.command.includes("--thinking 'high'"));
    assert.ok(built.command.includes(`echo '__SUBAGENT_DONE_${ctx.params.id}_'$?'__'`));
  });
});

describe("Pi activity path contract", () => {
  it("boots the child writer at the generated path and exposes its tool snapshot to the parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-activity-contract-"));
    const envNames = ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_ACTIVITY_FILE", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_ASSIGNMENT_FILE"];
    const previous = envNames.map((name) => process.env[name]);
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const context = createMockLaunchContext({ artifactDir: join(dir, "artifacts with spaces") });
      const built = new PiHarnessDriver().buildCommand(context);
      const childActivityFile = /PI_SUBAGENT_ACTIVITY_FILE='([^']+)'/.exec(built.command)?.[1];
      const childId = /PI_SUBAGENT_ID='([^']+)'/.exec(built.command)?.[1];
      const parentActivityFile = getSubagentActivityFile(context.artifactDir, context.params.id);
      assert.equal(childActivityFile, parentActivityFile);
      assert.equal(childId, context.params.id);
      // Use the launch environment, not the parent's expected path, for the child.
      process.env.PI_SUBAGENT_ID = childId;
      process.env.PI_SUBAGENT_ACTIVITY_FILE = childActivityFile;
      process.env.PI_SUBAGENT_AUTO_EXIT = "0";
      // This fixture exercises activity, not the calling agent's control session.
      // Inherited continuation resources must not survive session.dispose().
      delete process.env.PI_SUBAGENT_SESSION;
      delete process.env.PI_SUBAGENT_ASSIGNMENT_FILE;
      const settingsManager = SettingsManager.inMemory({});
      const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager, noSkills: true, noPromptTemplates: true,
        noThemes: true, noContextFiles: true, extensionFactories: [subagentDoneExtension],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager,
        sessionManager: SessionManager.create(dir, dir),
      }));
      const errors: unknown[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      await session.extensionRunner!.emit({
        type: "tool_execution_start", toolCallId: "contract-tool-call", toolName: "read", args: { path: "README.md" },
      });
      const running: any = {
        id: context.params.id, name: "worker", task: context.params.task, cli: "pi",
        surface: "unused", startTime: Date.now(), sessionFile: context.subagentSessionFile,
        interactive: false, activityFile: parentActivityFile,
      };
      parentHarness.observeRunningSubagent(running);
      assert.deepEqual(running.activityRead, { ok: true });
      assert.equal(running.activity.latestEvent, "tool_execution_start");
      assert.equal(running.activity.activeScope, "tool");
      assert.equal(running.activity.toolName, "read");
      assert.equal(running.activity.toolCallId, "contract-tool-call");
      assert.equal(running.lifecycle.turn.kind, "active");
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
});

describe("parallel launch input artifacts", () => {
  for (const systemPromptMode of ["append", "replace"] as const) {
    it(`preserves same-name tasks, ${systemPromptMode} prompts, and assignment cards in the same second`, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T12:00:00.000Z") });
      const artifactDir = mkdtempSync(join(tmpdir(), "parallel-launch-inputs-"));
      try {
        const driver = new PiHarnessDriver();
        const launches = await Promise.all(["run-a", "run-b"].map(async (id) => {
          const context = createMockLaunchContext({
            artifactDir,
            params: { id, name: "Same Worker", task: `TASK_${id}\nExact  whitespace 日本語` },
            taskDelivery: "artifact",
            identityInSystemPrompt: true,
            identity: `SYSTEM_${id}`,
            systemPromptMode,
          });
          const built = driver.buildCommand(context);
          const taskFile = /'@([^']+)'/.exec(built.command)?.[1];
          const systemFile = /--(?:append-system-prompt|system-prompt) '([^']+)'/.exec(built.command)?.[1];
          const assignmentFile = /PI_SUBAGENT_ASSIGNMENT_FILE='([^']+)'/.exec(built.command)?.[1];
          assert.ok(taskFile);
          assert.ok(systemFile);
          assert.ok(assignmentFile);
          return { context, taskFile, systemFile, assignmentFile };
        }));
        for (const field of ["taskFile", "systemFile", "assignmentFile"] as const) {
          assert.notEqual(launches[0][field], launches[1][field]);
        }
        // Read only after both launches have written, as delayed children do.
        for (const { context, taskFile, systemFile, assignmentFile } of launches) {
          assert.ok(taskFile.includes(context.params.id));
          assert.ok(systemFile.includes(context.params.id));
          const assignment = JSON.parse(readFileSync(assignmentFile, "utf8"));
          assert.equal(assignment.task, context.params.task);
          assert.equal(assignment.childId, context.params.id);
          assert.equal(readFileSync(taskFile, "utf8"), `\n\n\n\n${assignment.task}\n\n`);
          assert.equal(readFileSync(systemFile, "utf8"), context.identity);
        }
      } finally {
        rmSync(artifactDir, { recursive: true, force: true });
      }
    });
  }
});

describe("OpenCode Harness Driver", () => {
  const driver = new OpenCodeHarnessDriver();

  it("formats model using provider-qualified model reference", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "claude-3-5-sonnet", model: "anthropic/claude-3-5-sonnet" }),
      "anthropic/claude-3-5-sonnet",
    );
  });

  it("builds correct opencode run command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "anthropic/claude-3-5-sonnet",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "opencode");
    assert.ok(built.command.startsWith("cd '/tmp/project' && opencode run --model 'anthropic/claude-3-5-sonnet'"));
    assert.ok(built.command.includes(`echo '__SUBAGENT_DONE_${ctx.params.id}_'$?'__'`));
  });

  it("extracts output from terminal pane buffer", async () => {
    const result = await driver.extractResult({
      running: {
        id: "1",
        name: "test",
        task: "task",
        surface: "s1",
        startTime: Date.now(),
        sessionFile: "f",
        interactive: false,
      },
      completionResult: { reason: "done", exitCode: 0 },
      surface: "s1",
      readPane: () => "Finished repository inspection!\n__SUBAGENT_DONE_0__\n",
      closePane: () => {},
      artifactDir: "/tmp",
    });

    assert.ok(result);
    assert.equal(result.summary, "Finished repository inspection!");
  });
});

describe("Codex Harness Driver", () => {
  const driver = new CodexHarnessDriver();

  it("formats model using bare modelId", () => {
    assert.equal(
      driver.formatModel({ provider: "openai", modelId: "o3-mini", model: "openai/o3-mini" }),
      "o3-mini",
    );
  });

  it("builds codex command with reasoning effort when supported", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "o3-mini",
      effectiveThinking: "high",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "codex");
    assert.ok(built.command.startsWith("cd '/tmp/project' && codex --model 'o3-mini' --reasoning-effort 'high'"));
    assert.ok(built.command.includes(`echo '__SUBAGENT_DONE_${ctx.params.id}_'$?'__'`));
  });

  it("extracts output from terminal pane buffer", async () => {
    const result = await driver.extractResult(createMockResultContext());
    assert.ok(result);
    assert.equal(result.summary, "Finished repository inspection!");
  });

  it("falls back to an exit-code summary when the pane has no output", async () => {
    const result = await driver.extractResult(createMockResultContext({
      readPane: () => "",
      completionResult: { reason: "done", exitCode: 1 },
    }));
    assert.ok(result);
    assert.equal(result.summary, "Codex exited with code 1");
  });
});

describe("Grok Harness Driver", () => {
  const driver = new GrokHarnessDriver();

  it("formats model using bare modelId", () => {
    assert.equal(
      driver.formatModel({ provider: "xai", modelId: "grok-3", model: "xai/grok-3" }),
      "grok-3",
    );
  });

  it("builds grok execution command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "grok-3",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "grok");
    assert.ok(built.command.startsWith("cd '/tmp/project' && grok --model 'grok-3'"));
    assert.ok(built.command.includes(`echo '__SUBAGENT_DONE_${ctx.params.id}_'$?'__'`));
  });

  it("extracts output from terminal pane buffer", async () => {
    const result = await driver.extractResult(createMockResultContext());
    assert.ok(result);
    assert.equal(result.summary, "Finished repository inspection!");
  });

  it("falls back to an exit-code summary when the pane has no output", async () => {
    const result = await driver.extractResult(createMockResultContext({
      readPane: () => "",
      completionResult: { reason: "done", exitCode: 1 },
    }));
    assert.ok(result);
    assert.equal(result.summary, "Grok exited with code 1");
  });
});

describe("Claude Harness Driver", () => {
  const driver = new ClaudeHarnessDriver();

  it("formats model using bare modelId / alias", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "opus", model: "anthropic/opus" }),
      "opus",
    );
  });

  it("passes explicit autonomous completion mode, including resumed sessions", () => {
    const built = driver.buildCommand(createMockLaunchContext({
      params: { id: "abc12345", name: "worker", task: "Follow-up", resumeSessionId: "previous-session" },
      effectiveAutoExit: true,
    }));
    assert.match(built.command, /PI_CLAUDE_AUTO_EXIT=1 claude/);
    assert.match(built.command, /--resume 'previous-session'/);
  });

  it("disables Stop completion for non-auto-exit sessions", () => {
    const built = driver.buildCommand(createMockLaunchContext({ effectiveAutoExit: false }));
    assert.match(built.command, /PI_CLAUDE_AUTO_EXIT=0 claude/);
  });

  it("does not confuse status-notification preferences with completion mode", () => {
    const built = driver.buildCommand(createMockLaunchContext({ effectiveAutoExit: true, effectiveInteractive: true }));
    assert.match(built.command, /PI_CLAUDE_AUTO_EXIT=1 claude/);
  });

  it("rejects thinking-level overrides for Claude CLI subagents", () => {
    assert.throws(
      () => driver.validateRuntimePlan({
        provider: "anthropic",
        modelId: "sonnet",
        model: "anthropic/sonnet",
        thinking: "high",
        modelSource: "request",
        thinkingSource: "request",
      }, "medium"),
      /Thinking-level overrides are not supported for Claude CLI subagents/,
    );
  });

  it("allows inherited parent thinking for Claude CLI subagents", () => {
    assert.doesNotThrow(() => driver.validateRuntimePlan({
      provider: "anthropic",
      modelId: "sonnet",
      model: "anthropic/sonnet",
      thinking: "medium",
      modelSource: "request",
      thinkingSource: "parent",
    }, "medium"));
  });

  it("prefers the sentinel file over the terminal pane when both are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-sentinel-test-"));
    const sentinelFile = join(dir, "sentinel");
    writeFileSync(sentinelFile, "Sentinel-reported summary\n");
    try {
      const result = await driver.extractResult(createMockResultContext({
        running: {
          id: "1",
          name: "test",
          task: "task",
          surface: "s1",
          startTime: Date.now(),
          sessionFile: "f",
          interactive: false,
          sentinelFile,
        },
      }));
      assert.ok(result);
      assert.equal(result.summary, "Sentinel-reported summary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the terminal pane when no sentinel file is present", async () => {
    const result = await driver.extractResult(createMockResultContext());
    assert.ok(result);
    assert.equal(result.summary, "Finished repository inspection!");
  });

  it("falls back to an exit-code summary when neither sentinel nor pane have output", async () => {
    const result = await driver.extractResult(createMockResultContext({
      readPane: () => "",
      completionResult: { reason: "done", exitCode: 1 },
    }));
    assert.ok(result);
    assert.equal(result.summary, "Claude Code exited with code 1");
  });
});

describe("Generic Harness Driver & Templates", () => {
  it("interpolates commandTemplate variables", () => {
    const driver = new GenericHarnessDriver("custom");
    const ctx = createMockLaunchContext({
      effectiveModel: "gemini-2.5-pro",
      effectiveCwd: "/workspace/my-app",
      agentDefs: {
        name: "custom",
        commandTemplate: "gemini run --model {model} --prompt {task} --dir {cwd}",
      },
    });

    const built = driver.buildCommand(ctx);
    assert.ok(built.command.includes("gemini run --model 'gemini-2.5-pro' --prompt 'Analyze the repository structure' --dir '/workspace/my-app'"));
    assert.ok(built.command.includes(`echo '__SUBAGENT_DONE_${ctx.params.id}_'$?'__'`));
  });

  it("falls back to bare binary execution when no commandTemplate is provided", () => {
    const driver = new GenericHarnessDriver("aider");
    const ctx = createMockLaunchContext({
      effectiveModel: "gpt-4o",
    });

    const built = driver.buildCommand(ctx);
    assert.ok(built.command.startsWith("cd '/tmp/project' && aider --model 'gpt-4o'"));
  });

  it("inserts $$ and $& in task text literally instead of as replace-pattern syntax", () => {
    const driver = new GenericHarnessDriver("custom");
    const ctx = createMockLaunchContext({
      effectiveModel: "gemini-2.5-pro",
      params: {
        id: "abc12345",
        name: "worker",
        task: "use $$ for the current PID and $& for the whole match",
      },
      agentDefs: {
        name: "custom",
        commandTemplate: "gemini run --prompt {task}",
      },
    });

    const built = driver.buildCommand(ctx);
    assert.ok(
      built.command.includes("use $$ for the current PID and $& for the whole match"),
      `expected literal $$ and $& in: ${built.command}`,
    );
  });

  it("extracts output from terminal pane buffer using the driver's display name", async () => {
    const driver = new GenericHarnessDriver("aider");
    const result = await driver.extractResult(createMockResultContext({
      readPane: () => "",
      completionResult: { reason: "done", exitCode: 1 },
    }));
    assert.ok(result);
    assert.equal(result.summary, "aider exited with code 1");
  });
});

describe("external harness role composition", () => {
  for (const cli of ["claude", "opencode", "codex", "grok", "custom", "custom-template"]) {
    it(`${cli} delivers the named body and explicit instructions once each`, () => {
      const context = createMockLaunchContext({
        params: { id: "role-run", name: "Role", task: "ROLE_TASK", systemPrompt: "EXPLICIT_INSTRUCTIONS" },
        agentDefs: { name: "Named", body: "NAMED_INSTRUCTIONS",
          ...(cli === "custom-template" ? { commandTemplate: "custom {task}" } : {}) },
        inheritsConversationContext: false,
        roleBlock: "NAMED_INSTRUCTIONS\n\nEXPLICIT_INSTRUCTIONS",
      });
      const command = getHarnessDriver(cli).buildCommand(context).command;
      assert.equal(command.split("NAMED_INSTRUCTIONS").length - 1, 1);
      assert.equal(command.split("EXPLICIT_INSTRUCTIONS").length - 1, 1);
      assert.ok(command.indexOf("NAMED_INSTRUCTIONS") < command.indexOf("EXPLICIT_INSTRUCTIONS"));
    });
  }
});

describe("run-bound harness completion", () => {
  for (const cli of ["pi", "claude", "codex", "opencode", "grok", "custom"]) {
    it(`${cli} emits only its run-qualified shell trailer`, () => {
      const ctx = createMockLaunchContext();
      const built = getHarnessDriver(cli).buildCommand(ctx);
      assert.ok(built.command.includes(`echo '__SUBAGENT_DONE_${ctx.params.id}_'$?'__'`));
      assert.ok(!built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
    });
  }
});
