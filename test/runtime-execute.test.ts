import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real registered tools, command builder, watcher and outbox. Only OS transport
// and the Pi host boundary are replaced; no live terminal or model is used.
test("spawn and closed-session resume durably record intent before terminal dispatch", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "runtime-execute-"));
  const savedEnv = { ...process.env };
  const originalExec = childProcess.execFile;
  let serial = 0;
  let manifestFile = "";
  let dispatches = 0;
  let closes = 0;
  mock.method(childProcess, "execSync", () => "herdr");
  mock.method(childProcess, "execFileSync", (_command: any, args: string[]) => {
    if (args[0] === "tab" && args[1] === "create") return JSON.stringify({ result: { root_pane: { pane_id: `pane-${++serial}` } } });
    if (args[1] === "close") closes++;
    if (args[1] === "run") {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      assert.ok(Object.values(manifest.runs).some((run: any) => run.surface === args[2] && run.phase === "dispatch-intent"));
      dispatches++;
    }
    return "";
  });
  childProcess.execFile = Object.assign(() => { throw new Error("unexpected transport"); }, {
    [promisify.custom]: async () => ({ stdout: JSON.stringify({ result: { pane: { pane_id: "pane", agent_status: "idle" } } }) }),
  }) as any;
  syncBuiltinESMExports();
  process.env.HERDR_ENV = "1"; process.env.HERDR_WORKSPACE_ID = "test";
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "PI_DENY_TOOLS", "PI_SUBAGENT_LAYOUT"]) delete process.env[key];
  const tools = new Map<string, any>(); const handlers = new Map<string, any>(); const branch: any[] = [];
  const notifications: any[] = [];
  const parent = join(dir, "parent.jsonl");
  fs.writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\n");
  manifestFile = join(dir, "artifacts", "parent", "subagent-runtime", "manifest.json");
  const api: any = new Proxy({}, { get: (_, key) => key === "registerTool" ? (tool: any) => tools.set(tool.name, tool)
    : key === "on" ? (name: string, handler: any) => handlers.set(name, handler)
    : key === "getAllTools" ? () => [] : key === "getThinkingLevel" ? () => "off"
    : key === "appendEntry" ? (customType: string, data: any) => branch.push({ id: "custody", type: "custom", customType, data })
    : key === "sendMessage" ? (message: any) => notifications.push(message) : () => {} });
  const ctx: any = { hasUI: false, isIdle: () => false, scopedModels: [], cwd: dir, model: { provider: "test", id: "model" },
    modelRegistry: { find: () => ({ provider: "test", id: "model", reasoning: true }), getAvailable: () => [{ provider: "test", id: "model" }], hasConfiguredAuth: () => true },
    sessionManager: { getHeader: () => ({ id: "parent" }), getBranch: () => branch,
      getSessionFile: () => parent, getSessionDir: () => dir, getSessionId: () => "parent" } };
  const { default: extension, __test__ } = await import("../pi-extension/subagents/index.ts");
  const { canonicalSessionPath, releaseSession } = await import("../pi-extension/subagents/ownership.ts");
  const { persistLaunchProfile, resolveLaunchProfile } = await import("../pi-extension/subagents/launch-profile.ts");
  const { runCompletionFile } = await import("../pi-extension/subagents/run-artifacts.ts");
  extension(api);
  try {
    handlers.get("session_start")({ reason: "startup" }, ctx);
    const spawned = await tools.get("subagent").execute("spawn", { name: "Durable", task: "one", cwd: dir, agentDir: dir }, undefined, undefined, ctx);
    assert.ok(spawned.details.id);
    const saved = canonicalSessionPath(join(dir, "saved.jsonl"));
    fs.writeFileSync(saved, JSON.stringify({ type: "session", version: 3, id: "saved", cwd: dir }) + "\n");
    persistLaunchProfile(resolveLaunchProfile({ params: { id: "original", name: "Saved" },
      runtimePlan: { provider: "test", modelId: "model", model: "test/model", thinking: "off", modelSource: "parent", thinkingSource: "parent" },
      effectiveCwd: dir, effectiveAutoExit: false, effectiveInteractive: true, taskDelivery: "artifact", subagentSessionFile: saved, localAgentDir: dir, denySet: new Set(),
    } as any, "pi", "read"));
    const resumed = await tools.get("subagent_resume").execute("resume", { sessionPath: saved, message: "two" }, undefined, undefined, ctx);
    assert.equal(dispatches, 2);
    const child = __test__.runningSubagents.get(resumed.details.id)!;
    const events = `${runCompletionFile(saved, child.id)}.events`;
    fs.mkdirSync(events, { recursive: true });
    const structuredResult = { status: "complete", summary: "Short structured proposal", artifacts: [], checks: [], unmetCriterionIds: [], risks: [] };
    for (const [index, eventId] of ["turn-a", "turn-b"].entries()) {
      fs.writeFileSync(join(events, `${index}.json`), JSON.stringify({ type: "done", runId: child.id, eventId,
        summary: `Detailed assistant final ${eventId}`, structuredResult, keepOpen: true }));
    }
    const deadline = Date.now() + 5000;
    while (notifications.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(notifications.length, 2);
    for (const [index, notification] of notifications.entries()) {
      assert.equal(notification.details.response, `Detailed assistant final ${["turn-a", "turn-b"][index]}`);
      assert.deepEqual(notification.details.structuredResult, structuredResult);
      assert.match(notification.content, /proposal, requires parent review/);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(Object.keys(manifest.outbox).length, 2);
    for (const notification of notifications) {
      assert.deepEqual(manifest.outbox[notification.details.eventId].envelope.message, JSON.parse(JSON.stringify(notification)));
    }
    assert.equal(manifest.runs[child.id].entryCountBefore, 1);
    assert.ok(Object.values(manifest.outbox).every((event: any) => event.status === "handedOff"));
    assert.equal(fs.readdirSync(events).length, 2, "immutable child events retained");
    const closesBeforeTree = closes;
    handlers.get("session_before_tree")({}, ctx);
    assert.notEqual(child.terminalActionsAllowed, false, "pending navigation is only provisional suspension");
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, "utf8")).custodyPaused, undefined);
    branch.length = 0; // Host confirms navigation to a different custody lineage.
    await handlers.get("session_tree")({}, ctx);
    assert.equal(child.terminalActionsAllowed, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(closes, closesBeforeTree, "losing branch custody cannot close a potentially reused pane");
    await assert.rejects(tools.get("subagent_resume").execute("blocked", { sessionPath: saved }, undefined, undefined, ctx), /branch decision/);
    assert.equal(dispatches, 2, "navigation never relaunches a task");
  } finally {
    handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    for (const child of __test__.runningSubagents.values()) releaseSession(child.sessionFile, child.id);
    await new Promise((r) => setTimeout(r, 30));
    childProcess.execFile = originalExec; mock.restoreAll(); syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
