import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerInitialSkills, INITIAL_SKILLS_ENV } from "../pi-extension/subagents/initial-skills.ts";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";
import type { SubagentLaunchContext } from "../pi-extension/subagents/harness/types.ts";
import { withChildSession } from "./child-session.ts";
const cliRoot = new URL("./cli/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { processFileArguments } = await import(new URL("file-processor.js", cliRoot).href);
const { buildInitialMessage } = await import(new URL("initial-message.js", cliRoot).href);
const { parseArgs } = await import(new URL("args.js", cliRoot).href);

for (const fault of ["EACCES", "EIO", "malformed-header"]) {
  test(`startup session validation ${fault} blocks input without consuming required skills; explicit retry recovers`, () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-validation-"));
    const file = join(dir, "session.jsonl"), skill = join(dir, "SKILL.md");
    const keys = ["PI_SUBAGENT_SESSION", INITIAL_SKILLS_ENV];
    const prior = keys.map(key => process.env[key]);
    process.env.PI_SUBAGENT_SESSION = file; process.env[INITIAL_SKILLS_ENV] = "required";
    writeFileSync(file, fault === "malformed-header" ? "{" : '{"type":"session","id":"skills","version":3}\n');
    writeFileSync(skill, "REQUIRED_INSTRUCTIONS");
    let failing = true, commands = 0, input: any;
    const errors: string[] = [];
    const ctx: any = { sessionManager: { getSessionFile: () => {
      if (failing && fault !== "malformed-header") throw Object.assign(new Error(fault), { code: fault });
      return file;
    }, getHeader: () => ({ id: "skills" }) }, shutdown: () => assert.fail("validation failure cannot close the child") };
    try {
      registerInitialSkills({ on: (_name: string, fn: any) => { input = fn; }, getCommands: () => {
        commands++; return [{ source: "skill", name: "skill:required", sourceInfo: { path: skill } }];
      } } as any, error => errors.push(error));
      assert.deepEqual(input({ text: "TASK" }, ctx), { action: "handled" });
      assert.equal(commands, 0, "unvalidated input cannot bypass required instructions");
      assert.equal(errors.length, 1);
      failing = false; writeFileSync(file, '{"type":"session","id":"skills","version":3}\n');
      const retried = input({ text: "TASK" }, ctx);
      assert.equal(retried.action, "transform");
      assert.match(retried.text, /REQUIRED_INSTRUCTIONS[\s\S]*TASK/);
    } finally {
      keys.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const taskDelivery of ["direct", "artifact"] as const) {
  test(`${taskDelivery}: first model request has complete task and two required skills before auto-exit`, async () => {
    await withChildSession({ skills: "first, second, first" }, async ({ session, dir, requests, shutdowns }) => {
      const task = "ACTUAL_TASK with spaces and Unicode 日本語";
      const context: SubagentLaunchContext = {
        params: { id: "skills-run", name: "Skills worker", task, skills: "first,second" },
        runtimePlan: { provider: "child-test", modelId: "model", model: "child-test/model", thinking: "off", modelSource: "request", thinkingSource: "request" },
        parentThinking: "off", surface: "mock-pane", artifactDir: dir, sessionDir: dir,
        subagentSessionFile: join(dir, "skills.jsonl"), effectiveCwd: dir, localAgentDir: dir,
        effectiveAutoExit: true, effectiveInteractive: false,
        inheritsConversationContext: taskDelivery === "direct", taskDelivery, subagentsDir: dir,
        shellQuote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
      };
      const { command } = new PiHarnessDriver().buildCommand(context);
      const path = /'@([^']+)'/.exec(command)?.[1];
      assert.ok(path, "both delivery modes use one controlled artifact");
      const parsed = parseArgs([`@${path}`]);
      const files = await processFileArguments(parsed.fileArgs);
      const initial = buildInitialMessage({ parsed, fileText: files.text, fileImages: files.images });
      assert.deepEqual(parsed.messages, [], "no deferred CLI turns");
      await session.prompt(initial.initialMessage!);
      assert.equal(requests.length, 1);
      const content = JSON.stringify(requests[0].messages.filter((message: any) => message.role === "user"));
      for (const expected of [task, "REQUIRED_FIRST_INSTRUCTIONS", "REQUIRED_SECOND_INSTRUCTIONS", "References are relative to"]) {
        assert.ok(content.includes(expected), expected);
      }
      assert.equal(content.split("REQUIRED_FIRST_INSTRUCTIONS").length - 1, 1);
      assert.equal(shutdowns(), 1, "auto-exit only after processing the complete first task");
    });
  });
}

test("missing required skill handles input without running an incomplete assignment", async () => {
  await withChildSession({ skills: "first,missing" }, async ({ session, requests, shutdowns }) => {
    await session.prompt("must not run unqualified");
    assert.equal(requests.length, 0);
    assert.equal(shutdowns(), 1);
  });
});

test("skills are not re-expanded into later keepOpen prompts", async () => {
  await withChildSession({ skills: "first,second" }, async ({ session, requests }) => {
    await session.prompt("initial task");
    await session.prompt("follow-up task");
    const users = requests[1].messages.filter((message: any) => message.role === "user");
    assert.doesNotMatch(JSON.stringify(users.at(-1)), /REQUIRED_FIRST|REQUIRED_SECOND/);
  });
});
