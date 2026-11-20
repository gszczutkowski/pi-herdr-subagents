import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { auditSession, assertSessionWriters, enumerateProcesses, piSessionArgument, windowsArgv } from "../pi-extension/subagents/session-audit.ts";
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
  assert.equal(piSessionArgument(row(["--unknown-vm", "unresolved-relative-unrelated.js", "test-server"])).kind, "other", "complete argv without a session selector is outside explicit-owner coverage");
  assert.equal(piSessionArgument(row(["--unknown-vm", "unresolved-relative.js", "--session", session])).kind, "uncertain", "unresolved potential explicit owner must not be cleared");
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
    if (process.platform === "linux") {
      // Native Pi sets process.title, overwriting Linux's original argv region.
      // OS evidence cannot recover --session, so never claim known owners.
      assert.equal(audit.ownerCount, 0);
      assert.equal(audit.status, "uncertain");
      assert.ok(audit.uncertainCount >= 2);
      assert.throws(() => assertSessionWriters(audit), /audit is uncertain/);
    } else {
      assert.equal(audit.ownerCount, 2);
      assert.equal(audit.status, "duplicate");
      for (const child of children) assert.ok(audit.owners.some(owner => owner.pid === child.pid));
    }
    const original = probeProcess(children[0].pid!);
    assert.equal(original.kind, "present");
    const firstExit = new Promise(resolveExit => children[0].once("exit", resolveExit));
    children[0].stdin.end(); await firstExit; // RPC EOF invokes graceful runtime shutdown.
    assert.equal(probeProcess(children[0].pid!).kind, "absent");
    const remaining = auditSession(session);
    if (process.platform === "linux") {
      assert.equal(remaining.ownerCount, 0);
      assert.equal(remaining.status, "uncertain");
      assert.throws(() => assertSessionWriters(remaining), /audit is uncertain/);
    } else assert.equal(remaining.ownerCount, 1);
  } finally {
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise<void>(resolveExit => { child.once("exit", () => resolveExit()); child.stdin.end(); })));
    rmSync(aliasDirectory, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
}

test("Linux proc boundary excludes irrelevant denied exe links but fails closed for genuine/unknown candidates", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalRead = fs.readFileSync;
  const originalLink = fs.readlinkSync;
  const originalReaddir = fs.readdirSync;
  const session = resolve("audit-proc-test.jsonl");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
  type Fixture = { cmdline: string | Error; exe: string | Error; stat?: Error; cwd?: Error };
  const candidate: Fixture = { cmdline: [process.execPath, cli, "--session", session, ""].join("\0"), exe: "/usr/bin/node" };
  let fixture: Fixture = candidate;
  let directoryError: Error | undefined;
  let exeReads = 0;
  const value = (input: string | Error) => { if (input instanceof Error) throw input; return input; };
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    t.mock.method(fs, "readdirSync", ((path: any, ...args: any[]) => {
      if (path === "/proc") { if (directoryError) throw directoryError; return ["self", "123"]; }
      return (originalReaddir as any)(path, ...args);
    }) as typeof fs.readdirSync);
    t.mock.method(fs, "readFileSync", ((path: any, ...args: any[]) => {
      if (path === "/proc/123/cmdline") return value(fixture.cmdline);
      if (path === "/proc/123/stat") return value(fixture.stat ?? "123 (arbitrary renamed title) S 1 0");
      return (originalRead as any)(path, ...args);
    }) as typeof fs.readFileSync);
    t.mock.method(fs, "readlinkSync", ((path: any, ...args: any[]) => {
      if (path === "/proc/123/exe") { exeReads++; return value(fixture.exe); }
      if (path === "/proc/123/cwd") return value(fixture.cwd ?? process.cwd());
      return (originalLink as any)(path, ...args);
    }) as typeof fs.readlinkSync);
    syncBuiltinESMExports();
    const cases: { label: string; row: Fixture; status: string; owners?: number; noExe?: boolean }[] = [
      { label: "readable explicit owner despite renamed comm", row: candidate, status: "single", owners: 1 },
      { label: "system service without selector and denied exe", row: { cmdline: "/usr/sbin/service\0--foreground\0", exe: denied }, status: "clear", noExe: true },
      { label: "node without selector and denied exe", row: { cmdline: "node\0server.js\0", exe: denied }, status: "clear", noExe: true },
      { label: "denied argv but verified unrelated exe", row: { cmdline: denied, exe: "/usr/bin/python3" }, status: "clear" },
      { label: "denied node argv", row: { ...candidate, cmdline: denied }, status: "uncertain" },
      { label: "empty node argv is not evidence of irrelevance", row: { ...candidate, cmdline: "" }, status: "uncertain" },
      { label: "Pi process.title erases original selectors on Linux", row: { ...candidate, cmdline: "pi\0\0\0" }, status: "uncertain" },
      { label: "arbitrary renamed Node title is not complete argv", row: { ...candidate, cmdline: "custom worker title\0" }, status: "uncertain" },
      { label: "denied candidate exe", row: { ...candidate, exe: denied }, status: "uncertain" },
      { label: "denied unknown argv and exe", row: { cmdline: denied, exe: denied }, status: "uncertain" },
      { label: "empty unknown argv and denied exe", row: { cmdline: "", exe: denied }, status: "uncertain" },
      { label: "equals selector remains uncertain", row: { ...candidate, cmdline: `node\0${cli}\0--session=${session}\0` }, status: "uncertain" },
      { label: "denied parent stat", row: { ...candidate, stat: denied }, status: "uncertain" },
      { label: "deleted executable remains a candidate", row: { ...candidate, exe: "/usr/bin/node (deleted)" }, status: "single", owners: 1 },
      { label: "absolute owner does not require cwd", row: { ...candidate, cwd: denied }, status: "single", owners: 1 },
      { label: "relative selector requires readable cwd", row: { ...candidate, cmdline: `node\0${cli}\0--session\0relative.jsonl\0`, cwd: denied }, status: "uncertain" },
      { label: "process exits before cmdline read", row: { ...candidate, cmdline: gone }, status: "clear", noExe: true },
      { label: "process exits before exe read", row: { ...candidate, exe: gone }, status: "clear" },
      { label: "process exits before stat read", row: { ...candidate, stat: gone }, status: "clear" },
    ];
    for (const { label, row, status, owners = 0, noExe } of cases) {
      fixture = row; exeReads = 0;
      const snapshot = enumerateProcesses();
      const audit = auditSession(session, snapshot, probe);
      assert.equal(audit.status, status, label);
      assert.equal(audit.ownerCount, owners, label);
      if (status === "uncertain") assert.throws(() => assertSessionWriters(audit, identity), /unverified/, label);
      if (noExe) assert.equal(exeReads, 0, `${label}: avoid privileged exe read`);
    }
    directoryError = denied;
    assert.equal(auditSession(session, enumerateProcesses(), probe).status, "uncertain", "denied proc listing is not clear");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
});

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
