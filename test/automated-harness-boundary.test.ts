import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeFixture } from "./automated-boundary-fixture.ts";
import * as plan from "../pi-extension/subagents/plan-store.ts";
import { __test__ as parent } from "../pi-extension/subagents/index.ts";
import { getHarnessDriver } from "../pi-extension/subagents/harness/index.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { createDeliveryState, enqueueDelivery } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { reconcileRuntime } from "../pi-extension/subagents/runtime-recovery.ts";
import { releaseSession } from "../pi-extension/subagents/ownership.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";

test("actual foreign launch rejects native context before side effects; text recovery remains review-only", async () => {
  const f = nativeFixture();
  const env = { ...process.env }; const cwd = process.cwd();
  const exec = childProcess.execFileSync, execSync = childProcess.execSync;
  let runtime: RuntimeStore | undefined; let stop: (() => void) | undefined;
  let running: any;
  const calls: string[][] = [];
  try {
    process.chdir(f.dir); mkdirSync(join(f.dir, "agents"));
    Object.assign(process.env, { PI_CODING_AGENT_DIR: f.dir, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "test",
      PI_SUBAGENT_SHELL_READY_DELAY_MS: "0", PI_SUBAGENT_LAYOUT: "tab" });
    for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"]) delete process.env[key];
    childProcess.execFileSync = ((command: string, args: string[]) => {
      calls.push([command, ...args]); return JSON.stringify({ result: { root_pane: { pane_id: "matrix-pane" } } });
    }) as any;
    childProcess.execSync = (() => "herdr") as any; syncBuiltinESMExports();
    const ctx: any = { sessionManager: {
      getSessionFile: () => f.sm.getSessionFile(), getSessionId: () => f.sm.getSessionId(), getSessionDir: () => f.dir,
    }, cwd: f.dir, model: { provider: "test", id: "model" }, modelRegistry: {
      find: () => ({ provider: "test", id: "model" }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true } };
    const contract = { objective: "Text fallback objective", scope: "Only inspect", criteria: [], dependencies: [],
      inputs: [], files: [], decisions: [], changeConstraints: ["No writes"] };
    const role = (cli: string, mode: string) => {
      const name = `matrix-${cli}`;
      writeFileSync(join(f.dir, "agents", `${name}.md`), `---\nname: ${name}\ncli: ${cli}\nsession-mode: ${mode}\n---\nRead only\n`);
      return name;
    };
    for (const cli of ["claude", "codex", "opencode", "grok", "aider"]) {
      for (const mode of ["fork", "lineage-only"]) {
        const name = role(cli, mode); const before = readdirSync(f.dir).sort(); const snapshot = f.read();
        await assert.rejects(parent.launchSubagent({ name, agent: name, task: "Inspect", assignmentContract: contract }, ctx, "off"), /does not support session mode/);
        assert.deepEqual(readdirSync(f.dir).sort(), before, "no launch artifacts on rejection");
        assert.deepEqual(f.read(), snapshot, "no task mutation on rejection");
      }
      assert.equal(getHarnessDriver(cli).supportsTrackedKeepOpen ?? false, false);
    }
    assert.deepEqual(calls, [], "no terminal probes, dispatch or model command on rejection");
    assert.equal(getHarnessDriver("pi").supportsTrackedKeepOpen, true);
    const name = role("codex", "standalone");
    running = await parent.launchSubagent({ name, agent: name, task: "Inspect", assignmentContract: contract }, ctx, "off");
    const script = readFileSync(running.launchScriptFile, "utf8");
    assert.match(script, /codex/); assert.match(script, /Text fallback objective/); assert.match(script, /No writes/);
    assert.equal(script.includes("--session"), false, "foreign command is not a native Pi continuation");
    // Actual native plan binding plus foreign immutable plain-text completion.
    f.mutate((p, c) => plan.addTask(p, c, "Review foreign output"));
    f.mutate((p, c) => plan.startAttempt(p, c, p.tasks[0].taskId));
    const p = f.read();
    const binding = bindPlanRun(f.p, f.ctx, running.id, { planId: p.planId, taskId: p.tasks[0].taskId,
      attemptId: p.tasks[0].attempts[0].attemptId, expectedRevision: p.revision })!;
    runtime = new RuntimeStore(join(f.dir, "foreign-runtime"), { sessionFile: f.sm.getSessionFile()!,
      headerId: f.sm.getSessionId(), branchToken: "matrix", checkpoint: "test" });
    runtime.prepare({ id: running.id, name, task: "Inspect", sessionFile: running.sessionFile, startTime: 1, cli: "codex", planTask: binding });
    writeFileSync(runCompletionFile(running.sessionFile, running.id), JSON.stringify({ type: "done", runId: running.id,
      eventId: "foreign-text", summary: "Plain foreign output; tests reported, not verified" }));
    const deliveries = createDeliveryState(); deliveries.store = runtime;
    deliveries.onEnvelope = (id, envelope) => importPlanEnvelope(f.p, f.ctx, binding, id, envelope);
    const transportCalls = calls.length;
    let observations = 0;
    stop = await reconcileRuntime(runtime, (run, event) => {
      observations++; assert.equal(event.structuredResult, undefined); assert.match(event.summary!, /Plain foreign output/);
      enqueueDelivery(deliveries, { id: run.id, lifecycle: createLifecycle(1) }, { customType: "subagent_result",
        content: event.summary!, display: true, details: { sessionFile: run.sessionFile } }, () => {}, event.eventId);
    }, () => true);
    assert.equal(observations, 1);
    assert.equal(calls.length, transportCalls, "foreign artifact recovery never inspects, controls or relaunches terminal");
    assert.match(runtime.snapshot().runs[running.id].reconciliation!, /unverified.*no terminal controls or automatic launch/);
    assert.equal(f.read().tasks[0].status, "in_review");
    assert.deepEqual(f.read().tasks[0].evidence, []); assert.deepEqual(f.read().tasks[0].decisions, []);
    assert.equal(f.read().tasks[0].attempts.length, 1);
  } finally {
    stop?.(); runtime?.close();
    if (running) { parent.runningSubagents.delete(running.id); releaseSession(running.sessionFile, running.id); }
    childProcess.execFileSync = exec; childProcess.execSync = execSync; syncBuiltinESMExports();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); f.cleanup();
  }
});
