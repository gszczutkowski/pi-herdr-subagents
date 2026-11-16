import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { withChildSession } from "./child-session.ts";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";
import { readPiLaunchProfile, resumeLaunchContext } from "../pi-extension/subagents/launch-profile.ts";

// Exercise the real parent launch path and child CLI parser/SDK context. Only
// pane creation/dispatch is replaced; no terminal, provider or global config.
mock.method(childProcess, "execSync", () => "herdr");
mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => args[0] === "tab" && args[1] === "create"
  ? JSON.stringify({ result: { root_pane: { pane_id: "role-test-pane" } } }) : "");
syncBuiltinESMExports();
const { __test__ } = await import("../pi-extension/subagents/index.ts");
const { releaseSession } = await import("../pi-extension/subagents/ownership.ts");
const cliRoot = new URL("./cli/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { parseArgs } = await import(new URL("args.js", cliRoot).href);
const { processFileArguments } = await import(new URL("file-processor.js", cliRoot).href);
const { buildInitialMessage } = await import(new URL("initial-message.js", cliRoot).href);
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });

const cases = [
  { name: "named task role", extra: false },
  { name: "named task role plus explicit instructions", extra: true },
  { name: "named append role", mode: "append", extra: false },
  { name: "named append role plus explicit instructions", mode: "append", extra: true },
  { name: "named replace role", mode: "replace", extra: false },
  { name: "named replace role plus explicit instructions", mode: "replace", extra: true },
  { name: "bare explicit instructions", bare: true, extra: true },
];
for (const sessionMode of ["standalone", "lineage-only", "fork"] as const) {
  for (const item of cases) {
    test(`native role delivery: ${sessionMode}, ${item.bare && sessionMode === "lineage-only" ? "empty-body named role plus explicit instructions" : item.name}`,  async () => {
      const dir = mkdtempSync(join(tmpdir(), "role-delivery-"));
      const env = { ...process.env };
      let child: any;
      try {
        const agentDir = join(dir, "agent");
        mkdirSync(join(agentDir, "agents"), { recursive: true });
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.HERDR_ENV = "1";
        process.env.HERDR_WORKSPACE_ID = "test";
        process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
        for (const key of ["PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]) delete process.env[key];
        writeFileSync(join(agentDir, "agents", "role-regression.md"), `---\nname: role-regression\nsession-mode: ${sessionMode}\n${item.mode ? `system-prompt: ${item.mode}\n` : ""}---\n${item.bare ? "" : "NAMED_ROLE_INSTRUCTIONS"}`);
        const manager = SessionManager.create(dir, dir);
        manager.appendMessage({ role: "user", content: "PARENT_HISTORY", timestamp: 1 });
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "parent context" }], stopReason: "stop", timestamp: 2 } as any);
        manager.appendMessage({ role: "user", content: "Delegating turn", timestamp: 3 });
        const params = { name: "Role worker", task: "ACTUAL_ROLE_TASK", agent: item.bare && sessionMode !== "lineage-only" ? undefined : "role-regression",
          systemPrompt: item.extra ? "EXPLICIT_ROLE_INSTRUCTIONS" : undefined, cwd: dir,
          fork: sessionMode === "fork", model: "child-test/model", skills: "first,second" };
        // The parent host is a minimal adapter (no durable custody claim); the
        // branch and seeded child still come from the real native manager.
        const ctx: any = { cwd: dir, sessionManager: {
          getSessionFile: () => manager.getSessionFile(), getSessionId: () => manager.getSessionId(),
          getSessionDir: () => manager.getSessionDir(), getBranch: () => manager.getBranch(),
        }, model: { provider: "child-test", id: "model" },
          modelRegistry: { find: () => ({ provider: "child-test", id: "model", reasoning: false }),
            getAvailable: () => [{ provider: "child-test", id: "model" }], hasConfiguredAuth: () => true } };
        child = await __test__.launchSubagent(params, ctx, "off");
        const script = readFileSync(child.launchScriptFile, "utf8");
        const invocation = /\bpi ((?:--no-approve )?--session [\s\S]*?); echo /.exec(script)?.[1];
        assert.ok(invocation, "actual generated launch script contains Pi invocation");
        // This fixture deliberately has no apostrophes in payload/path tokens.
        const tokens = [...invocation.matchAll(/'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2]);
        const parsed = parseArgs(tokens);
        const files = await processFileArguments(parsed.fileArgs);
        const initial = buildInitialMessage({ parsed, fileText: files.text, fileImages: files.images });
        assert.deepEqual(initial.otherMessages ?? [], []);
        const appended = parsed.appendSystemPrompt?.map((path: string) => readFileSync(path, "utf8")).join("\n\n");
        const skills = /PI_SUBAGENT_INITIAL_SKILLS='([^']*)'/.exec(script)?.[1];
        assert.equal(skills, "first,second");
        await withChildSession({ skills, sessionFile: child.sessionFile, systemPrompt: parsed.systemPrompt, appendSystemPrompt: appended }, async ({ session, requests }) => {
          await session.prompt(initial.initialMessage!);
          assert.equal(requests.length, 1);
          const request = requests[0];
          const transcript = JSON.stringify(request.messages);
          for (const [text, expected] of [["ACTUAL_ROLE_TASK", 1], ["NAMED_ROLE_INSTRUCTIONS", item.bare ? 0 : 1],
            ["EXPLICIT_ROLE_INSTRUCTIONS", item.extra ? 1 : 0]] as const) {
            assert.equal(transcript.split(text).length - 1, expected, text);
          }
          if (!item.bare && item.mode) {
            const system = getCurrentSystemPrompt(request.messages);
            assert.match(system, /NAMED_ROLE_INSTRUCTIONS/);
            if (item.extra) assert.ok(system.indexOf("NAMED_ROLE_INSTRUCTIONS") < system.indexOf("EXPLICIT_ROLE_INSTRUCTIONS"));
          } else {
            const users = JSON.stringify(request.messages.filter((message: any) => message.role === "user"));
            assert.match(users, item.bare ? /EXPLICIT_ROLE_INSTRUCTIONS/ : /NAMED_ROLE_INSTRUCTIONS/);
          }
          for (const name of ["FIRST", "SECOND"]) assert.equal(transcript.split(`REQUIRED_${name}_INSTRUCTIONS`).length - 1, 1);
          if (sessionMode === "fork") assert.match(transcript, /PARENT_HISTORY/);
        });
        // Reopen the actual persisted child branch. Saved role configuration and
        // already-expanded skills survive; only the new message starts a turn.
        const resumed = resumeLaunchContext(readPiLaunchProfile(child.sessionFile), {
          id: "closed-role-run", name: "Closed worker", message: "--no-session", surface: "mock-resume-pane",
          artifactDir: dir, subagentsDir: dir, shellQuote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
        });
        const resumeCommand = new PiHarnessDriver().buildCommand(resumed).command;
        assert.match(resumeCommand, /PI_SUBAGENT_INITIAL_SKILLS=''/);
        const resumeInvocation = /\bpi ((?:--no-approve )?--session [\s\S]*?); echo /.exec(resumeCommand)?.[1];
        assert.ok(resumeInvocation);
        const resumeTokens = [...resumeInvocation.matchAll(/'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2]);
        const resumeParsed = parseArgs(resumeTokens);
        assert.equal(resumeParsed.noSession, undefined);
        assert.equal(resumeParsed.fileArgs.length, 1);
        const resumeFiles = await processFileArguments(resumeParsed.fileArgs);
        const resumeInitial = buildInitialMessage({ parsed: resumeParsed, fileText: resumeFiles.text, fileImages: resumeFiles.images });
        const resumeAppend = resumeParsed.appendSystemPrompt?.map((path: string) => readFileSync(path, "utf8")).join("\n\n");
        await withChildSession({ sessionFile: child.sessionFile, systemPrompt: resumeParsed.systemPrompt, appendSystemPrompt: resumeAppend }, async ({ session, requests }) => {
          await session.prompt(resumeInitial.initialMessage!);
          assert.equal(requests.length, 1, "closed resume has no bootstrap model turn");
          const messages = requests[0].messages;
          const transcript = JSON.stringify(messages);
          const users = messages.filter((message: any) => message.role === "user");
          assert.match(JSON.stringify(users.at(-1)), /--no-session/);
          assert.doesNotMatch(JSON.stringify(users.at(-1)), /ACTUAL_ROLE_TASK|REQUIRED_FIRST|REQUIRED_SECOND/);
          for (const [text, expected] of [["ACTUAL_ROLE_TASK", 1], ["NAMED_ROLE_INSTRUCTIONS", item.bare ? 0 : 1],
            ["EXPLICIT_ROLE_INSTRUCTIONS", item.extra ? 1 : 0], ["REQUIRED_FIRST_INSTRUCTIONS", 1], ["REQUIRED_SECOND_INSTRUCTIONS", 1]] as const) {
            assert.equal(transcript.split(text).length - 1, expected, `closed resume: ${text}`);
          }
          if (sessionMode === "fork") assert.match(transcript, /PARENT_HISTORY/);
        });
        const profile = JSON.parse(readFileSync(`${child.sessionFile}.launch-profile.json`, "utf8"));
        assert.equal(profile.taskDelivery, sessionMode === "fork" ? "direct" : "artifact");
        assert.equal(profile.identity, [item.bare ? null : "NAMED_ROLE_INSTRUCTIONS", item.extra ? "EXPLICIT_ROLE_INSTRUCTIONS" : null].filter(Boolean).join("\n\n"));
      } finally {
        if (child) { __test__.runningSubagents.delete(child.id); releaseSession(child.sessionFile, child.id); }
        for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
        Object.assign(process.env, env);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
