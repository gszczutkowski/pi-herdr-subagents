import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { launchProfilePath, persistLaunchProfile, persistProfileBinding, readPiLaunchProfile, resolveLaunchProfile, resumeLaunchContext } from "../pi-extension/subagents/launch-profile.ts";
import type { SubagentLaunchContext } from "../pi-extension/subagents/harness/types.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertQueueActiveResume, assertQueueWorkArea, isQueueMarkedSession, queueChildProfile, QUEUE_CHILD_ENV } from "../pi-extension/subagents/queue-child-allocation.ts";
import { isSubagentAssignment, registerSubagentAssignment, ASSIGNMENT_ENV } from "../pi-extension/subagents/assignment.ts";
import * as planStore from "../pi-extension/subagents/plan-store.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function spawn(context: SubagentLaunchContext) {
  context.launchProfile = resolveLaunchProfile(context, "pi", __test__.buildSubagentToolAllowlist(context.params.tools ?? context.agentDefs?.tools));
  persistLaunchProfile(context.launchProfile);
  return new PiHarnessDriver().buildCommand(context);
}
function fixture(run: (dir: string, context: SubagentLaunchContext) => void) {
  const dir = mkdtempSync(join(tmpdir(), "launch-profile-"));
  const agentDir = join(dir, "isolated config");
  mkdirSync(agentDir);
  const context: SubagentLaunchContext = {
    params: { id: "spawn-run", name: "Scout", task: "ORIGINAL_ASSIGNMENT", agent: "scout", skills: "review" },
    agentDefs: { name: "scout", tools: "read,bash", body: "ROLE_BODY" },
    runtimePlan: { model: "test/model", provider: "test", modelId: "model", thinking: "high", modelSource: "agent", thinkingSource: "agent" },
    effectiveModel: "test/model", effectiveThinking: "high", parentThinking: "off",
    surface: "original-pane", artifactDir: dir, sessionDir: dir, subagentSessionFile: join(dir, "child.jsonl"),
    effectiveCwd: dir, localAgentDir: agentDir, effectiveAutoExit: false, effectiveInteractive: true,
    inheritsConversationContext: false, taskDelivery: "artifact", identity: "ROLE_BODY",
    identityInSystemPrompt: true, systemPromptMode: "replace", roleBlock: "ROLE_BODY",
    denySet: __test__.resolveDenyTools({ name: "scout", spawning: false, denyTools: "write,edit" } as any),
    subagentsDir: dir, shellQuote: quote,
  };
  try { run(dir, context); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function reopen(dir: string, context: SubagentLaunchContext, id = "resume-run", message?: string) {
  return resumeLaunchContext(readPiLaunchProfile(context.subagentSessionFile), {
    id, name: "Follow up", message, surface: "new-pane", artifactDir: dir, subagentsDir: dir, shellQuote: quote,
  });
}

test("spawn persists resolved versioned nonsecret profile before dispatch", () => fixture((dir, context) => {
  const previous = process.env.PROFILE_TEST_SECRET;
  process.env.PROFILE_TEST_SECRET = "NEVER_SNAPSHOT_THIS";
  try {
    spawn(context);
    const raw = readFileSync(launchProfilePath(context.subagentSessionFile), "utf8");
    const profile = readPiLaunchProfile(context.subagentSessionFile);
    assert.equal(profile.version, 1);
    assert.equal(profile.harness, "pi");
    assert.equal(profile.role, "scout");
    assert.equal(profile.identity, "ROLE_BODY");
    assert.equal(profile.cwd, dir);
    assert.equal(profile.agentDir, context.localAgentDir);
    assert.equal(profile.tools, "read,bash,caller_ping,subagent_done");
    assert.deepEqual(profile.runtimePlan, context.runtimePlan);
    assert.equal(profile.autoExit, false);
    assert.equal(profile.interactive, true);
    for (const tool of ["subagent", "subagent_resume", "write", "edit"]) assert.ok(profile.denyTools.includes(tool));
    assert.ok(!raw.includes("NEVER_SNAPSHOT_THIS"));
    assert.ok(!raw.includes("ORIGINAL_ASSIGNMENT"));
    assert.throws(() => persistLaunchProfile(profile), /EEXIST/);
  } finally {
    if (previous === undefined) delete process.env.PROFILE_TEST_SECRET; else process.env.PROFILE_TEST_SECRET = previous;
  }
}));

test("closed resume shares command path and preserves restrictions despite mutable defaults/environment", () => fixture((dir, context) => {
  const driver = new PiHarnessDriver();
  spawn(context);
  const before = readFileSync(launchProfilePath(context.subagentSessionFile), "utf8");
  const history = '{"type":"session","version":3}\n{"type":"message","message":{"role":"user","content":"HISTORY"}}\n';
  writeFileSync(context.subagentSessionFile, history);
  context.agentDefs!.tools = "read,bash,write,edit";
  context.agentDefs!.body = "MUTATED_ROLE";
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "different-config");
  try {
    const resumed = reopen(dir, context, "resume-run", "NEW_MESSAGE");
    const built = driver.buildCommand(resumed);
    for (const value of ["--model 'test/model'", "--thinking 'high'", "--tools 'read,bash,caller_ping,subagent_done'", "PI_SUBAGENT_AGENT='scout'", "PI_SUBAGENT_AUTO_EXIT=0", `cd ${quote(dir)}`, `PI_CODING_AGENT_DIR=${quote(context.localAgentDir!)}`]) {
      assert.ok(built.command.includes(value), value);
    }
    assert.ok(built.command.includes(`PI_DENY_TOOLS=${quote([...context.denySet!].join(","))}`));
    assert.ok(!built.command.includes("/skill:"));
    const assignment = JSON.parse(readFileSync(join(dir, "context/subagent-assignment-resume-run.json"), "utf8"));
    assert.equal(assignment.task, "NEW_MESSAGE");
    assert.equal(assignment.childId, "resume-run");
    assert.deepEqual(assignment.skills, ["review"]);
    const promptFiles = readdirSync(join(dir, "context")).filter((file) => file.endsWith("resume-run.md"));
    const contents = promptFiles.map((file) => readFileSync(join(dir, "context", file), "utf8"));
    assert.ok(contents.includes("NEW_MESSAGE"));
    assert.ok(contents.includes("ROLE_BODY"));
    assert.ok(!contents.some((text) => text.includes("ORIGINAL_ASSIGNMENT") || text.includes("MUTATED_ROLE")));
    assert.equal(readFileSync(context.subagentSessionFile, "utf8"), history);
    assert.equal(readFileSync(launchProfilePath(context.subagentSessionFile), "utf8"), before);
    assert.equal(resumed.effectiveInteractive, true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
}));

test("every closed reopen has fresh run, assignment, activity and completion identity", () => fixture((dir, context) => {
  const driver = new PiHarnessDriver();
  spawn(context);
  for (const id of ["followup-a", "followup-b"]) {
    const { command } = driver.buildCommand(reopen(dir, context, id));
    assert.ok(command.includes(`PI_SUBAGENT_ID=${quote(id)}`));
    assert.ok(command.includes(`subagent-assignment-${id}.json`));
    assert.ok(command.includes(`${id}.json`));
    assert.ok(command.includes(`\u005f\u005fSUBAGENT_DONE_${id}_`));
    assert.ok(!command.includes("ORIGINAL_ASSIGNMENT"));
    const assignment = JSON.parse(readFileSync(join(dir, `context/subagent-assignment-${id}.json`), "utf8"));
    assert.equal(assignment.task, "");
  }
}));

test("legacy, corrupt, incomplete and future profiles reject with migration guidance", () => fixture((_dir, context) => {
  const path = launchProfilePath(context.subagentSessionFile);
  const profile = resolveLaunchProfile(context, "pi", "read");
  assert.throws(() => readPiLaunchProfile(context.subagentSessionFile), /legacy sessions cannot be safely resumed/);
  for (const value of ["invalid json", "null", JSON.stringify({ ...profile, version: 2 }), JSON.stringify({ ...profile, denyTools: undefined }), JSON.stringify({ ...profile, runtimePlan: {} })]) {
    writeFileSync(path, value);
    assert.throws(() => readPiLaunchProfile(context.subagentSessionFile), /launch profile/);
  }
}));

test("explicit completion survives closed resume; default workers and older profiles are automatic", () => fixture((dir, context) => {
  context.agentDefs!.completionMode = "explicit";
  const built = spawn(context);
  assert.match(built.command, /PI_SUBAGENT_COMPLETION_MODE=explicit/);
  assert.ok(built.command.includes(quote(join(dir, "index.ts"))));
  assert.equal(readPiLaunchProfile(context.subagentSessionFile).completionMode, "explicit");
  delete context.agentDefs!.completionMode;
  const driver = new PiHarnessDriver();
  const resume = reopen(dir, context);
  assert.match(driver.buildCommand(resume).command, /PI_SUBAGENT_COMPLETION_MODE=explicit/);
  const { completionMode: _explicit, ...legacy } = resume.launchProfile!;
  writeFileSync(launchProfilePath(context.subagentSessionFile), JSON.stringify(legacy));
  const automatic = driver.buildCommand(reopen(dir, context)).command;
  assert.match(automatic, /PI_SUBAGENT_COMPLETION_MODE=automatic/);
  assert.ok(!automatic.includes(quote(join(dir, "index.ts"))));
  writeFileSync(launchProfilePath(context.subagentSessionFile), JSON.stringify({ ...legacy, completionMode: "unknown" }));
  assert.throws(() => readPiLaunchProfile(context.subagentSessionFile), /Invalid or unsupported launch profile/);
}));

test("foreign harness resume rejects before attempting to parse foreign history", () => fixture((_dir, context) => {
  writeFileSync(context.subagentSessionFile, "NOT PI JSONL");
  for (const harness of ["claude", "codex", "generic"]) {
    writeFileSync(launchProfilePath(context.subagentSessionFile), JSON.stringify({ version: 1, harness }));
    assert.throws(() => readPiLaunchProfile(context.subagentSessionFile), /native resume or start a new subagent/);
  }
}));

test("profiles retain inherited deny restrictions and canonical session aliases", () => fixture((dir, context) => {
  const previous = process.env.PI_DENY_TOOLS;
  process.env.PI_DENY_TOOLS = "write, subagent";
  try {
    context.denySet = new Set();
    spawn(context);
    const alias = `${dir}-alias`;
    symlinkSync(dir, alias, "junction");
    try {
      const profile = readPiLaunchProfile(join(alias, "child.jsonl"));
      assert.deepEqual(profile.denyTools, ["write", "subagent"]);
      assert.equal(profile.sessionFile, canonicalSessionPath(context.subagentSessionFile));
    } finally { rmSync(alias, { recursive: true, force: true }); }
  } finally {
    if (previous === undefined) delete process.env.PI_DENY_TOOLS; else process.env.PI_DENY_TOOLS = previous;
  }
}));

test("internal queue preparation preserves immutable allocation through Pi profile and assignment reload", () => fixture((dir, context) => {
  const authority = { sessionId: randomUUID(), branchInstanceId: randomUUID() };
  let plan = planStore.createPlan("Queue", authority);
  const command = () => ({ ...authority, expectedRevision: plan.revision });
  const adapter = { available: () => true, inspect: () => ({ state: "working", owner: "runtime" } as const) };
  plan = planStore.configureQueue(plan, command(), 1);
  plan = planStore.addTask(plan, command(), "Task");
  const taskId = plan.tasks[0].taskId;
  plan = planStore.setWorkArea(plan, command(), taskId, dir, "read");
  plan = planStore.startAttempt(plan, command(), taskId, undefined, adapter);
  const binding = { planId: plan.planId, taskId, attemptId: plan.tasks[0].attempts[0].attemptId, authority };
  const rootRunId = context.params.id = randomUUID();
  const parent = { sessionFile: canonicalSessionPath(join(dir, "parent.jsonl")), sessionId: authority.sessionId };
  const child = { sessionFile: canonicalSessionPath(context.subagentSessionFile), sessionId: randomUUID() };
  context.lineage = { version: 1, parent, root: parent, child,
    rootAssignmentId: randomUUID(), rootCheckpoint: "checkpoint", rootBranchToken: randomUUID(), eventDirectory: dir };
  const ordinary = { ...resolveLaunchProfile(context, "pi", "read"), planTask: binding };
  assert.throws(() => queueChildProfile(plan, binding, rootRunId, ordinary), /no longer assigned/);
  plan = planStore.beginQueueDispatch(plan, command(), taskId, binding.attemptId, rootRunId, dir, adapter);
  const profile = context.launchProfile = queueChildProfile(plan, binding, rootRunId, ordinary);
  assert.equal(Object.isFrozen(profile.queueAllocation?.area), true);
  assert.equal(Object.isFrozen(profile.queueAllocation?.binding.authority), true);
  assert.throws(() => queueChildProfile(plan, binding, rootRunId, profile), /immutable/);
  assert.throws(() => assertQueueActiveResume(plan, profile, dir), /positive dispatch/);
  const driver = new PiHarnessDriver();
  assert.throws(() => driver.buildCommand(context), /original persisted Pi session/);
  persistLaunchProfile(profile);
  assert.equal(isQueueMarkedSession(child.sessionFile), true);
  assert.deepEqual(readPiLaunchProfile(child.sessionFile), profile);
  const built = driver.buildCommand(context);
  assert.match(built.command, new RegExp(`${QUEUE_CHILD_ENV}=1`));
  assert.throws(() => driver.buildCommand({ ...context, effectiveCwd: context.localAgentDir! }), /assigned CWD/);
  assert.throws(() => driver.buildCommand(reopen(dir, context)), /Queue-bound transport is unavailable/);
  assert.throws(() => persistProfileBinding(child.sessionFile, binding), /immutable/);
  const artifact = join(dir, `context/subagent-assignment-${rootRunId}.json`);
  const data = JSON.parse(readFileSync(artifact, "utf8"));
  assert.equal(isSubagentAssignment(data), true);
  assert.deepEqual(data.queueAllocation, profile.queueAllocation);
  assert.equal(isSubagentAssignment({ ...data, childId: randomUUID() }), false);
  assert.equal(isSubagentAssignment({ ...data, lineage: {} }), false);
  assert.equal(isSubagentAssignment({ ...data, queueAllocation: { ...data.queueAllocation, version: 2 } }), false);

  const saved = [process.env[ASSIGNMENT_ENV], process.env.PI_SUBAGENT_ID];
  const entries: any[] = [];
  const ctx = { sessionManager: { getSessionFile: () => child.sessionFile, getSessionId: () => child.sessionId, getEntries: () => entries } };
  let start: any;
  const api = { on: (_name: string, handler: Function) => { start = handler; }, registerEntryRenderer() {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
  try {
    process.env[ASSIGNMENT_ENV] = artifact;
    process.env.PI_SUBAGENT_ID = rootRunId;
    registerSubagentAssignment(api as any);
    start({}, { sessionManager: { ...ctx.sessionManager, getSessionId: () => "foreign" } });
    assert.equal(entries.length, 0);
    writeFileSync(artifact, JSON.stringify({ ...data, lineage: {} }));
    assert.doesNotThrow(() => start({}, ctx));
    assert.equal(entries.length, 0);
    writeFileSync(artifact, JSON.stringify(data));
    start({}, ctx);
    registerSubagentAssignment(api as any);
    start({ reason: "reload" }, ctx);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].data.queueAllocation, profile.queueAllocation);
  } finally {
    for (const [index, key] of [ASSIGNMENT_ENV, "PI_SUBAGENT_ID"].entries()) {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    }
  }

  plan = planStore.confirmQueueDispatch(plan, command(), taskId, binding.attemptId, rootRunId, adapter);
  assert.doesNotThrow(() => assertQueueActiveResume(plan, readPiLaunchProfile(child.sessionFile), dir));
  assert.throws(() => assertQueueActiveResume(plan, profile, context.localAgentDir!), /assigned CWD/);
  assert.throws(() => assertQueueWorkArea(profile.queueAllocation!, dir, "write", false), /access mode/);
  assert.throws(() => assertQueueActiveResume(planStore.queuePause(plan, command(), "Hold"), profile, dir), /paused/);
  const replaced = structuredClone(plan) as any;
  replaced.tasks[0].attempts[0].reservation.area.access = "write";
  assert.throws(() => assertQueueActiveResume(replaced, profile, dir), /stale/);
  replaced.tasks[0].attempts[0].reservation.area.access = "read";
  replaced.tasks[0].attempts[0].reservation.phase = "released";
  assert.throws(() => assertQueueActiveResume(replaced, profile, dir), /occupied allocation/);
  writeFileSync(launchProfilePath(child.sessionFile), JSON.stringify({ ...profile, queueAllocation: { ...data.queueAllocation, version: 2 } }));
  assert.throws(() => readPiLaunchProfile(child.sessionFile), /Invalid queue allocation/);
  assert.equal(isQueueMarkedSession(child.sessionFile), true);
}));

test("profile cannot be transplanted to a different session", () => fixture((dir, context) => {
  const profile = resolveLaunchProfile(context, "pi", "read");
  const other = join(dir, "other.jsonl");
  writeFileSync(launchProfilePath(other), JSON.stringify(profile));
  assert.throws(() => readPiLaunchProfile(other), /Invalid or unsupported launch profile/);
}));

test("registered resume tool rejects unsafe sessions and behavior overrides before dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-tool-profile-"));
  const tools = new Map<string, any>();
  const api = new Proxy({}, { get: (_target, key) => key === "registerTool"
    ? (tool: any) => tools.set(tool.name, tool) : () => {} });
  const previousDeny = process.env.PI_DENY_TOOLS;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_DENY_TOOLS;
  try { subagentsExtension(api as ExtensionAPI); } finally {
    if (previousDeny !== undefined) process.env.PI_DENY_TOOLS = previousDeny;
  }
  const execute = tools.get("subagent_resume").execute;
  const sessionPath = join(dir, "child.jsonl");
  const ctx = { cwd: dir };
  try {
    writeFileSync(sessionPath, "FOREIGN_TRANSCRIPT_NOT_JSON");
    await assert.rejects(execute("call", { sessionPath }, undefined, undefined, ctx), /legacy sessions cannot be safely resumed/);
    writeFileSync(launchProfilePath(sessionPath), JSON.stringify({ version: 1, harness: "claude" }));
    await assert.rejects(execute("call", { sessionPath }, undefined, undefined, ctx), /native resume/);
    fixture((_fixtureDir, context) => {
      const profile = { ...resolveLaunchProfile(context, "pi", "read"), sessionFile: canonicalSessionPath(sessionPath), agentDir: dir };
      writeFileSync(launchProfilePath(sessionPath), JSON.stringify(profile));
    });
    await assert.rejects(execute("call", { sessionPath, autoExit: true }, undefined, undefined, ctx), /preserve the saved autoExit/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Exercise the generated shell command against a real child process, without a provider or terminal dependency.
test("generated resume command runs with saved cwd, CLI flags and isolated environment", () => fixture((dir, context) => {
  const driver = new PiHarnessDriver();
  spawn(context);
  const capture = join(dir, "captured.json");
  const script = join(dir, "capture.cjs");
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),deny:process.env.PI_DENY_TOOLS,agent:process.env.PI_CODING_AGENT_DIR,autoExit:process.env.PI_SUBAGENT_AUTO_EXIT,id:process.env.PI_SUBAGENT_ID}));`);
  const { command } = driver.buildCommand(reopen(dir, context, "actual-run", "NEW_MESSAGE"));
  execFileSync("bash", ["-c", `pi() { ${quote(process.execPath.replaceAll("\\", "/"))} ${quote(script)} "$@"; }; ${command}`], { stdio: "pipe" });
  const captured = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(canonicalSessionPath(captured.cwd), canonicalSessionPath(dir), "Compare physical cwd, including Windows short-path aliases");
  assert.equal(captured.agent, context.localAgentDir);
  assert.equal(captured.autoExit, "0");
  assert.equal(captured.id, "actual-run");
  assert.equal(captured.deny, [...context.denySet!].join(","));
  assert.ok(captured.args.includes("read,bash,caller_ping,subagent_done"));
  assert.ok(!captured.args.some((value: string) => value.includes("ORIGINAL_ASSIGNMENT") || value.includes("/skill:")));
}));
