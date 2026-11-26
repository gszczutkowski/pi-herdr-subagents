import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";

test("native Windows handle without FILE_SHARE_DELETE preserves the manifest until released", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "windows-manifest-"));
  const store = new RuntimeStore(dir, { sessionFile: "synthetic-parent", headerId: "test", branchToken: "branch", checkpoint: "checkpoint" });
  const manifest = join(dir, "manifest.json");
  const handle = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop';
    $handle = [System.IO.File]::Open($env:PI_TEST_MANIFEST, 'Open', 'Read', 'ReadWrite');
    try { [Console]::WriteLine('held'); [void][Console]::ReadLine() } finally { $handle.Dispose() }
  `], { env: { ...process.env, PI_TEST_MANIFEST: manifest }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = once(handle, "exit");
  const lines = createInterface({ input: handle.stdout });
  let stderr = "";
  handle.stderr.on("data", (data) => { stderr += data; });
  const run = { id: "run", name: "Synthetic", task: "Synthetic", sessionFile: "synthetic-child", startTime: 1 };
  try {
    const [line] = await Promise.race([once(lines, "line"), exited.then(() => { throw new Error(`Handle process exited: ${stderr}`); })]);
    assert.equal(line, "held");
    const previous = readFileSync(manifest, "utf8");
    const revision = store.snapshot().revision;
    const start = performance.now();
    assert.throws(() => store.prepare(run), { code: /^(EPERM|EBUSY)$/ });
    assert.ok(performance.now() - start >= 90, "native replacement used its retry budget");
    assert.equal(store.snapshot().revision, revision);
    assert.equal(readFileSync(manifest, "utf8"), previous);
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith(".tmp")), []);
    handle.stdin.end("release\n");
    assert.equal((await exited)[0], 0, stderr);
    store.prepare(run);
    assert.equal(store.snapshot().revision, revision + 1);
    assert.equal(store.getRun(run.id)?.phase, "prepared");
  } finally {
    lines.close();
    if (handle.exitCode === null) {
      handle.stdin.end(); // EOF lets the scratch process release its own handle
      await exited.catch(() => {});
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
