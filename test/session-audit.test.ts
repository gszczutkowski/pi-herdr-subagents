import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
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

const installedRoot = join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent");
const installedPackage = existsSync(join(installedRoot, "package.json")) ? JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) : undefined;
const installedCli = installedPackage && join(installedRoot, installedPackage.bin.pi);
for (const [label, entry] of [["local dist/cli", cli], ["installed declared bin", installedCli]] as const) {
test(`real ${label} Pi RPC processes sharing one file are audited, including canonical aliases`, { timeout: 60000, skip: !entry }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-audit-processes-"));
  const session = join(dir, "session.jsonl");
  writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "audit-fixture", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  const aliasDirectory = `${dir}-alias`;
  symlinkSync(dir, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
  const alias = join(aliasDirectory, "session.jsonl");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_SUBAGENT") && !key.startsWith("HC_") && !key.startsWith("HERDR")));
  const children = [session, alias].map(path => spawn(process.execPath, [entry!, "--mode", "rpc", "--session", path, "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--offline"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] }));
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
}

test("owning package bin verification supports bundles/aliases, rejects same-package decoys and scopes unknown VM flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bin-audit-"));
  try {
    const session = join(dir, "session.jsonl");
    const row = (args: string[]) => ({ pid: 123, parentPid: 1, cwd: dir, argv: [process.execPath, ...args] });
    const unrelated = join(dir, "unrelated.js"); writeFileSync(unrelated, "");
    assert.equal(piSessionArgument(row(["--max-old-space-size=8192", unrelated, "--session", session])).kind, "other");
    assert.equal(piSessionArgument(row(["--unknown-vm", "denied-value", cli, "--session", session])).kind, "uncertain");
    assert.equal(piSessionArgument(row(["--unknown-vm", cli, "--session", session])).kind, "uncertain");
    assert.equal(piSessionArgument(row([cli, `--session=${session}`])).kind, "uncertain", "Pi 1.5 CLI does not support equals spelling");
    assert.equal(piSessionArgument({ pid: 123, parentPid: 1 }).kind, "uncertain");
    assert.equal(piSessionArgument(row([join(dir, "denied.js"), "--session", session])).kind, "uncertain");
    for (const layout of ["dist/cli.js", "dist/bundle/cli.js"]) {
      const root = join(dir, layout.includes("bundle") ? "bundle" : "flat");
      const bin = join(root, layout); mkdirSync(dirname(bin), { recursive: true }); writeFileSync(bin, "");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: layout } }));
      const aliasRoot = `${root}-alias`; symlinkSync(root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      assert.equal(piSessionArgument(row([join(aliasRoot, layout), "--session", session])).kind, "session");
      const decoy = join(dirname(bin), "other-cli.js"); writeFileSync(decoy, "");
      assert.equal(piSessionArgument(row([decoy, "--session", session])).kind, "other");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
