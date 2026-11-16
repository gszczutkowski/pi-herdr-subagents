import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, mock } from "node:test";

// No terminal or real CLI dispatch; even broken preambles are inspected only.
const calls: Array<{ command: string; args: string[]; options: any }> = [];
let dispatchError: Error | undefined;
let hangDispatch = false;
const realExecFileSync = childProcess.execFileSync;
mock.method(childProcess, "execSync", () => "herdr");
mock.method(childProcess, "execFileSync", (command: string, args: string[], options: any) => {
  calls.push({ command, args, options });
  if (args[0] === "pane" && args[1] === "run") {
    if (dispatchError) throw dispatchError;
    if (hangDispatch) {
      assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 15000);
      assert.equal(options.killSignal, "SIGKILL", "a CLI ignoring SIGTERM must still be bounded");
      // Replace only the transport executable with an inert isolated process.
      return realExecFileSync(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], options);
    }
  }
  return "";
});
syncBuiltinESMExports();
const { runScriptInPane, runInPane } = await import("../pi-extension/subagents/terminal.ts");
const { sendHerdrCommand, readHerdrScreen, closeHerdrSurface } = await import("../pi-extension/subagents/herdr.ts");
const env = { ...process.env };
process.env.HERDR_ENV = "1";
delete process.env.HC_TERMINAL_ID;
delete process.env.HC_TERMINAL_SOCKET;
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  mock.restoreAll();
  syncBuiltinESMExports();
});

test("terminal treats every preamble line as comment data, including custom-driver fallback metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "terminal-preamble-"));
  try {
    let dispatched = 0;
    const path = runScriptInPane("test-pane", "printf 'CONTROLLED_COMMAND'", {
      scriptPath: join(dir, "launch.sh"),
      scriptPreamble: "# Worker\nprintf AUDIT_MARKER\rPATH_DATA\r\n# tail\\\nFINAL_DATA",
      onDispatch: () => { dispatched++; },
    });
    const script = readFileSync(path, "utf8");
    const metadata = script.slice(script.indexOf("\n") + 1, script.lastIndexOf("printf 'CONTROLLED_COMMAND'"));
    assert.ok(metadata.trimEnd().split("\n").every((line) => line.startsWith("#")), script);
    assert.equal(dispatched, 1);
    const send = calls.findLast(({ args }) => args[0] === "pane" && args[1] === "run");
    assert.ok(send);
    assert.ok(!send.args[3].includes("AUDIT_MARKER"), "transport receives only the script path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy synchronous sends, reads and cleanup set a finite CLI timeout", () => {
  calls.length = 0;
  sendHerdrCommand("test-pane", "CONTROLLED_COMMAND");
  readHerdrScreen("test-pane");
  closeHerdrSurface("test-pane");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(Number.isFinite(call.options.timeout) && call.options.timeout > 0 && call.options.timeout <= 15000,
      JSON.stringify(call));
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.killSignal, "SIGKILL");
  }
});

test("timed-out legacy dispatch is propagated after the uncertain-send boundary, without replay", () => {
  calls.length = 0;
  const timeout = Object.assign(new Error("herdr ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM" });
  dispatchError = timeout;
  let dispatched = false;
  try {
    assert.throws(() => runInPane("test-pane", "CONTROLLED_COMMAND", () => { dispatched = true; }),
      (error) => error === timeout);
    assert.equal(dispatched, true, "timeout cannot establish non-delivery");
    assert.equal(calls.filter(({ args }) => args[0] === "pane" && args[1] === "run").length, 1);
  } finally { dispatchError = undefined; }
});

test("an inert hanging CLI is killed at the sync timeout without retrying uncertain dispatch", { timeout: 20000 }, () => {
  calls.length = 0;
  let dispatched = false;
  hangDispatch = true;
  const start = Date.now();
  try {
    assert.throws(() => runInPane("test-pane", "CONTROLLED_COMMAND", () => { dispatched = true; }),
      (error: any) => error.code === "ETIMEDOUT" && error.signal === "SIGKILL");
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 14000 && elapsed < 19000, `timeout took ${elapsed}ms`);
    assert.equal(dispatched, true);
    assert.equal(calls.filter(({ args }) => args[0] === "pane" && args[1] === "run").length, 1);
  } finally { hangDispatch = false; }
});
