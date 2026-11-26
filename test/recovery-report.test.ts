import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { notifyRecoveryOnStartup, recoveryContext, recoveryReport, registerRecoveryReport, type RecoveryView } from "../pi-extension/subagents/recovery-report.ts";
import type { RuntimeManifest } from "../pi-extension/subagents/runtime-store.ts";

function manifest(): RuntimeManifest {
  return { schema: 1, revision: 1, generation: "g", parent: { sessionFile: "parent", headerId: "parent", checkpoint: "c", branchToken: "b" },
    runs: { run: { id: "run", name: "Unbound assignment", task: "Recover unfinished work", sessionFile: "child.jsonl", startTime: 1, phase: "dispatch-intent", eventCursor: [] } }, outbox: {} };
}

test("unbound assignments expose saved evidence and distinct delivery states without acceptance", () => {
  const saved = manifest();
  for (const status of ["pending", "dispatching", "handedOff"] as const) {
    saved.runs.run.eventCursor.push(status);
    saved.outbox[status] = { runId: "run", status, envelope: { message: { customType: "subagent_result", content: `retained ${status}`, details: { eventId: status } }, options: { triggerTurn: true, deliverAs: "steer" } } };
  }
  const before = structuredClone(saved);
  const report = recoveryReport({ manifest: saved }, { runId: "run" });
  for (const text of ["Unbound assignment", "Recover unfinished work", "child.jsonl", '"pending":1', '"unknown":1', '"handedOff":1', "retained pending", "NOT current liveness", "NOT task acceptance", "audit", "explicit subagent_resume"]) assert.ok(report.includes(text), text);
  assert.deepEqual(saved, before, "report is read-only");
});

test("bounded list/detail and meaningful context preserve Unicode and omit empty recovery", () => {
  const saved = manifest();
  for (let i = 0; i < 50; i++) saved.runs[`run${i}`] = { ...saved.runs.run, id: `run${i}`, task: '"\n😀'.repeat(20000), sessionFile: "x".repeat(10000) };
  const report = recoveryReport({ manifest: saved }, { limit: 20 });
  assert.ok(Buffer.byteLength(report) <= 24000);
  assert.match(report, /More assignments/);
  assert.ok(Buffer.byteLength(recoveryReport({ manifest: saved }, { runId: "run1" })) <= 24000);
  for (const options of [{ limit: 21 }, { limit: 0 }, { offset: -1 }, { offset: NaN }]) assert.throws(() => recoveryReport({ manifest: saved }, options), /bounds/);
  const context = recoveryContext({ manifest: saved })!;
  assert.ok(Buffer.byteLength(context) <= 4096);
  assert.equal(context.isWellFormed(), true);
  assert.equal(recoveryContext({}), undefined);
  assert.match(recoveryContext({ diagnostics: ["Task import pending: revision conflict"] })!, /Task import pending/);
});

test("blocked and paused diagnostics grant no control; missing legacy manifests are explicit", async () => {
  assert.doesNotMatch(recoveryReport({ manifest: manifest(), error: "foreign branch" }), /Unbound assignment/);
  assert.match(recoveryReport({ manifest: manifest(), paused: "custody decision" }), /Paused diagnostics only/);
  assert.match(recoveryReport({}), /Legacy\/missing/);
  const tools: any[] = [], hooks = new Map(), commands: any[] = [];
  // Any control, send, or mutation API access would throw.
  registerRecoveryReport(new Proxy({ registerTool: (tool: any) => tools.push(tool), registerCommand: (...args: any[]) => commands.push(args), on: (name: string, hook: any) => hooks.set(name, hook) }, { get(target, key) { assert.ok(key in target, `unexpected API ${String(key)}`); return (target as any)[key]; } }) as any, () => ({ error: "Host unavailable" }));
  const result = await tools[0].execute("id", {}, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Host unavailable/);
  assert.equal(commands[0][0], "subagents-recovery");
  assert.equal(hooks.size, 3);
  assert.ok(hooks.has("context")); assert.ok(hooks.has("before_agent_start")); assert.ok(hooks.has("turn_end"));
});

test("startup acknowledgement is explicit, branch-local, and tied to saved evidence, not manifest revision", async () => {
  const saved = manifest();
  const view: RecoveryView = { manifest: saved };
  const entries: any[] = [], notices: string[] = [], commands = new Map<string, any>();
  const pi = { registerTool() {}, on() {}, registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
  let branch = entries;
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { notify: (message: string) => notices.push(message) } } as any;
  registerRecoveryReport(pi as any, () => view);
  const ack = commands.get("subagents-recovery-ack").handler;
  const warn = () => {
    notices.length = 0;
    notifyRecoveryOnStartup(ctx, view);
    return notices.some(notice => notice.includes("Saved subagent assignments found"));
  };
  assert.equal(warn(), true);
  await commands.get("subagents-recovery").handler("", ctx);
  assert.equal(entries.length, 0);
  assert.equal(warn(), true);
  await ack("unexpected argument", ctx);
  assert.equal(entries.length, 0);
  await ack("", ctx);
  await ack("", ctx);
  assert.equal(entries.length, 1, "acknowledging the same state is idempotent");
  assert.deepEqual(Object.keys(entries[0].data), ["fingerprint"]);
  saved.revision++;
  saved.generation = "replacement-generation";
  assert.equal(warn(), false);
  branch = [];
  assert.equal(warn(), true, "a sibling branch does not inherit the receipt");
  branch = entries;
  saved.parent.headerId = "another-session";
  assert.equal(warn(), true, "a copied receipt is not usable in another session");
  saved.parent.headerId = "parent";
  assert.equal(warn(), false);
  view.storageError = "EPERM";
  assert.equal(warn(), true);
  await ack("", ctx);
  assert.equal(entries.length, 1, "an uncertain storage view cannot be acknowledged");
  delete view.storageError;
  saved.runs.run.reconciliation = "exited: decision required before another writer";
  assert.equal(warn(), true);
  await ack("", ctx);
  saved.runs.run.eventCursor.push("e");
  saved.outbox.e = { runId: "run", status: "pending", envelope: { message: { customType: "subagent_result", content: "new result", details: { eventId: "e" } }, options: { triggerTurn: true, deliverAs: "steer" } } };
  assert.equal(warn(), true);
  await ack("", ctx);
  saved.outbox.e.status = "handedOff";
  assert.equal(warn(), true);
  await ack("", ctx);
  saved.runs.other = { ...saved.runs.run, id: "other", eventCursor: [] };
  assert.equal(warn(), true);
  await ack("", ctx);
  view.dispatch = [{ runId: "missing", status: "dispatch-unknown", code: "NO_DURABLE_RUN", next: "Review evidence" }];
  assert.equal(warn(), true);
});

test("real Pi RPC keeps recovery available after acknowledging and reloading without a model turn", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "recovery-report-rpc-"));
  const session = join(directory, "parent.jsonl");
  const saved = manifest();
  saved.parent.sessionFile = canonicalSessionPath(session);
  const timestamp = new Date().toISOString();
  writeFileSync(session, [
    { type: "session", version: 3, id: "parent", timestamp, cwd: directory },
    { type: "message", id: "u", parentId: null, timestamp, message: { role: "user", content: "Original assignment", timestamp: Date.now() } },
    { type: "custom", id: "c", parentId: "u", timestamp, customType: "subagent-custody", data: { branchToken: "b" } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const artifacts = join(directory, "artifacts", "parent", "subagent-runtime");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(saved));
  // RPC exposes the native reload action through ExtensionCommandContext.
  const reloadExtension = join(directory, "test-reload.ts");
  writeFileSync(reloadExtension, `export default pi => {
    pi.registerCommand("test-reload", { async handler(_args, ctx) { await ctx.reload(); } });
    pi.on("session_start", (event, ctx) => { if (event.reason === "reload") ctx.ui.notify("Test reload completed", "info"); });
  };`);
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT") && !key.startsWith("HC_") && !key.startsWith("HERDR") && key !== "PI_DENY_TOOLS"));
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", session, "--session-dir", directory,
    "--no-extensions", "-e", resolve("pi-extension/subagents/index.ts"), "-e", reloadExtension, "--no-mcp", "--no-skills", "--no-context-files", "--offline"], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { errors += data; });
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 25000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `${output}\n${errors}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  try {
    child.stdin.write(JSON.stringify({ id: "ready", type: "get_commands" }) + "\n");
    await until(() => output.includes('"id":"ready"'));
    assert.match(output, /Saved subagent assignments found/);
    assert.match(output, /subagents-recovery/);
    child.stdin.write(JSON.stringify({ id: "report", type: "prompt", message: "/subagents-recovery run" }) + "\n");
    await until(() => output.includes("Unbound assignment"));
    assert.match(output, /Recover unfinished work/);
    assert.match(output, /NOT current liveness/);
    child.stdin.write(JSON.stringify({ id: "reconcile", type: "prompt", message: "/subagents-reconcile" }) + "\n");
    await until(() => output.includes("Reconciliation dispatch-unknown"));
    assert.match(output, /run: dispatch-unknown \(DISPATCH_INTENT\)/);
    assert.match(output, /no child was relaunched or sent a command/);
    const beforeAck = readFileSync(join(artifacts, "manifest.json"), "utf8");
    child.stdin.write(JSON.stringify({ id: "ack", type: "prompt", message: "/subagents-recovery-ack" }) + "\n");
    await until(() => output.includes("Recovery notice acknowledged") && output.includes('"id":"ack"'));
    assert.equal(readFileSync(join(artifacts, "manifest.json"), "utf8"), beforeAck);
    assert.match(readFileSync(session, "utf8"), /"customType":"pi-subagents-recovery-notice-ack\/v1","data":\{"fingerprint":"[0-9a-f]{64}"\}/);
    const beforeReload = output.length;
    child.stdin.write(JSON.stringify({ id: "reload", type: "prompt", message: "/test-reload" }) + "\n");
    await until(() => output.includes("Test reload completed") && output.includes('"id":"reload"'));
    assert.doesNotMatch(output.slice(beforeReload), /Saved subagent assignments found/);
    const afterReload = output.length;
    child.stdin.write(JSON.stringify({ id: "report-again", type: "prompt", message: "/subagents-recovery run" }) + "\n");
    await until(() => output.slice(afterReload).includes("Unbound assignment"));
    assert.doesNotMatch(output, /"type":"agent_start"/);
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timeout);
    rmSync(directory, { recursive: true, force: true });
  }
});
