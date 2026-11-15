import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPiPromptArgs } from "../pi-extension/subagents/harness/drivers/pi.ts";
import { withChildSession } from "./child-session.ts";
const cliRoot = new URL("./cli/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { processFileArguments } = await import(new URL("file-processor.js", cliRoot).href);
const { buildInitialMessage } = await import(new URL("initial-message.js", cliRoot).href);
const { parseArgs } = await import(new URL("args.js", cliRoot).href);

for (const taskDelivery of ["direct", "artifact"] as const) {
  test(`${taskDelivery}: first model request has complete task and two required skills before auto-exit`, async () => {
    await withChildSession({ skills: "first, second, first" }, async ({ session, dir, requests, shutdowns }) => {
      const task = "ACTUAL_TASK with spaces and Unicode 日本語";
      const path = join(dir, "task with spaces.md");
      writeFileSync(path, task);
      const args = buildPiPromptArgs({ effectiveSkills: "first,second", taskDelivery,
        taskArg: taskDelivery === "artifact" ? `@${path}` : task });
      const parsed = parseArgs(args);
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
