import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bashPath, buildHcRunArgs, extractHcAddress, HcClient, parseHcError, parseHcInspection } from "../pi-extension/subagents/hc.ts";
import { usesHcBackend } from "../pi-extension/subagents/herdr.ts";
import { posix, win32 } from "node:path";
import { resolveSubagentCwd } from "../pi-extension/subagents/paths.ts";

const live = JSON.stringify({ address: "t9", state: "live", status: { app: "pi", state: "working" } });
const missing = { stdout: JSON.stringify({ error: { kind: "not_found" } }) };

describe("herdr-core adapter", () => {
  it("does not append absolute Windows drive or UNC paths to the parent cwd", () => {
    assert.equal(resolveSubagentCwd("E:/Repositories/verba", "E:/Repositories/verba", win32), "E:/Repositories/verba");
    assert.equal(resolveSubagentCwd("E:\\Repositories\\verba", "C:\\parent", win32), "E:\\Repositories\\verba");
    assert.equal(resolveSubagentCwd("\\\\server\\share\\repo", "C:\\parent", win32), "\\\\server\\share\\repo");
    assert.equal(resolveSubagentCwd("child", "C:\\parent", win32), "C:\\parent\\child");
    assert.equal(resolveSubagentCwd("/repo", "/parent", posix), "/repo");
    assert.equal(resolveSubagentCwd("child", "/parent", posix), "/parent/child");
    assert.equal(resolveSubagentCwd(null, "/parent", posix), null);
  });

  it("recognizes hc identity without fabricating legacy HERDR_ENV", () => {
    const saved = Object.fromEntries(["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HERDR_ENV"].map((key) => [key, process.env[key]]));
    try {
      delete process.env.HERDR_ENV;
      process.env.HC_TERMINAL_ID = "t4";
      process.env.HC_TERMINAL_SOCKET = "test-socket";
      assert.equal(usesHcBackend(), true);
      process.env.HERDR_ENV = "1";
      delete process.env.HC_TERMINAL_SOCKET;
      assert.equal(usesHcBackend(), false);
      delete process.env.HC_TERMINAL_ID;
      assert.equal(usesHcBackend(), false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("creates an explicit Bash terminal without duplicate native parent notifications", () => {
    assert.deepEqual(buildHcRunArgs("Review: auth", "C:\\a b", "C:\\Git\\bash.exe", "t4"), [
      "run", "--bg", "--no-notify", "--cwd", "C:\\a b", "--label", "pi.name=Review: auth",
      "--parent", "t4", "--", "C:\\Git\\bash.exe", "--noprofile", "--norc", "-i",
    ]);
    assert.ok(!buildHcRunArgs("x", "/repo", "/bin/bash").includes("--parent"));
  });

  it("parses the raw hc run terminal record, rejecting other envelopes and remote addresses", () => {
    assert.equal(extractHcAddress(live), "t9");
    for (const output of ["garbage", "{}", '{"terminal":{"address":"t9"}}', '{"address":"remote/t9"}']) {
      assert.throws(() => extractHcAddress(output));
    }
  });

  it("maps known statuses and does not invent activity for an unreported shell", () => {
    assert.deepEqual(parseHcInspection(live, "t9"), { kind: "present", agent: "pi", agentStatus: "working" });
    for (const state of ["idle", "done", "blocked", "working"]) {
      assert.equal((parseHcInspection(JSON.stringify({ address: "t9", state: "live", status: { state } }), "t9") as any).agentStatus, state);
    }
    assert.deepEqual(parseHcInspection('{"address":"t9","state":"live","status":null}', "t9"), { kind: "present", agentStatus: "unknown" });
    assert.equal((parseHcInspection('{"address":"t9","state":"live","status":{"state":"error"}}', "t9") as any).agentStatus, "blocked");
    assert.equal(parseHcInspection(live, "t8").kind, "unavailable");
    assert.equal(parseHcInspection('{"address":"t9","state":"finished"}', "t9").kind, "missing");
    assert.equal(parseHcInspection("invalid", "t9").kind, "unavailable");
  });

  it("distinguishes structured missing terminals from transport/parse failures", () => {
    assert.equal(parseHcError(missing).kind, "missing");
    assert.equal(parseHcError({ stderr: '{"error":{"data":{"kind":"not_found"}}}' }).kind, "missing");
    for (const error of [null, new Error("not_found"), { stdout: "not_found" }, { stderr: '{"error":{"kind":"unavailable"}}' }]) {
      assert.equal(parseHcError(error).kind, "unavailable");
    }
  });

  it("uses explicit IDs for sending, escape, reading and cleanup", async () => {
    const calls: string[][] = [];
    const client = new HcClient("hc", (args) => { calls.push(args); return live; }, async (args) => { calls.push(args); return live; });
    assert.equal(client.available("t9"), true);
    assert.equal(client.available("t8"), false);
    client.send("t9", "echo 'a b'");
    client.escape("t9");
    assert.equal(client.read("t9", 20), live);
    assert.equal(await client.readAsync("t9", 30), live);
    assert.equal((await client.inspect("t9")).kind, "present");
    client.label("t9", "pi.name", "Review: auth");
    client.close("t9");
    assert.deepEqual(calls.slice(2), [
      ["send", "t9", "echo 'a b'"], ["keys", "t9", "esc"], ["read", "t9", "--lines", "20"],
      ["read", "t9", "--lines", "30"], ["get", "t9"], ["label", "t9", "pi.name=Review: auth"],
      ["kill", "t9"], ["rm", "t9"],
    ]);
  });

  it("tolerates only confirmed missing cleanup targets", async () => {
    const gone = new HcClient("hc", () => { throw missing; }, async () => { throw missing; });
    gone.close("t9");
    assert.equal(gone.available("t9"), false);
    assert.equal((await gone.inspect("t9")).kind, "missing");
    const unavailable = new HcClient("hc", () => { throw new Error("offline"); }, async () => { throw new Error("offline"); });
    assert.throws(() => unavailable.close("t9"), /offline/);
    assert.equal((await unavailable.inspect("t9")).kind, "unavailable");
  });

  it("converts a Windows tool PATH for Git Bash while preserving spaces", () => {
    assert.equal(bashPath("C:\\Program Files\\Git\\bin;E:\\tools;C:/node", "win32"), "/c/Program Files/Git/bin:/e/tools:/c/node");
    assert.equal(bashPath("/usr/bin:/bin", "linux"), "/usr/bin:/bin");
  });
});
