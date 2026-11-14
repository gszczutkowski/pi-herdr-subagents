import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test, mock } from "node:test";

// Exercise actual tool/terminal code, replacing only OS boundaries (no live herdr).
let prepareFails = false;
let sendFails = false;
let serial = 0;
let inspect: (pane: string) => Promise<string> = async () => JSON.stringify({ error: { code: "pane_not_found" } });
const closed: string[] = [];
const sent: string[] = [];
const originalWrite = fs.writeFileSync;
mock.method(fs, "writeFileSync", (path: any, ...args: any[]) => {
  if (prepareFails && String(path).endsWith(".sh")) throw new Error("preparation failed");
  return (originalWrite as any)(path, ...args);
});
mock.method(childProcess, "execSync", () => "herdr");
mock.method(childProcess, "execFileSync", (_command: any, args: any) => {
  if (args[0] === "tab" && args[1] === "create") {
    return JSON.stringify({ result: { root_pane: { pane_id: `child-${++serial}` } } });
  }
  if (args[1] === "run") {
    sent.push(args[2]);
    if (sendFails) throw new Error("ambiguous send failure");
  }
  if (args[1] === "close") closed.push(args[2]);
  return "";
});
const originalExec = childProcess.execFile;
childProcess.execFile = Object.assign(() => { throw new Error("unexpected execFile"); }, {
  [promisify.custom]: async (_command: string, args: string[]) => ({ stdout: args[1] === "get" ? await inspect(args[2]) : "" }),
}) as any;
syncBuiltinESMExports();
const { default: extension, __test__ } = await import("../pi-extension/subagents/index.ts");
const { canonicalSessionPath, reserveSession, releaseSession, sessionOwners } = await import("../pi-extension/subagents/ownership.ts");
const { persistLaunchProfile, resolveLaunchProfile } = await import("../pi-extension/subagents/launch-profile.ts");
const { runCompletionFile } = await import("../pi-extension/subagents/run-artifacts.ts");
const { runInPane, runScriptInPane } = await import("../pi-extension/subagents/terminal.ts");
const keys = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_SUBAGENT_SHELL_READY_DELAY_MS", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "workspace";
process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT"]) delete process.env[key];
after(() => {
  mock.restoreAll();
  childProcess.execFile = originalExec;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function fixture(run: (f: any) => Promise<void>) {
  const dir = fs.mkdtempSync(join(tmpdir(), "ownership-execute-"));
  const agentDir = join(dir, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const session = canonicalSessionPath(join(dir, "child.jsonl"));
  fs.writeFileSync(session, '{"type":"session","version":3,"id":"child","cwd":"test"}\n');
  const context: any = {
    params: { id: "original", name: "Original" }, runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
    effectiveCwd: dir, effectiveAutoExit: false, effectiveInteractive: true, taskDelivery: "artifact",
    subagentSessionFile: session, localAgentDir: agentDir, denySet: new Set(),
  };
  persistLaunchProfile(resolveLaunchProfile(context, "pi", "read"));
  const existingOwners = new Set(sessionOwners.keys());
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const api: any = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: any) => tools.set(tool.name, tool)
    : key === "on" ? (event: string, handler: any) => handlers.set(event, handler)
    : key === "getThinkingLevel" ? () => "off" : () => {} });
  extension(api);
  const ctx = {
    cwd: dir, model: { provider: "test", id: "model" },
    modelRegistry: { find: () => ({ provider: "test", id: "model", reasoning: true }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => session, getSessionDir: () => dir, getSessionId: () => "parent" },
  };
  const resume = () => tools.get("subagent_resume").execute("call", { sessionPath: session }, undefined, undefined, ctx);
  try { await run({ dir, session, ctx, resume }); } finally {
    prepareFails = false;
    sendFails = false;
    handlers.get("session_shutdown")({ reason: "exit" }, ctx);
    for (const [path, owner] of sessionOwners) if (!existingOwners.has(path)) releaseSession(path, owner.runId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "condition timed out"); await pause(); }
}

test("real resume execute: completion retains ownership, closed pane inspection unlocks fresh resume", async () => fixture(async ({ session, resume }: any) => {
  const first = await resume();
  const owner = sessionOwners.get(session)!;
  assert.equal(owner.dispatched, true);
  fs.writeFileSync(runCompletionFile(session, first.details.id), JSON.stringify({ type: "done", runId: first.details.id, keepOpen: true }));
  await until(() => __test__.runningSubagents.get(first.details.id)?.lifecycle?.process?.completion != null);
  assert.equal(sessionOwners.get(session), owner, "logical completion is not process exit");
  const second = await resume();
  assert.equal(second.details.status, "started");
  assert.notEqual(second.details.id, first.details.id);
  assert.notEqual(sessionOwners.get(session)!.surface, owner.surface);
}));

test("awaited inspection cannot release a replacement ownership token", async () => fixture(async ({ session, resume }: any) => {
  const old = reserveSession(session, "old"); old.surface = "closed";
  let finish!: (value: string) => void;
  let inspecting = false;
  inspect = async () => { inspecting = true; return new Promise((resolve) => { finish = resolve; }); };
  try {
    const pending = resume();
    await until(() => inspecting);
    releaseSession(session, "old");
    const replacement = reserveSession(session, "old"); replacement.surface = "replacement";
    finish(JSON.stringify({ error: { code: "pane_not_found" } }));
    await assert.rejects(pending, /already owned/);
    assert.equal(sessionOwners.get(session), replacement);
  } finally { inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } }); }
}));

test("no-owner resumes reserve synchronously before yielding", async () => fixture(async ({ resume }: any) => {
  inspect = async (pane) => JSON.stringify({ result: { pane: { pane_id: pane, agent_status: "working" } } });
  try {
    const first = resume();
    await assert.rejects(resume(), /already owned/);
    assert.equal((await first).details.status, "started");
  } finally { inspect = async () => JSON.stringify({ error: { code: "pane_not_found" } }); }
}));

test("resume preparation failure closes new surface and unlocks; ambiguous send retains owner", async () => fixture(async ({ session, resume }: any) => {
  prepareFails = true;
  const before = sent.length;
  await assert.rejects(resume(), /preparation failed/);
  assert.equal(sessionOwners.has(session), false);
  assert.ok(closed.includes(`child-${serial}`));
  assert.equal(sent.length, before);
  prepareFails = false; sendFails = true;
  await assert.rejects(resume(), /ambiguous send failure/);
  const owner = sessionOwners.get(session)!;
  assert.equal(owner.dispatched, true);
  assert.ok(!closed.includes(owner.surface!));
}));

test("spawn preparation cleanup respects caller-owned surfaces; ambiguous sends retain ownership", async () => fixture(async ({ ctx }: any) => {
  const params: any = { name: "Spawn", task: "task", cwd: ctx.cwd };
  prepareFails = true;
  await assert.rejects(__test__.launchSubagent(params, ctx, "off"), /preparation failed/);
  assert.ok(closed.includes(`child-${serial}`));
  await assert.rejects(__test__.launchSubagent(params, ctx, "off", { surface: "provided" }), /preparation failed/);
  assert.ok(!closed.includes("provided"));
  assert.equal([...sessionOwners.values()].filter((owner) => owner.surface === "provided").length, 0);
  prepareFails = false; sendFails = true;
  await assert.rejects(__test__.launchSubagent(params, ctx, "off"), /ambiguous send failure/);
  const owner = [...sessionOwners.values()].find((entry) => entry.surface === `child-${serial}`)!;
  assert.equal(owner.dispatched, true);
  assert.ok(!closed.includes(owner.surface!));
}));

test("terminal dispatch callbacks follow preparation and preflight, but precede ambiguous send", async () => fixture(async ({ dir }: any) => {
  let dispatched = false;
  prepareFails = true;
  assert.throws(() => runScriptInPane("target", "true", { scriptPath: join(dir, "launch.sh"), onDispatch: () => { dispatched = true; } }), /preparation failed/);
  assert.equal(dispatched, false);
  const env = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  assert.throws(() => runInPane("target", "true", () => { dispatched = true; }), /not available/);
  assert.equal(dispatched, false);
  process.env.HERDR_ENV = env;
  prepareFails = false; sendFails = true;
  assert.throws(() => runScriptInPane("target", "true", { scriptPath: join(dir, "launch.sh"), onDispatch: () => { dispatched = true; } }), /ambiguous send failure/);
  assert.equal(dispatched, true);
}));
