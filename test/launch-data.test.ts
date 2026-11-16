import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getHarnessDriver, type SubagentLaunchContext } from "../pi-extension/subagents/harness/index.ts";
import { resumeLaunchContext, resolveLaunchProfile } from "../pi-extension/subagents/launch-profile.ts";
import { withChildSession } from "./child-session.ts";
import { continueLiveChild } from "../pi-extension/subagents/live-continuation.ts";
import { createLifecycle, markProcessRunning } from "../pi-extension/subagents/lifecycle.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";

const cliRoot = new URL("./cli/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { parseArgs } = await import(new URL("args.js", cliRoot).href);
const { processFileArguments } = await import(new URL("file-processor.js", cliRoot).href);
const { buildInitialMessage } = await import(new URL("initial-message.js", cliRoot).href);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function context(dir: string): SubagentLaunchContext {
  return {
    params: { id: "data-run", name: "worker", task: "TASK" },
    runtimePlan: { provider: "child-test", modelId: "model", model: "child-test/model", thinking: "off", modelSource: "request", thinkingSource: "request" },
    effectiveModel: "child-test/model", effectiveThinking: "off", parentThinking: "off",
    surface: "test-pane", artifactDir: dir, sessionDir: dir, subagentSessionFile: join(dir, "child.jsonl"),
    effectiveCwd: dir, localAgentDir: dir, effectiveAutoExit: true, effectiveInteractive: false,
    inheritsConversationContext: true, taskDelivery: "direct", subagentsDir: dir, shellQuote: quote,
  };
}

// Only execute commands against a private argument-capture function. Tests first
// assert the expected quoting; broken payloads are never executed, even offline.
function capture(dir: string, command: string, binary = "pi"): string[] {
  const path = join(dir, "capture.cjs");
  const output = join(dir, "args.json");
  writeFileSync(path, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  execFileSync("bash", ["-c", `${binary}() { node ${quote(path)} "$@"; }; ${command}`], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, BASH_ENV: "", ENV: "" },
  });
  return JSON.parse(readFileSync(output, "utf8"));
}

for (const cli of ["pi", "claude", "codex", "grok", "opencode", "custom"]) {
  test(`${cli}: every physical metadata line is a comment, including resume`, () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-comments-"));
    try {
      for (const resume of [false, true]) {
        const ctx = context(dir);
        ctx.resume = resume;
        ctx.params.name = "Worker\nprintf AUDIT_MARKER\r# tail\r\nlast";
        ctx.surface = "pane\r\nSURFACE_DATA";
        ctx.subagentSessionFile = join(dir, "child\nSESSION_DATA.jsonl");
        ctx.runtimePlan.model = "provider/model\nRUNTIME_DATA";
        const built = getHarnessDriver(cli).buildCommand(ctx);
        const lines = built.launchScriptPreamble!.join("\n").split(/\r\n|\r|\n/);
        assert.ok(lines.every((line) => line.startsWith("#")), JSON.stringify(lines));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("generic templates expand only original placeholders, never values", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-template-"));
  try {
    const ctx = context(dir);
    ctx.effectiveModel = "{task} model ' $& 日本語";
    ctx.effectiveCwd = join(dir, "{model} {task} {prompt} {cwd} {name} {id} cwd ' $ 日本語");
    ctx.params.task = "{name} {cwd} {prompt} {id} task ' \" $& $$\n; text";
    ctx.params.name = "{id} x; printf AUDIT_TEMPLATE; echo ";
    ctx.params.id = "{model} id ' $";
    ctx.agentDefs = { name: "custom", commandTemplate: "custom {model} {task} {prompt} {cwd} {name} {id} {unknown}" };
    const built = getHarnessDriver("custom").buildCommand(ctx);
    const expectedBody = `custom ${[ctx.effectiveModel, ctx.params.task, ctx.params.task, ctx.effectiveCwd, ctx.params.name, ctx.params.id].map(quote).join(" ")} {unknown}`;
    assert.ok(built.command.includes(expectedBody), built.command);
    // The run-id trailer has a separate generated-ID contract; this fixture's
    // deliberately non-ID value must not be executed as a shell sentinel.
    const args = capture(dir, `cd ${quote(dir)} && ${expectedBody}`, "custom");
    assert.deepEqual(args, [ctx.effectiveModel, ctx.params.task, ctx.params.task, ctx.effectiveCwd, ctx.params.name, ctx.params.id, "{unknown}"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["standalone", "lineage-only", "fork", "closed-resume"] as const) {
  for (const task of ["--approve", "--no-session", "@/must-not-be-read/private-file", "'\" $& $$ {name}; 日本語\nsecond line"]) {
    test(`${mode}: Pi delivers ${JSON.stringify(task)} through one controlled input`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "launch-cli-data-"));
      try {
        let ctx = context(dir);
        ctx.params.task = task;
        ctx.inheritsConversationContext = mode === "fork" || mode === "closed-resume";
        ctx.taskDelivery = ctx.inheritsConversationContext ? "direct" : "artifact";
        if (mode === "closed-resume") {
          const profile = resolveLaunchProfile(ctx, "pi", null);
          ctx = resumeLaunchContext(profile, { id: "resume-data", name: "Resume\nNAME_DATA", message: task,
            surface: "test-pane", artifactDir: dir, subagentsDir: dir, shellQuote: quote });
        }
        const built = getHarnessDriver("pi").buildCommand(ctx);
        assert.ok(!built.command.includes(quote(task)), "task must not be an option, file reference or executable shell argument");
        const args = capture(dir, built.command);
        const parsed = parseArgs(args);
        assert.equal(parsed.projectTrustOverride, undefined);
        assert.equal(parsed.noSession, undefined);
        assert.equal(parsed.session, ctx.subagentSessionFile);
        assert.deepEqual(parsed.messages, [], "no startup or deferred positional turns");
        assert.equal(parsed.fileArgs.length, 1);
        assert.ok(parsed.fileArgs[0].startsWith(dir), "only the generated artifact is read");
        assert.ok(readFileSync(parsed.fileArgs[0], "utf8").includes(task));
        const files = await processFileArguments(parsed.fileArgs);
        const initial = buildInitialMessage({ parsed, fileText: files.text, fileImages: files.images });
        await withChildSession({}, async ({ session, requests }) => {
          await session.prompt(initial.initialMessage!);
          assert.equal(requests.length, 1);
          const latest = requests[0].messages.filter((message: any) => message.role === "user").at(-1);
          const text = typeof latest.content === "string" ? latest.content : latest.content.map((block: any) => block.text ?? "").join("");
          assert.ok(text.includes(task));
        });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test("live resume keeps CLI-like text literal and retains role/skills without a bootstrap turn", async () => {
  await withChildSession({ liveContinuation: true, autoExit: false, skills: "first,second", systemPrompt: "LIVE_ROLE_INSTRUCTIONS" }, async ({ session, requests }) => {
    await session.prompt("INITIAL_LIVE_TASK");
    const id = process.env.PI_SUBAGENT_ID!;
    const child = { id, name: "Live worker", cli: "pi", surface: "mock-only-pane",
      sessionFile: canonicalSessionPath(session.sessionFile!), activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE!,
      lifecycle: { ...markProcessRunning(createLifecycle(1), 2), turn: { kind: "waiting" as const, startedAt: 3 } },
      hasTurnResult: true };
    const owner = { runId: id, dispatched: true, surface: child.surface };
    const task = "--approve\n--no-session\n@/must-not-be-read/private-file\n'\" $ {name}; 日本語";
    const result = await continueLiveChild(owner, child, { message: task }, {
      inspect: async () => ({ kind: "present", observedAt: Date.now(), agentStatus: "idle" }), timeoutMs: 2000,
    });
    assert.equal(result.status, "accepted");
    const deadline = Date.now() + 2000;
    while (requests.length < 2 || !session.isIdle) {
      assert.ok(Date.now() < deadline, "continuation failed to settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 2, "exactly one request for the initial task and one for continuation");
    const users = requests[1].messages.filter((message: any) => message.role === "user");
    assert.deepEqual(users.at(-1).content, [{ type: "text", text: task }]);
    const transcript = JSON.stringify(requests[1].messages);
    for (const text of ["LIVE_ROLE_INSTRUCTIONS", "REQUIRED_FIRST_INSTRUCTIONS", "REQUIRED_SECOND_INSTRUCTIONS"]) {
      assert.equal(transcript.split(text).length - 1, 1, text);
    }
  });
});
