import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { auditSession, assertSessionWriters, piSessionArgument, windowsArgv } from "../pi-extension/subagents/session-audit.ts";
import { probeProcess } from "../pi-extension/subagents/process-identity.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const identity = { pid: 123, birth: "original" };
const probe = () => ({ kind: "present" as const, identity });

test("literal argv parsing excludes eval and option payload mentions; unknown relative paths fail closed", () => {
  const session = resolve("audit-test.jsonl");
  const row = (args: string[]) => ({ pid: 123, parentPid: 1, argv: [process.execPath, ...args] });
  assert.equal(piSessionArgument(row(["-e", `require('${cli}')`, "--session", session])).kind, "other");
  assert.equal(piSessionArgument(row([cli, "--system-prompt", "--session", session])).kind, "other");
  assert.equal(piSessionArgument(row([cli, "--", "--session", session])).kind, "other");
  assert.equal(piSessionArgument(row([cli, "--session", "relative.jsonl"])).kind, "uncertain");
  assert.equal(piSessionArgument(row([cli, "--session", "partial-uuid"])).kind, "uncertain");
  assert.deepEqual(windowsArgv('node.exe "C:\\Program Files\\pi\\cli.js" --session "C:\\a b\\x.jsonl"'), ["node.exe", "C:\\Program Files\\pi\\cli.js", "--session", "C:\\a b\\x.jsonl"]);
  assert.equal(auditSession(session, { rows: [], verified: false }).status, "uncertain");
});

test("duplicate, PID reuse and bounded identities never grant resume permission", () => {
  const session = resolve("audit-test.jsonl");
  const rows = Array.from({ length: 40 }, (_, i) => ({ pid: i + 1, parentPid: 0, argv: [process.execPath, cli, "--session", session] }));
  const audit = auditSession(session, { rows, verified: true }, probe);
  assert.equal(audit.status, "duplicate"); assert.equal(audit.ownerCount, 40); assert.equal(audit.owners.length, 32);
  assert.throws(() => assertSessionWriters(audit, identity), /audit is duplicate/);
  const single = auditSession(session, { rows: rows.slice(0, 1), verified: true }, probe);
  assert.doesNotThrow(() => assertSessionWriters(single, identity));
  assert.throws(() => assertSessionWriters(single, { ...identity, birth: "reused" }), /audit is single/);
});

test("real separate Pi RPC processes sharing one file are audited, including canonical aliases", { timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-audit-processes-"));
  const session = join(dir, "session.jsonl");
  writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "audit-fixture", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  const aliasDirectory = `${dir}-alias`;
  symlinkSync(dir, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
  const alias = join(aliasDirectory, "session.jsonl");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT") && !key.startsWith("HC_") && !key.startsWith("HERDR")));
  const children = [session, alias].map(path => spawn(process.execPath, [cli, "--mode", "rpc", "--session", path, "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--offline"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] }));
  for (const child of children) { child.stdout.resume(); child.stderr.resume(); }
  try {
    for (const child of children) {
      const ready = new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("Pi RPC startup timeout")), 20000);
        child.stdout.on("data", (data) => { if (data.toString().includes('"type":"response"')) { clearTimeout(timer); resolveReady(); } });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Pi exited before ready: ${code}`)); });
      });
      child.stdin.write(JSON.stringify({ type: "get_state", id: "ready" }) + "\n"); await ready;
    }
    const audit = auditSession(session);
    assert.equal(audit.ownerCount, 2);
    assert.equal(audit.status, "duplicate");
    for (const child of children) assert.ok(audit.owners.some(owner => owner.pid === child.pid));
    const original = probeProcess(children[0].pid!);
    assert.equal(original.kind, "present");
    children[0].kill(); await new Promise(resolveExit => children[0].once("exit", resolveExit));
    assert.equal(probeProcess(children[0].pid!).kind, "absent");
    assert.equal(auditSession(session).ownerCount, 1);
  } finally {
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise<void>(resolveExit => { child.once("exit", () => resolveExit()); child.kill(); })));
    rmSync(aliasDirectory, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
