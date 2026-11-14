import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { __test__ as parent } from "../pi-extension/subagents/index.ts";
import { getHarnessDriver, validateHarnessLaunch } from "../pi-extension/subagents/harness/index.ts";

/** Exercise the real launch path, replacing only the external terminal transport. */
async function withLaunchFixture(run: (fixture: {
  root: string;
  calls: string[][];
  launch: (cli: string, mode: string, extra?: Record<string, unknown>) => Promise<any>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "harness-capabilities-"));
  const previousCwd = process.cwd();
  const envNames = ["PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_SUBAGENT_SHELL_READY_DELAY_MS", "PI_SUBAGENT_LAYOUT"];
  const previousEnv = envNames.map((name) => process.env[name]);
  const originalExec = childProcess.execFileSync;
  const originalExecSync = childProcess.execSync;
  const calls: string[][] = [];
  try {
    mkdirSync(join(root, "agents"));
    process.chdir(root);
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "test-workspace";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    process.env.PI_SUBAGENT_LAYOUT = "tab";
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HC_TERMINAL_SOCKET;
    childProcess.execFileSync = ((command: string, args: string[] = []) => {
      calls.push([command, ...args]);
      return JSON.stringify({ result: { root_pane: { pane_id: "test-pane" } } });
    }) as typeof originalExec;
    childProcess.execSync = (() => "") as typeof originalExecSync;
    syncBuiltinESMExports();
    const parentFile = join(root, "parent.jsonl");
    writeFileSync(parentFile, [
      { type: "session", version: 3, id: "parent", cwd: root, timestamp: new Date().toISOString() },
      { type: "message", id: "history", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "INHERITED_HISTORY", timestamp: Date.now() } },
      { type: "message", id: "kickoff", parentId: "history", timestamp: new Date().toISOString(), message: { role: "user", content: "CURRENT_KICKOFF", timestamp: Date.now() } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const model = { provider: "fake", id: "parent", reasoning: true };
    const ctx = {
      cwd: root, model,
      modelRegistry: { find: () => model, getAvailable: () => [model], getAll: () => [model], hasConfiguredAuth: () => true },
      sessionManager: { getSessionFile: () => parentFile, getSessionId: () => "parent", getSessionDir: () => join(root, "parent-sessions") },
    };
    await run({ root, calls, launch: async (cli, mode, extra = {}) => {
      const name = `test-${cli}-${mode}`;
      writeFileSync(join(root, "agents", `${name}.md`), `---\nname: ${name}\ncli: ${cli}\nsession-mode: ${mode}\n---\nTest role\n`);
      return parent.launchSubagent({ name, agent: name, task: "CHILD_TASK", ...extra }, ctx, "medium");
    } });
  } finally {
    childProcess.execFileSync = originalExec;
    childProcess.execSync = originalExecSync;
    syncBuiltinESMExports();
    for (const [id, running] of parent.runningSubagents) {
      if (running.surface === "test-pane") parent.runningSubagents.delete(id);
    }
    process.chdir(previousCwd);
    envNames.forEach((name, index) => {
      if (previousEnv[index] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[index];
    });
    rmSync(root, { recursive: true, force: true });
  }
}

describe("harness launch capability contract", () => {
  it("rejects all unsupported modes and native resumes without terminal calls or session artifacts", async () => {
    await withLaunchFixture(async ({ root, calls, launch }) => {
      for (const cli of ["claude", "codex", "opencode", "grok", "aider"]) {
        for (const mode of ["lineage-only", "fork"]) {
          await assert.rejects(launch(cli, mode), /does not support session mode/);
        }
        await assert.rejects(launch(cli, "standalone", { fork: true }), /does not support session mode "fork"/);
      }
      for (const cli of ["pi", "codex", "grok", "aider"]) {
        await assert.rejects(launch(cli, "standalone", { resumeSessionId: "native-id" }), /does not support resumeSessionId/);
      }
      assert.deepEqual(calls, [], "even terminal availability probes must not run");
      assert.equal(existsSync(join(root, "sessions")), false);
      assert.equal(existsSync(join(root, "parent-sessions")), false);
      assert.equal(parent.runningSubagents.size, 0);
      assert.deepEqual(readdirSync(root).sort(), ["agents", "parent.jsonl"]);
    });
  });

  it("launches Pi with the exact seeded session it can consume, and only fork inherits messages", async () => {
    await withLaunchFixture(async ({ root, calls, launch }) => {
      for (const mode of ["standalone", "lineage-only", "fork"]) {
        const running = await launch("pi", mode);
        const script = readFileSync(running.launchScriptFile, "utf8");
        assert.ok(script.includes(`pi --session '${running.sessionFile}'`));
        if (mode === "standalone") {
          assert.equal(existsSync(running.sessionFile), false, "fresh Pi session is created by the child");
        } else {
          // Load with the actual SDK session reader used by the Pi CLI, not a JSON-only mock.
          const session = SessionManager.open(running.sessionFile);
          assert.equal(session.getHeader()?.parentSession, join(root, "parent.jsonl"));
          const messages = session.getBranch().filter((entry) => entry.type === "message");
          assert.equal(messages.length, mode === "fork" ? 1 : 0);
          assert.equal(JSON.stringify(messages).includes("INHERITED_HISTORY"), mode === "fork");
          assert.equal(JSON.stringify(messages).includes("CURRENT_KICKOFF"), false);
        }
        assert.equal(script.includes("'@"), mode !== "fork", "blank contexts use artifact-backed task delivery");
        assert.ok(script.includes("CHILD_TASK") || script.includes("'@"));
      }
      assert.equal(calls.filter((call) => call[0] === "herdr" && call[1] === "tab" && call[2] === "create").length, 3);
    });
  });

  it("supports standalone foreign harnesses and forwards supported native session identifiers", async () => {
    await withLaunchFixture(async ({ calls, launch }) => {
      for (const cli of ["claude", "codex", "opencode", "grok", "aider"]) {
        const nativeResume = ["claude", "opencode"].includes(cli);
        const running = await launch(cli, "standalone", nativeResume ? { resumeSessionId: "native-session" } : {});
        const script = readFileSync(running.launchScriptFile, "utf8");
        assert.equal(existsSync(running.sessionFile), false, "no unused seeded Pi JSONL");
        assert.ok(script.includes("CHILD_TASK"));
        assert.equal(script.includes("native-session"), nativeResume);
        if (nativeResume) assert.ok(script.includes(`${cli === "claude" ? "--resume" : "--session"} 'native-session'`));
        assert.equal(script.includes("INHERITED_HISTORY"), false);
      }
      assert.equal(calls.filter((call) => call[1] === "tab" && call[2] === "create").length, 5);
    });
  });

  it("fails closed for undeclared custom capabilities and incompatible native transfer", () => {
    const legacy = Object.assign(Object.create(getHarnessDriver("codex")), { supportedSessionModes: undefined });
    assert.doesNotThrow(() => validateHarnessLaunch(legacy, "standalone"));
    assert.throws(() => validateHarnessLaunch(legacy, "fork"), /does not support session mode/);
    const futureDriver = Object.assign(Object.create(getHarnessDriver("pi")), { supportsNativeResume: true });
    assert.throws(() => validateHarnessLaunch(futureDriver, "fork", "native"), /cannot be combined/);
  });
});
