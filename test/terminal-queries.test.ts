import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { after, beforeEach, describe, it, mock } from "node:test";

// Mock OS boundaries before loading the production adapters. No live CLI is used.
let syncCalls = 0;
let active = 0;
let peak = 0;
let discoveryFails = false;
let respond: (command: string, args: string[]) => string | Promise<string>;
const calls: Array<{ command: string; args: string[]; options: any }> = [];
const execute = async (command: string, args: string[], options: any) => {
  calls.push({ command, args, options });
  active++;
  peak = Math.max(peak, active);
  try {
    if (command === "where.exe" || command === "sh") {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (discoveryFails) throw new Error("CLI missing");
      return { stdout: args.includes("herdr") ? "herdr\n" : "hc\n" };
    }
    return { stdout: await respond(command, args) };
  } finally { active--; }
};
const asyncStub = Object.assign(() => { throw new Error("expected promisified execFile"); }, { [promisify.custom]: execute });
// Node's mock.method proxy retains execFile's non-configurable native
// promisify.custom implementation (which would launch a real process).
const originalExecFile = childProcess.execFile;
childProcess.execFile = asyncStub as any;
for (const method of ["execFileSync", "execSync"] as const) {
  mock.method(childProcess, method, () => { syncCalls++; throw new Error("synchronous process forbidden"); });
}
mock.method(fsPromises, "access", async () => { throw new Error("not installed"); });
syncBuiltinESMExports();

const { readPaneAsync, inspectPane, createSubagentPane } = await import("../pi-extension/subagents/terminal.ts");
const { HcClient } = await import("../pi-extension/subagents/hc.ts");
const { getEnvironmentConfig } = await import("../pi-extension/subagents/config.ts");
const { MAX_TERMINAL_QUERIES, TERMINAL_QUERY_TIMEOUT_MS } = await import("../pi-extension/subagents/terminal-queries.ts");
const savedEnv = Object.fromEntries(["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HERDR_ENV"].map((key) => [key, process.env[key]]));
const environment = getEnvironmentConfig();
const savedOutside = environment.allowOutsideHerdr;
function backend(kind: "hc" | "herdr" | "outside") {
  delete process.env.HC_TERMINAL_ID;
  delete process.env.HC_TERMINAL_SOCKET;
  delete process.env.HERDR_ENV;
  if (kind === "hc") {
    process.env.HC_TERMINAL_ID = "tparent";
    process.env.HC_TERMINAL_SOCKET = "test-socket";
  } else if (kind === "herdr") process.env.HERDR_ENV = "1";
}
function present(command: string, args: string[]): string {
  return command === "herdr"
    ? JSON.stringify({ result: { pane: { pane_id: args[2], agent_status: "working" } } })
    : JSON.stringify({ address: args[1], state: "live", status: { state: "working" } });
}

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  environment.allowOutsideHerdr = savedOutside;
  mock.restoreAll();
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
});

beforeEach(() => {
  syncCalls = 0;
  peak = 0;
  calls.length = 0;
  discoveryFails = false;
  respond = present;
  environment.allowOutsideHerdr = false;
  backend("herdr");
});

describe("asynchronous terminal monitor queries (mocked OS boundaries)", () => {
  it("returns unavailable on failed hc discovery and retries without synchronous lookup", async () => {
    backend("hc");
    discoveryFails = true;
    assert.equal((await inspectPane("t1")).kind, "unavailable");
    await assert.rejects(readPaneAsync("t1"), /hc.*not available/);
    discoveryFails = false;
    calls.length = 0;
    const results = await Promise.all(Array.from({ length: 12 }, () => inspectPane("t1")));
    assert.ok(results.every((result) => result.kind === "present"));
    assert.equal(calls.filter(({ command }) => command === "where.exe" || command === "sh").length, 1);
    assert.ok(peak <= MAX_TERMINAL_QUERIES);
    assert.equal(syncCalls, 0);
  });

  for (const kind of ["herdr", "hc"] as const) {
    it(`${kind}: queries only the target, never a synchronous parent health probe`, async () => {
      backend(kind);
      const result = await inspectPane("t1");
      assert.equal(result.kind, "present");
      if (result.kind === "present") assert.ok(result.observedAt <= Date.now());
      respond = () => "screen";
      assert.equal(await readPaneAsync("t1", 7), "screen");
      assert.equal(syncCalls, 0);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(({ args }) => args), kind === "hc"
        ? [["get", "t1"], ["read", "t1", "--lines", "7"]]
        : [["pane", "get", "t1"], ["pane", "read", "t1", "--source", "visible", "--lines", "7"]]);
      for (const { options } of calls) assert.equal(options.timeout, TERMINAL_QUERY_TIMEOUT_MS);
    });

    it(`${kind}: never reuses optimistic liveness after transport, parse or timeout failures`, async () => {
      backend(kind);
      assert.equal((await inspectPane("t1")).kind, "present");
      for (const failure of [new Error("offline"), Object.assign(new Error("timeout"), { killed: true }), new Error("ENOENT")]) {
        respond = () => { throw failure; };
        const result = await inspectPane("t1");
        assert.equal(result.kind, "unavailable");
        assert.ok(!("observedAt" in result));
        await assert.rejects(readPaneAsync("t1"), (error) => error === failure);
      }
      respond = () => "malformed";
      assert.equal((await inspectPane("t1")).kind, "unavailable");
      respond = present;
      assert.equal((await inspectPane("t1")).kind, "present");
      assert.equal(syncCalls, 0);
    });

    it(`${kind}: preserves confirmed missing responses`, async () => {
      backend(kind);
      respond = () => { throw { stdout: kind === "hc"
        ? '{"error":{"kind":"not_found"}}'
        : '{"error":{"code":"pane_not_found"}}' }; };
      assert.equal((await inspectPane("t1")).kind, "missing");
      assert.equal(syncCalls, 0);
    });
  }

  it("uses asynchronous legacy discovery when outside operation is explicitly allowed", async () => {
    backend("outside");
    environment.allowOutsideHerdr = true;
    assert.equal((await inspectPane("t1")).kind, "present");
    assert.equal(syncCalls, 0);
    assert.ok(calls.some(({ command }) => command === "where.exe" || command === "sh"));
  });

  it("denies outside queries safely without starting a process", async () => {
    backend("outside");
    assert.equal((await inspectPane("t1")).kind, "unavailable");
    await assert.rejects(readPaneAsync("t1"), /outside/);
    assert.equal(calls.length, 0);
    assert.equal(syncCalls, 0);
  });

  it("shares a bounded FIFO budget across transports, reads and clients, releasing failures", async () => {
    const releases: Array<() => void> = [];
    respond = async (command, args) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      if (args.includes("fail")) throw new Error("offline");
      return present(command, args);
    };
    const direct = new HcClient("hc", () => { throw new Error("sync forbidden"); }, async (args) =>
      (await execute("hc", args, {})).stdout);
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 24; i++) {
      backend(i % 2 ? "hc" : "herdr");
      pending.push(i % 3 === 0 ? direct.inspect(i === 0 ? "fail" : `t${i}`)
        : i % 3 === 1 ? inspectPane(`t${i}`) : readPaneAsync(`t${i}`));
    }
    // Async routing may yield before entering the shared budget.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active, MAX_TERMINAL_QUERIES);
    assert.equal(calls.length, MAX_TERMINAL_QUERIES);
    let ticked = false;
    setImmediate(() => { ticked = true; });
    while (calls.length < 24 || active > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(pending);
    assert.equal((results[0] as any).kind, "unavailable");
    assert.equal(peak, MAX_TERMINAL_QUERIES);
    assert.equal(syncCalls, 0);
    assert.equal(ticked, true);
    respond = present;
    assert.equal((await inspectPane("tfinal")).kind, "present");
  });

  it("retains synchronous launch preflight checks outside the monitor path", () => {
    backend("hc");
    assert.throws(() => createSubagentPane("launch"), /not available/);
    assert.ok(syncCalls > 0);
  });
});
