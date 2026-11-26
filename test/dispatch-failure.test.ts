import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import timerPromises from "node:timers/promises";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as store from "../pi-extension/subagents/plan-store.ts";
import { PLAN_ENTRY, PLAN_ENTRY_V2, PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { bindPlanRun, importPlanEnvelope, recordDispatchFailure } from "../pi-extension/subagents/plan-runtime.ts";
import { RuntimeStore, readRuntimeManifest, type DurableRun, type RuntimeManifest } from "../pi-extension/subagents/runtime-store.ts";
import { captureDispatchEvidence } from "../pi-extension/subagents/dispatch-recovery.ts";
import { beginQueueLaunch } from "../pi-extension/subagents/queue-launch-gate.ts";
import { markInterruptRequested, markProcessRunning } from "../pi-extension/subagents/lifecycle.ts";
import { registerLiveContinuation } from "../pi-extension/subagents/live-continuation.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";

test("registered spawn/resume enforce dispatch recovery at the terminal boundary", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "manifest-dispatch-"));
  const env = { ...process.env }, platform = process.platform;
  const exec = childProcess.execFile, rename = fs.renameSync, readdir = fs.readdirSync;
  const wait = Atomics.wait;
  let sends = 0, serial = 0, blocked = 0, failSend = false;
  const exitedChildPid = 123456789;
  let fault: "none" | "short" | "permanent" = "none";
  let target = "", profileRenameFault: string | undefined, paths: string[] = [], delays: number[] = [];
  let phaseFault: "dispatch-intent" | "supervised" | undefined;
  let phaseWrites: Array<{ run: DurableRun; previous: DurableRun["phase"]; temp: string; sends: number }> = [];
  const liveDelay = timerPromises.setTimeout;
  let shellGates: Array<() => void> | undefined;
  let livePane: string | undefined;
  mock.method(timerPromises, "setTimeout", (ms, value, options) => shellGates && ms === 0
    ? new Promise(resolve => shellGates!.push(() => resolve(value))) : liveDelay(ms, value, options));
  mock.method(fs, "readdirSync", (path: any, ...args: any[]) => String(path) === "/proc" ? [] : (readdir as any)(path, ...args));
  mock.method(fs, "renameSync", (from: any, to: any) => {
    if (String(to) === profileRenameFault) {
      profileRenameFault = undefined;
      throw Object.assign(new Error("exact launch profile rename blocked"), { code: "EPERM", syscall: "rename" });
    }
    if (String(to) === target && (phaseFault || fault !== "none") && fs.existsSync(to)) {
      const candidate: RuntimeManifest = JSON.parse(fs.readFileSync(from, "utf8"));
      const previous: RuntimeManifest = JSON.parse(fs.readFileSync(to, "utf8"));
      if (phaseFault) {
        const priorPhase = phaseFault === "dispatch-intent" ? "prepared" : "dispatch-intent";
        const run = Object.values(candidate.runs).find(run => run.phase === phaseFault && previous.runs[run.id]?.phase === priorPhase);
        if (run) {
          phaseWrites.push({ run, previous: priorPhase, temp: String(from), sends });
          throw Object.assign(new Error(`exact ${priorPhase} -> ${phaseFault} manifest replacement blocked`), { code: "EPERM", syscall: "rename" });
        }
      }
      // Independently fault prepare/failure evidence; phase-only failures leave
      // the failure event write available and never throw from the terminal mock.
      const isPrepare = Object.keys(candidate.runs).length > Object.keys(previous.runs).length;
      const isFailure = Object.keys(candidate.outbox).length > Object.keys(previous.outbox).length;
      if (fault !== "none" && (isPrepare || isFailure)) {
        paths.push(String(from));
        if (fault === "permanent" || blocked++ < 2) throw Object.assign(new Error("exact manifest rename blocked"), { code: "EPERM", syscall: "rename" });
      }
    }
    return rename(from, to);
  });
  mock.method(childProcess, "execSync", () => "herdr");
  mock.method(childProcess, "execFileSync", (command: any, args: string[]) => {
    if (command === "powershell.exe") return args.at(-1)?.includes(`Get-Process -Id ${exitedChildPid} `) ? "null" : "[]";
    if (command === "git") throw Object.assign(new Error("outside Git"), { status: 128, stderr: "fatal: not a git repository" });
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { root_pane: { pane_id: `pane-${++serial}` } } });
    if (args[1] === "run") {
      sends++;
      if (failSend) { fault = "permanent"; throw new Error("ambiguous terminal send"); }
    }
    return "";
  });
  childProcess.execFile = Object.assign(() => { throw new Error("unexpected transport"); }, {
    [promisify.custom]: async (_command: string, args: string[]) => ({ stdout: JSON.stringify({ result: { pane: {
      pane_id: args[2] === livePane ? livePane : "pane", agent_status: "idle",
    } } }) }),
  }) as any;
  syncBuiltinESMExports();
  Atomics.wait = ((_array: any, _index: any, _value: any, ms: number) => { delays.push(ms); return "timed-out"; }) as any;
  process.env.HERDR_ENV = "1"; process.env.HERDR_WORKSPACE_ID = "test";
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0"; process.env.PI_CODING_AGENT_DIR = dir;
  for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT", "PI_SUBAGENT_ID", "PI_SUBAGENT_SESSION"]) delete process.env[key];
  const { default: extension, __test__ } = await import("../pi-extension/subagents/index.ts");
  const { canonicalSessionPath, releaseSession, sessionOwners } = await import("../pi-extension/subagents/ownership.ts");
  const { launchProfilePath, persistLaunchProfile, persistProfileBinding, readPiLaunchProfile, resolveLaunchProfile } = await import("../pi-extension/subagents/launch-profile.ts");
  const { runScriptInPane } = await import("../pi-extension/subagents/terminal.ts");
  try {
    const scenarios = ["spawn", "resume"].flatMap(operation => ["short", "permanent", "after-send", "dispatch-intent", "supervised"].map(scenario => [operation, scenario]));
    scenarios.push(["resume", "bare-intent"], ["spawn", "binding-mismatch"], ["spawn", "storage-paused-during-shell-ready"],
      ["spawn", "queue-bound"], ["resume", "queue-bound"], ["resume", "queue-unbound-profile"], ["resume", "queue-unbound-pre-send"],
      ["resume", "queue-unbound-historical"], ["resume", "queue-unbound-no-plan"], ["resume", "queue-independent"],
      ...["first-binding", "retry-prepared", "retry-uncertain", "retry-executed", "retry-profile-fault", "retry-profile-fault-prepared-successor"]
        .map(s => ["resume", `legacy-${s}`]),
      ...["one-send", "paused", "lost-custody", "branch-changed", "blocked", "binding-conflict", "cwd-conflict", "missing-cwd", "write-fault",
        "writer-paused", "dispatch-evidence", "competing-run", "prior-intent"]
        .map(s => ["permit", `queue-${s}`]));
    for (const [operation, scenario] of scenarios) {
      const local = join(dir, `${operation}-${scenario}`); fs.mkdirSync(local);
      const parent = join(local, "parent.jsonl"), saved = canonicalSessionPath(join(local, "saved.jsonl"));
      fs.writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: local }) + "\n");
      fs.writeFileSync(saved, JSON.stringify({ type: "session", version: 3, id: "saved", cwd: local }) + "\n");
      const launchProfile = resolveLaunchProfile({ params: { id: "original", name: "Saved" },
        runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
        effectiveCwd: local, effectiveAutoExit: false, effectiveInteractive: true, taskDelivery: "artifact", subagentSessionFile: saved, localAgentDir: dir, denySet: new Set(),
      } as any, "pi", "read");
      persistLaunchProfile(launchProfile);
      const tools = new Map<string, any>(), handlers = new Map<string, any>(), branch: any[] = [], tree: any[] = [];
      const api: any = new Proxy({}, { get: (_, key) => key === "registerTool" ? (tool: any) => tools.set(tool.name, tool)
        : key === "on" ? (name: string, handler: any) => handlers.set(name, handler)
        : key === "getAllTools" ? () => [] : key === "getThinkingLevel" ? () => "off"
        : key === "appendEntry" ? (customType: string, data: any) => branch.push({ id: "custody", type: "custom", customType, data }) : () => {} });
      const ctx: any = { hasUI: false, isIdle: () => false, scopedModels: [], cwd: local, model: { provider: "test", id: "model" },
        modelRegistry: { find: () => ({ provider: "test", id: "model", reasoning: true }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true },
        sessionManager: { getHeader: () => ({ id: "parent" }), getBranch: () => branch, getTree: () => tree, getSessionFile: () => parent, getSessionDir: () => local, getSessionId: () => "parent" } };
      const runtimeDirectory = join(local, "artifacts", "parent", "subagent-runtime");
      const oldId = randomUUID();
      const queueWithoutSidecarBinding = scenario.startsWith("queue-unbound-");
      const earlierView = scenario === "queue-unbound-historical" || scenario === "queue-unbound-no-plan";
      const queueBranchToken = randomUUID();
      if (earlierView) api.appendEntry("subagent-custody", { branchToken: queueBranchToken });
      let planTask: { planId: string; taskId: string; attemptId: string; expectedRevision: number } | undefined;
      const queue = scenario.startsWith("queue-");
      const priorPhase = scenario === "legacy-retry-prepared" ? "prepared" : scenario === "legacy-retry-uncertain" ? "dispatch-intent"
        : scenario === "legacy-retry-executed" ? "supervised" : undefined;
      if (queue || scenario.startsWith("legacy-")) {
        const authority = { sessionId: "parent", branchInstanceId: randomUUID() };
        let plan = store.createPlan(queue ? "Queue" : "Legacy", authority);
        const context = () => ({ ...authority, expectedRevision: plan.revision });
        if (queue) plan = store.configureQueue(plan, context(), 1);
        plan = store.addTask(plan, context(), "Task");
        const taskId = plan.tasks[0].taskId;
        if (queue) plan = store.setWorkArea(plan, context(), taskId, local, "write");
        plan = store.startAttempt(plan, context(), taskId, undefined, { available: () => true, inspect: () => ({ state: "unknown" }) });
        if (priorPhase) {
          const binding = { planId: plan.planId, taskId, attemptId: plan.tasks[0].attempts[0].attemptId, authority };
          plan = store.attachRun(plan, context(), taskId, binding.attemptId, oldId);
          plan = store.block(plan, context(), taskId, "An earlier attempt needs a decision");
          plan = store.retry(plan, context(), taskId);
          const branchToken = randomUUID();
          api.appendEntry("subagent-custody", { branchToken });
          const writer = new RuntimeStore(runtimeDirectory, { sessionFile: canonicalSessionPath(parent), headerId: "parent", branchToken, checkpoint: "custody" });
          try {
            writer.prepare({ id: oldId, sessionFile: saved, name: "Prior resume", task: "Task", startTime: 1, planTask: binding });
            if (priorPhase !== "prepared") writer.phase(oldId, priorPhase);
          } finally { writer.close(); }
        }
        planTask = { planId: plan.planId, taskId, attemptId: plan.tasks[0].attempts.at(-1)!.attemptId, expectedRevision: plan.revision };
        branch.push({ type: "message", message: { role: "user" }, id: "user" },
          { type: "custom", customType: queue ? PLAN_ENTRY_V2 : PLAN_ENTRY, data: plan, id: "plan" });
      }
      if (scenario === "bare-intent" || scenario === "binding-mismatch") {
        const branchToken = randomUUID();
        api.appendEntry("subagent-custody", { branchToken });
        const previous = new RuntimeStore(runtimeDirectory, { sessionFile: canonicalSessionPath(parent), headerId: "parent", branchToken, checkpoint: "custody" });
        try {
          const planTask = scenario === "binding-mismatch" ? { planId: "unselected-plan", taskId: "task", attemptId: "attempt",
            authority: { sessionId: "parent", branchInstanceId: "original-plan-branch" } } : undefined;
          previous.prepare({ id: oldId, sessionFile: saved, name: "Prior child", task: "old task", cli: "pi", startTime: 1, planTask });
          if (scenario === "bare-intent") previous.phase(oldId, "dispatch-intent");
          else {
            const error = Object.assign(new Error("previous manifest write failed"), { code: "EPERM" });
            assert.equal(captureDispatchEvidence(new Map(), previous, { runId: oldId, sessionFile: saved, startedAt: 1,
              binding: planTask, dispatched: false }, error, error).retained, "file");
          }
        } finally { previous.close(); }
      }
      fault = "none"; failSend = false; extension(api);
      try {
        await handlers.get("session_start")({ reason: "startup" }, ctx);
        target = join(runtimeDirectory, "manifest.json");
        blocked = 0; paths = []; delays = []; phaseWrites = [];
        // Simulate Windows only for this policy; no real terminal is contacted.
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        fault = scenario === "short" ? "short" : scenario === "permanent" ? "permanent" : "none";
        failSend = scenario === "after-send";
        const before = sends;
        // The transport mock arms failure-evidence trouble only after send.
        const call = (name = "Child") => tools.get(operation === "spawn" ? "subagent" : "subagent_resume").execute("call",
          operation === "spawn" ? { name, task: "task", cwd: local, agentDir: dir, planTask } : { sessionPath: saved, message: "continue", planTask }, undefined, undefined, ctx);
        if (scenario === "queue-bound") {
          const beforePanes = serial;
          await assert.rejects(call(), /Queue-bound transport is unavailable/);
          assert.equal(sends, before, "legacy spawn/resume must not dispatch a v2 reservation");
          assert.equal(serial, beforePanes, "no pane should be allocated");
          assert.equal(fs.existsSync(target), false, "queue preflight must not acquire runtime custody");
          continue;
        }
        if (scenario === "queue-independent") {
          const beforeBranch = [...branch];
          planTask = undefined;
          assert.ok((await call()).details.id);
          assert.equal(sends - before, 1, "an independent unbound session is not subject to a queue reservation");
          assert.deepEqual(branch.filter(entry => entry.customType === PLAN_ENTRY_V2), beforeBranch.filter(entry => entry.customType === PLAN_ENTRY_V2));
          continue;
        }
        if (scenario === "legacy-first-binding") {
          const resumed = await call();
          assert.equal(sends - before, 1, "a legacy resume can add its first binding");
          const run = readRuntimeManifest(runtimeDirectory)?.runs[resumed.details.id];
          assert.equal(run?.planTask?.attemptId, planTask!.attemptId);
          continue;
        }
        if (priorPhase) {
          const beforePanes = serial;
          releaseSession(saved, oldId); // Isolate dispatch proof from cached writer ownership.
          await assert.rejects(call(), /requires the original task binding|dispatch-unknown/, scenario);
          assert.equal(sends, before);
          assert.equal(serial, beforePanes);
          assert.equal(readPiLaunchProfile(saved).planTask, undefined);
          continue;
        }
        if (scenario.startsWith("legacy-retry-profile-fault")) {
          const persistence = new PlanPersistence(api.appendEntry, false);
          const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
          const resumeSaved = (message: string) => tools.get("subagent_resume").execute("follow-up",
            { sessionPath: saved, message }, undefined, undefined, ctx);
          const beforePanes = serial;
          profileRenameFault = launchProfilePath(saved);
          await assert.rejects(call(), /exact launch profile rename blocked/);
          assert.equal(profileRenameFault, undefined, "only the first binding sidecar rename is faulted");
          assert.equal(readPiLaunchProfile(saved).planTask, undefined);
          assert.equal(sends, before);
          assert.equal(serial, beforePanes);

          const [failed] = Object.values(readRuntimeManifest(runtimeDirectory)!.runs);
          const failureId = `subagent:${failed.id}:dispatch-failure:launch`;
          assert.equal(failed.planTask?.attemptId, planTask!.attemptId);
          assert.equal(failed.phase, "prepared");
          assert.deepEqual(failed.eventCursor, [failureId]);
          const event = readRuntimeManifest(runtimeDirectory)!.outbox[failureId];
          assert.equal(event.status, "handedOff");
          assert.equal(event.envelope.message.customType, "subagent_result");
          const rejection = /requires the original task binding/;
          const plan = persistence.read(ctx.sessionManager).snapshot!;
          assert.equal(plan.tasks[0].status, "failed");
          assert.deepEqual(plan.tasks[0].attempts[0].runIds, [failed.id]);
          const { planId, taskId } = planTask!;
          planTask = { ...planTask!, expectedRevision: plan.revision };
          await assert.rejects(call(), rejection, "cannot reuse the failed attempt");
          const retry = persistence.mutate(ctx.sessionManager, planId, plan.revision, (p, c) => store.retry(p, c, taskId));
          const retrySelection = { planId, taskId, attemptId: retry.tasks[0].attempts[1].attemptId, expectedRevision: retry.revision };
          planTask = undefined;
          await assert.rejects(call(), rejection, "omitting planTask cannot discard the old binding");
          const savedBinding = { planId, taskId, attemptId: retrySelection.attemptId, authority: retry.authority };
          persistProfileBinding(saved, savedBinding);
          planTask = retrySelection;
          await assert.rejects(call(), rejection, "a sidecar claiming the retry without durable supervision remains a conflict");
          assert.equal(sends, before);
          assert.equal(serial, beforePanes);
          assert.deepEqual(persistence.read(ctx.sessionManager).snapshot, retry);
          if (scenario === "legacy-retry-profile-fault-prepared-successor") {
            // A run ID and exact binding on both sides are not enough without
            // durable supervision. A bare prepared run has no dispatch incident.
            persistence.mutate(ctx.sessionManager, planId, retry.revision, (p, c) => store.attachRun(p, c, taskId, savedBinding.attemptId, oldId));
            const writer: RuntimeStore = runtime.store;
            writer.prepare({ id: oldId, sessionFile: saved, name: "Unsent retry", task: "Task", startTime: Date.now(),
              planTask: savedBinding, profile: { ...launchProfile, planTask: savedBinding } });
            const prepared = writer.snapshot();
            await assert.rejects(resumeSaved("do not bypass the tombstone"), rejection);
            assert.equal(sends, before);
            assert.equal(serial, beforePanes);
            assert.deepEqual(writer.snapshot(), prepared);
            continue;
          }
          fs.rmSync(launchProfilePath(saved));
          persistLaunchProfile(launchProfile);

          const result = await call();
          assert.equal(sends - before, 1, "only the explicit retry crosses transport");
          assert.notEqual(result.details.id, failed.id);
          const current = readRuntimeManifest(runtimeDirectory)!;
          assert.deepEqual(current.runs[failed.id], failed);
          assert.deepEqual(current.outbox[failureId], event);
          assert.equal(current.runs[result.details.id].phase, "supervised");
          assert.deepEqual(current.runs[result.details.id].planTask, savedBinding);
          assert.deepEqual(readPiLaunchProfile(saved).planTask, savedBinding);
          assert.deepEqual(persistence.read(ctx.sessionManager).snapshot!.tasks[0].attempts[1].runIds, [result.details.id]);

          const child = __test__.runningSubagents.get(result.details.id)!;
          child.lifecycle = markInterruptRequested(markProcessRunning(child.lifecycle, Date.now()), Date.now());
          const childEvents = new Map<string, any>(), messages: string[] = [];
          const childEnv = { PI_SUBAGENT_ID: child.id, PI_SUBAGENT_SESSION: saved, PI_SUBAGENT_ACTIVITY_FILE: child.activityFile! };
          const previousEnv = Object.entries(childEnv).map(([key, value]) => {
            const previous = process.env[key]; process.env[key] = value; return [key, previous] as const;
          });
          try {
            registerLiveContinuation({ on: (name: string, handler: any) => childEvents.set(name, handler),
              registerCommand: () => {}, sendUserMessage: (message: string) => messages.push(message) } as any);
          } finally {
            for (const [key, value] of previousEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
          const childCtx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionFile: () => saved } };
          const panesAfterLaunch = serial;
          livePane = child.surface;
          try {
            childEvents.get("session_start")({}, childCtx);
            childEvents.get("agent_settled")({ aborted: true }, childCtx);
            const continued = await resumeSaved("live follow-up");
            assert.equal(continued.details.status, "continued");
            assert.equal(continued.details.id, child.id);
            assert.equal(messages.length, 1);
            assert.match(messages[0], /^live follow-up\n\nAssignment contract/);
            assert.equal(sends - before, 1, "live continuation uses artifacts, not terminal launch");
            assert.equal(serial, panesAfterLaunch);
          } finally {
            livePane = undefined;
            childEvents.get("session_shutdown")();
          }

          // Simulate cold restoration without a live registry or cached owner.
          // The recovered reservation is released only by the normal gone-PID
          // proof and fresh writer audit, not by the supervised launch itself.
          fs.writeFileSync(`${runCompletionFile(saved, child.id)}.identity.json`, JSON.stringify({ schema: 1, runId: child.id,
            sessionFile: saved, headerId: "saved", nonce: "prior-process", process: { pid: exitedChildPid, birth: "windows:old" } }));
          await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
          releaseSession(saved, child.id);
          assert.equal(__test__.runningSubagents.has(child.id), false);
          extension(api);
          await handlers.get("session_start")({ reason: "startup" }, ctx);
          const restored = readRuntimeManifest(runtimeDirectory)!;
          assert.notEqual(restored.generation, current.generation);
          assert.equal(sessionOwners.get(saved)?.runId, child.id);
          assert.match(restored.runs[child.id].reconciliation!, /^exited:/);
          const restarted = await resumeSaved("closed follow-up after restore");
          assert.equal(restarted.details.status, "started");
          assert.notEqual(restarted.details.id, child.id);
          assert.equal(sends - before, 2, "only the explicit closed resume launches a replacement");
          assert.equal(serial, panesAfterLaunch + 1);
          const after = readRuntimeManifest(runtimeDirectory)!;
          assert.deepEqual(after.runs[restarted.details.id].planTask, savedBinding);
          assert.deepEqual(after.runs[failed.id], failed);
          assert.deepEqual(after.outbox[failureId], event);

          const afterPlan = persistence.read(ctx.sessionManager).snapshot!;
          persistence.mutate(ctx.sessionManager, planId, afterPlan.revision, (p, c) => store.attachRun(p, c, taskId, savedBinding.attemptId, oldId));
          const writer: RuntimeStore = runtime.store;
          writer.prepare({ id: oldId, sessionFile: saved, name: "Unverified send", task: "Task", startTime: Date.now(), planTask: savedBinding });
          writer.commitFreshDispatch(oldId, saved, savedBinding);
          const uncertain = writer.snapshot();
          await assert.rejects(resumeSaved("do not bypass an uncertain successor"), /dispatch-unknown/);
          assert.equal(sends - before, 2);
          assert.equal(serial, panesAfterLaunch + 1);
          assert.deepEqual(writer.snapshot(), uncertain);
          releaseSession(saved, restarted.details.id);
          continue;
        }
        if (queueWithoutSidecarBinding || operation === "permit") {
          if (!earlierView) api.appendEntry("subagent-custody", { branchToken: queueBranchToken });
          const writer = new RuntimeStore(runtimeDirectory, { sessionFile: canonicalSessionPath(parent), headerId: "parent", branchToken: queueBranchToken, checkpoint: "custody" });
          let writerClosed = false;
          try {
            const persistence = new PlanPersistence(api.appendEntry, false);
            let current = true;
            const source = { assertCurrent: () => { if (!current) throw new Error("Original extension lost custody"); },
              dispatchEvidence: new Map(), supervision: () => undefined };
            const launch = { sessionFile: saved, cwd: local, runId: oldId };
            const permit = beginQueueLaunch(persistence, ctx.sessionManager, writer, planTask!, launch, source);
            assert.throws(() => beginQueueLaunch(persistence, ctx.sessionManager, writer, planTask!, { ...launch, runId: randomUUID() }, source), /Revision conflict/);
            const plan = persistence.read(ctx.sessionManager).snapshot!;
            const attempt = plan.tasks[0].attempts[0];
            assert.equal(attempt.reservation?.phase, "uncertain");
            assert.equal(attempt.reservation.runId, oldId);
            assert.deepEqual(attempt.runIds, [oldId]);
            assert.throws(() => beginQueueLaunch(persistence, ctx.sessionManager, writer, { ...planTask!, expectedRevision: plan.revision }, launch,
              source), /not awaiting its first dispatch/);
            const binding = scenario === "queue-binding-conflict" ? { ...permit.binding, attemptId: randomUUID() } : permit.binding;
            const profile = scenario === "queue-missing-cwd" ? undefined
              : { ...launchProfile, planTask: binding, cwd: scenario === "queue-cwd-conflict" ? dir : launchProfile.cwd };
            writer.prepare({ id: oldId, sessionFile: saved, name: "Queue child", task: "Task", startTime: 1, planTask: binding, profile, cli: "pi" });
            if (queueWithoutSidecarBinding) {
              if (scenario === "queue-unbound-pre-send") {
                const eventId = `subagent:${oldId}:dispatch-failure:launch`;
                writer.recordDispatchFailure(writer.getRun(oldId)!, { message: { customType: "subagent_result", content: "before send",
                  details: { eventId, error: "before send" } }, options: { triggerTurn: true, deliverAs: "steer" } });
              } else writer.phase(oldId, "supervised");
              writer.close();
              writerClosed = true;
              if (earlierView) {
                // Navigate to a view before the dispatch claim without losing the runtime checkpoint.
                const intent = branch.pop()!;
                const reserved = branch.at(-1)!;
                tree.push({ entry: reserved, children: [{ entry: { ...intent, id: "intent" }, children: [] }] });
                if (scenario === "queue-unbound-no-plan") branch.pop();
                const selected = persistence.read(ctx.sessionManager);
                assert.equal(selected.detachRequired, scenario === "queue-unbound-historical" ? "historical" : undefined);
                assert.equal(selected.snapshot?.tasks[0].attempts[0].reservation?.runId, undefined);
              }
              // Exact queue run in a disk-only manifest; the sidecar lacks planTask. A failure tombstone does not bypass v2.
              const beforePanes = serial;
              const beforeManifest = readRuntimeManifest(runtimeDirectory);
              const beforeBranch = [...branch];
              await assert.rejects(tools.get("subagent_resume").execute("call", { sessionPath: saved, message: "continue" }, undefined, undefined, ctx),
                earlierView ? /requires the original task binding/ : /Queue-bound transport is unavailable/);
              assert.equal(sends, before);
              assert.equal(serial, beforePanes);
              assert.deepEqual(readRuntimeManifest(runtimeDirectory), beforeManifest);
              assert.deepEqual(branch, beforeBranch);
              continue;
            }
            const mutate = (command: Parameters<PlanPersistence["mutate"]>[3]) => persistence.mutate(ctx.sessionManager, plan.planId, plan.revision, command);
            if (scenario === "queue-paused") mutate((p, c) => store.queuePause(p, c, "Parent paused after preparation"));
            if (scenario === "queue-blocked") mutate((p, c) => store.setBlocker(p, c, planTask!.taskId, {
              attemptId: planTask!.attemptId, code: "scope_decision", effects: "none", decisionOwner: "user", summary: "Review scope", requestedAction: "Confirm scope",
            }));
            if (scenario === "queue-lost-custody") current = false;
            if (scenario === "queue-branch-changed") branch.splice(branch.findIndex(e => e.customType === "subagent-custody"), 1);
            if (scenario === "queue-write-fault") phaseFault = "dispatch-intent";
            if (scenario === "queue-writer-paused") writer.pauseCustody("paused before transport");
            if (scenario === "queue-dispatch-evidence") {
              const error = Object.assign(new Error("manifest write failed"), { code: "EPERM" });
              assert.equal(captureDispatchEvidence(new Map(), writer, { runId: oldId, sessionFile: saved, startedAt: 1,
                binding, dispatched: false }, error, error).retained, "file");
            }
            if (scenario === "queue-competing-run") writer.prepare({ ...writer.getRun(oldId)!, id: randomUUID() });
            if (scenario === "queue-prior-intent") writer.commitFreshDispatch(oldId, saved, binding);
            const send = () => runScriptInPane("queue-test", "true", { scriptPath: join(local, "queue.sh"), onDispatch: permit.commitBeforeSend });
            if (scenario === "queue-one-send") {
              send();
              assert.equal(sends - before, 1);
              assert.equal(readRuntimeManifest(runtimeDirectory)?.runs[oldId].phase, "dispatch-intent");
            } else {
              const reason = scenario === "queue-cwd-conflict" ? /Launch cwd does not match the queue reservation/
                : scenario === "queue-missing-cwd" ? /requires the prepared Pi launch profile cwd/
                : scenario === "queue-binding-conflict" || scenario === "queue-competing-run" ? /runtime_unavailable/
                : /queue_paused|Runtime cannot positively exclude|lost custody|original parent branch custody|requires in_progress|manifest replacement blocked/;
              const initialManifest = readRuntimeManifest(runtimeDirectory);
              assert.ok(initialManifest);
              assert.throws(send, reason);
              assert.deepEqual(readRuntimeManifest(runtimeDirectory), initialManifest, "refused transport does not change manifest disposition");
              assert.equal(sends, before, scenario);
            }
            assert.throws(send, /already consumed/);
            assert.equal(sends - before, Number(scenario === "queue-one-send"));
          } finally { if (!writerClosed) writer.close(); }
          continue;
        }
        if (scenario === "storage-paused-during-shell-ready") {
          shellGates = [];
          const a = call("Waiting A"), b = call("Failing B");
          try {
            assert.equal(shellGates.length, 2, "both launches passed the initial storage guard and reached shell-ready delay");
            fault = "permanent";
            shellGates[1]();
            await assert.rejects(b, /failure evidence file \(EPERM\)/);
            fault = "none"; // Disk works now, but the store must remain fenced until explicit repair.
            shellGates[0]();
            await assert.rejects(a, /Dispatch metadata write paused \(EPERM\)/);
            assert.equal(sends, before, "neither launch crosses the terminal boundary");
            const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
            const [run] = Object.values(manifest.runs) as Array<{ name: string; phase: string }>;
            assert.equal(run.name, "Waiting A");
            assert.equal(run.phase, "prepared", "A must not commit dispatch-intent");
          } finally {
            for (const release of shellGates) release();
            shellGates = undefined;
            await Promise.allSettled([a, b]);
          }
          continue;
        }
        if (scenario === "bare-intent" || scenario === "binding-mismatch") {
          const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
          const active: RuntimeStore = runtime.store;
          const report = () => tools.get("subagents_recovery").execute("report", { runId: oldId }, undefined, undefined, ctx);
          if (scenario === "binding-mismatch") {
            const savedReport = await report();
            assert.match(savedReport.content[0].text, /still-blocked \(BINDING_MISMATCH\)/);
            assert.equal(savedReport.isError, false);
            const launched = await call();
            assert.ok(launched.details.id);
            assert.equal(active.getRun(launched.details.id)?.planTask, undefined);
            assert.ok(active.snapshot().retainedDispatchEvidence?.[oldId]);
          } else {
            // A clean writer audit and no cached reservation isolate the gate.
            releaseSession(saved, oldId);
            assert.match((await report()).content[0].text, /dispatch-unknown \(DISPATCH_INTENT\)/);
            await assert.rejects(call, /dispatch-unknown/);
            const completion = (id: string) => {
              const eventId = `subagent:${id}:completion:child-event`;
              active.enqueue(eventId, id, { message: { customType: "subagent_result", content: "child executed",
                details: { eventId, sessionFile: saved, exitCode: 1 } }, options: { triggerTurn: true, deliverAs: "steer" } });
            };
            const other = randomUUID();
            active.prepare({ id: other, name: "Different run", task: "unrelated", sessionFile: saved, startTime: 2 });
            active.phase(other, "supervised");
            completion(other);
            await assert.rejects(call, /dispatch-unknown/, "another run in the same session is not dispatch proof");
            const eventId = `subagent:${oldId}:dispatch-failure:launch`;
            active.enqueue(eventId, oldId, { message: { customType: "subagent_ping", content: "ambiguous send",
              details: { eventId, message: "ambiguous send" } }, options: { triggerTurn: true, deliverAs: "steer" } });
            for (const status of ["pending", "dispatching", "handedOff"] as const) {
              active.delivery(eventId, status);
              await assert.rejects(call, /dispatch-unknown/, `${status} launch failure does not prove execution`);
            }
            assert.equal(sends, before);
            completion(oldId);
            assert.match((await report()).content[0].text, /resolved \(RUN_BOUND_COMPLETION\)/);
            assert.notEqual((await call()).details.id, oldId);
            assert.equal(active.getEvent(`subagent:${oldId}:completion:child-event`)?.status, "pending", "proof is independent of delivery");
          }
          assert.equal(sends, before + 1, "only the explicit eligible launch crosses transport");
          continue;
        }
        if (scenario === "dispatch-intent" || scenario === "supervised") {
          phaseFault = scenario;
          const sent = scenario === "supervised";
          const previous = sent ? "dispatch-intent" : "prepared";
          await assert.rejects(call, new RegExp(`exact ${previous} -> ${scenario} manifest replacement blocked`));
          assert.equal(phaseWrites.length, 4, "all attempts fail at the exact phase transition");
          const { run, temp } = phaseWrites[0];
          for (const attempt of phaseWrites) {
            assert.equal(attempt.run.id, run.id);
            assert.equal(attempt.run.phase, scenario);
            assert.equal(attempt.previous, previous);
            assert.equal(attempt.temp, temp);
            assert.equal(attempt.sends - before, Number(sent), "send count at the failed manifest replacement");
          }
          assert.deepEqual(delays, [10, 30, 60]);
          const eventId = `subagent:${run.id}:dispatch-failure:launch`;
          const checkManifest = () => {
            const manifest = readRuntimeManifest(runtimeDirectory)!;
            assert.deepEqual(Object.keys(manifest.runs), [run.id]);
            assert.equal(manifest.runs[run.id].phase, previous, "failed phase never becomes durable");
            assert.deepEqual(manifest.runs[run.id].eventCursor, [eventId]);
            assert.deepEqual(Object.keys(manifest.outbox), [eventId]);
            assert.equal(manifest.outbox[eventId].status, "handedOff");
            assert.equal(manifest.outbox[eventId].envelope.message.customType, sent ? "subagent_ping" : "subagent_result");
            return manifest;
          };
          checkManifest();
          const expected = sent ? "dispatch-unknown" : "resolved";
          const report = await tools.get("subagents_recovery").execute("report", { runId: run.id }, undefined, undefined, ctx);
          assert.match(report.content[0].text, new RegExp(`${run.id}: ${expected} \\(RETAINED_EVENT\\).*${sent ? "send-possible" : "before-send"}`));
          phaseFault = undefined;
          const reconcile = async () => {
            const result = await tools.get("subagents_reconcile").execute("repair", {}, undefined, undefined, ctx);
            assert.equal(result.details.status, expected);
            return checkManifest();
          };
          const repaired = await reconcile();
          assert.deepEqual(await reconcile(), repaired, "repeat recovery neither duplicates nor upgrades failure evidence");
          if (sent) {
            await assert.rejects(tools.get("subagent_resume").execute("retry", { sessionPath: run.sessionFile, message: "retry" }, undefined, undefined, ctx), /dispatch-unknown/);
          }
          assert.equal(sends - before, Number(sent), `${operation}/${scenario} must not replay transport`);
          continue;
        }
        if (scenario === "short") { const result = await call(); assert.ok(result.details.id); }
        else {
          await assert.rejects(call, /failure evidence file \(EPERM\)/);
          const pending = fs.readdirSync(join(local, "artifacts", "parent", "subagent-runtime", "dispatch-evidence"));
          assert.equal(pending.length, 1);
          const runId = pending[0].slice(0, -5);
          assert.match((await tools.get("subagents_recovery").execute("report", { runId }, undefined, undefined, ctx)).content[0].text, /attempted=4/);
          fault = "none";
          const reconcile = () => tools.get("subagents_reconcile").execute("repair", {}, undefined, undefined, ctx);
          const expected = scenario === "after-send" ? "dispatch-unknown" : "resolved";
          for (let n = 0; n < 2; n++) {
            const result = await reconcile();
            assert.match(result.content[0].text, new RegExp(`${runId}: ${expected}`));
            const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
            assert.equal(Object.values(manifest.outbox).filter((event: any) => event.runId === runId).length, 1);
          }
        }
        assert.equal(sends - before, scenario === "permanent" ? 0 : 1, `${operation}/${scenario} transport count`);
        if (operation === "resume" && scenario === "after-send") {
          const runtime = (globalThis as any)[Symbol.for("pi-subagents/runtime")];
          const store: RuntimeStore = runtime.store;
          const [run] = store.listRuns();
          const nextResume = () => tools.get("subagent_resume").execute("new-call", { sessionPath: saved, message: "a deliberately different turn" }, undefined, undefined, ctx);
          failSend = false;
          // Cached exit and removal of an old pane reservation alone do not
          // prove transport. This mock's fresh OS writer audit returns no writers.
          store.reconcileRun(run.id, "exited: decision required before another writer");
          releaseSession(saved, run.id);
          await assert.rejects(nextResume, /dispatch-unknown/);
          assert.equal(sends - before, 1);
          const completion = `subagent:${run.id}:completion:retained-positive-child-event`;
          store.enqueue(completion, run.id, { message: { customType: "subagent_result", content: "child was dispatched",
            details: { eventId: completion, sessionFile: run.sessionFile, exitCode: 0 } }, options: { triggerTurn: true, deliverAs: "steer" } });
          const fresh = await nextResume();
          assert.notEqual(fresh.details.id, run.id);
          assert.equal(sends - before, 2, "only the explicit new resume crosses transport");
        }
        assert.ok(paths.length >= 3, "fault must hit exact manifest replacement");
        for (const temp of new Set(paths)) assert.ok(paths.filter(p => p === temp).length <= 4, "bounded per write");
        assert.ok(delays.every(ms => [10, 30, 60].includes(ms)));
      } finally {
        fault = "none"; failSend = false; phaseFault = undefined; profileRenameFault = undefined;
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
        releaseSession(saved, oldId);
        for (const { run } of phaseWrites) releaseSession(run.sessionFile, run.id);
        for (const child of __test__.runningSubagents.values()) releaseSession(child.sessionFile, child.id);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Atomics.wait = wait; childProcess.execFile = exec; mock.restoreAll(); syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure evidence survives native append fault and fresh runtime custody with original authority", () => {
  for (const dispatched of [false, true]) {
    const dir = fs.mkdtempSync(join(tmpdir(), "failure-outbox-"));
    let runtime: RuntimeStore | undefined;
    try {
      const sm = SessionManager.create(dir, dir);
      sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
      let rejectAppend = false;
      const p = new PlanPersistence((t, d) => { if (rejectAppend) throw new Error("append unavailable"); sm.appendCustomEntry(t, d); }, false);
      let plan = p.create(sm, 0, "Failure durability");
      plan = p.mutate(sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Task"));
      plan = p.mutate(sm, plan.planId, plan.revision, (p, c) => store.startAttempt(p, c, p.tasks[0].taskId));
      const binding = bindPlanRun(p, { sessionManager: sm } as any, "run", { planId: plan.planId, taskId: plan.tasks[0].taskId, attemptId: plan.tasks[0].attempts[0].attemptId, expectedRevision: plan.revision })!;
      const parent = { sessionFile: sm.getSessionFile()!, headerId: sm.getSessionId(), branchToken: "original", checkpoint: "checkpoint" };
      runtime = new RuntimeStore(join(dir, "runtime"), parent);
      assert.throws(() => recordDispatchFailure(p, { sessionManager: sm } as any, binding, "unpersisted", new Error("launch failed"), undefined,
        { id: "unpersisted", sessionFile: join(dir, "child.jsonl"), name: "Child", task: "Task", startTime: 1 }), /NOT persisted/);
      assert.equal(p.read(sm).snapshot!.tasks[0].status, "in_progress");
      rejectAppend = true;
      assert.throws(() => recordDispatchFailure(p, { sessionManager: sm } as any, binding, "run", new Error("original launch error"), runtime,
        { id: "run", sessionFile: join(dir, "child.jsonl"), name: "Child", task: "Task", startTime: 1 }, dispatched), /append failed/);
      const event = Object.values(runtime.snapshot().outbox)[0];
      assert.equal(event.status, "handedOff");
      assert.deepEqual(runtime.snapshot().runs.run.planTask, binding);
      assert.equal(p.read(sm).snapshot!.tasks[0].status, "in_progress");
      rejectAppend = false;
      p.reconcile(sm);
      const leaf = sm.getLeafId()!;
      plan = p.read(sm).snapshot!;
      p.detach(sm, plan.planId, plan.revision, "Wrong branch");
      const wrong = p.read(sm).snapshot!;
      assert.throws(() => importPlanEnvelope(p, { sessionManager: sm } as any, binding, "run", event.envelope));
      assert.deepEqual(p.read(sm).snapshot, wrong);
      sm.branch(leaf);
      runtime.close();
      runtime = undefined;
      const script = `
        import assert from 'node:assert/strict';
        import { SessionManager } from '@earendil-works/pi-coding-agent';
        import { RuntimeStore } from ${JSON.stringify(new URL('../pi-extension/subagents/runtime-store.ts', import.meta.url).href)};
        import { PlanPersistence } from ${JSON.stringify(new URL('../pi-extension/subagents/plan-persistence.ts', import.meta.url).href)};
        import { importPlanEnvelope } from ${JSON.stringify(new URL('../pi-extension/subagents/plan-runtime.ts', import.meta.url).href)};
        const runtime = new RuntimeStore(${JSON.stringify(join(dir, 'runtime'))}, ${JSON.stringify(parent)});
        try {
          const disk = SessionManager.open(${JSON.stringify(sm.getSessionFile())});
          disk.branch(${JSON.stringify(leaf)});
          const fresh = new PlanPersistence((t, d) => disk.appendCustomEntry(t, d), false);
          const restored = runtime.snapshot();
          for (const event of Object.values(restored.outbox)) importPlanEnvelope(fresh, { sessionManager: disk }, restored.runs[event.runId].planTask, event.runId, event.envelope);
          const imported = fresh.read(disk).snapshot;
          assert.equal(imported.tasks[0].status, ${JSON.stringify(dispatched ? 'blocked' : 'failed')});
          assert.equal(imported.tasks[0].attempts[0].results.length, 1);
          assert.deepEqual(imported.authority, ${JSON.stringify(binding.authority)});
          for (const event of Object.values(restored.outbox)) importPlanEnvelope(fresh, { sessionManager: disk }, restored.runs[event.runId].planTask, event.runId, event.envelope);
          assert.equal(fresh.read(disk).snapshot.revision, imported.revision);
        } finally { runtime.close(); }
      `;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
    } finally { runtime?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
