import { mock, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { withChildSession } from "./child-session.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";
import { DELEGATION_WAIT_QUERY } from "../pi-extension/subagents/delegation-wait.ts";
import { loadAgentDefaults, parseAgentDefinition } from "../pi-extension/subagents/discovery.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { buildSubagentToolAllowlist } from "../pi-extension/subagents/harness/drivers/pi.ts";

const call = (name: string, args: object = {}) => ({ type: "toolCall" as const, id: name, name, arguments: args });
function events(): any[] {
  const dir = `${process.env.PI_SUBAGENT_SESSION}.${process.env.PI_SUBAGENT_ID}.exit.events`;
  return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(`${dir}/${n}`, "utf8"))) : [];
}

for (const explicit of [false, true]) {
  test(`native earlier tool failure followed by successful recovery does not poison ${explicit ? "explicit" : "automatic"} completion`, async () => {
    await withChildSession({ autoExit: !explicit, respond: index => index < 2
      ? { stopReason: "toolUse", content: [call(index === 0 ? "first_attempt" : "recover")] }
      : explicit ? { stopReason: "toolUse", content: [{ type: "text", text: "RECOVERED_FINAL" }, call("subagent_done", { close: false })] }
        : { content: [{ type: "text", text: "RECOVERED_FINAL" }] }, extensions: [pi => {
      pi.registerTool({ name: "first_attempt", label: "First", description: "test", parameters: Type.Object({}), execute: async () => { throw new Error("Recoverable first attempt"); } });
      pi.registerTool({ name: "recover", label: "Recover", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "recovered" }], details: {} }) });
    }] }, async ({ session, requests }) => {
      await session.prompt("Recover before finishing");
      assert.equal(requests.length, 3);
      assert.equal(events().length, 1);
      assert.equal(events()[0].type, "done");
      assert.equal(events()[0].errorMessage, undefined);
      assert.equal(events()[0].summary, "RECOVERED_FINAL");
    });
  });
}

for (const close of [true, false]) {
  test(`native done + slow sibling waits for settlement (close=${close})`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withChildSession({ respond: index => index === 0 ? { stopReason: "toolUse", content: [call("subagent_done", { close }), call("slow")] }
      : { content: [{ type: "text", text: "FINAL_AFTER_SIBLING" }] }, extensions: [pi => {
        pi.registerTool({ name: "slow", label: "Slow", description: "test", parameters: Type.Object({}), execute: async () => {
          entered(); await gate;
          return { content: [{ type: "text", text: "sibling finished" }], details: {} };
        } });
      }] }, async ({ session, requests, shutdowns }) => {
      const running = session.prompt("Complete the task");
      try {
        await started;
        assert.equal(readRetainedCompletion(process.env.PI_SUBAGENT_SESSION!, process.env.PI_SUBAGENT_ID!, []), null,
          "parent must not observe completion and close a working sibling");
        assert.equal(shutdowns(), 0);
      } finally { release(); await running; }
      assert.equal(requests.length, 2, "a non-terminating sibling still requires Pi's natural next request");
      assert.equal(events().length, 1);
      assert.equal(events()[0].summary, "FINAL_AFTER_SIBLING");
      assert.equal(events()[0].keepOpen === true, !close);
      assert.equal(shutdowns(), close ? 1 : 0);
    });
  });
}

for (const order of ["ping-first", "done-first"]) {
  test(`native mixed ping/done: ping wins independent of source order (${order})`, async () => {
    const ping = call("caller_ping", { message: "Need decision" });
    const done = call("subagent_done", { close: false });
    await withChildSession({ respond: () => ({ stopReason: "toolUse", content: order === "ping-first" ? [ping, done] : [done, ping] }) },
      async ({ session, requests, shutdowns }) => {
        await session.prompt("Mixed intent");
        assert.equal(requests.length, 1);
        assert.equal(events().length, 1);
        assert.equal(events()[0].type, "ping");
        assert.equal(events()[0].message, "Need decision");
        assert.equal(shutdowns(), 1);
      });
  });
}

for (const failure of ["error", "abort"] as const) {
  for (const close of [false, true]) {
  test(`native done + ${failure} sibling cannot publish successful done (close=${close})`, async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    await withChildSession({ respond: index => index === 0 ? { stopReason: "toolUse", content: [call("subagent_done", { close }), call("failing")] }
      : { content: [{ type: "text", text: "Model acknowledged failure" }] }, extensions: [pi => {
      pi.registerTool({ name: "failing", label: "Failing", description: "test", parameters: Type.Object({}), execute: async (_id: string, _args: any, signal: AbortSignal) => {
        entered();
        if (failure === "abort") await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error(failure === "error" ? "SIBLING_EIO" : "SIBLING_ABORTED");
      } });
    }] }, async ({ session, shutdowns }) => {
      const running = session.prompt("Attempt task");
      await started;
      if (failure === "abort") await session.abort();
      await running;
      assert.equal(events().length, 1);
      assert.equal(events()[0].type, "error");
      assert.match(events()[0].errorMessage, failure === "error" ? /SIBLING_EIO/ : /abort/i);
      assert.equal(events()[0].keepOpen === true, failure === "abort" || !close);
      assert.equal(shutdowns(), failure === "abort" || !close ? 0 : 1);
    });
  });
  }
}

test("native auto completion waits through agent_before_settle continuation and uses the final text", async () => {
  let continued = false;
  await withChildSession({ autoExit: false, respond: index => ({ content: [{ type: "text", text: index ? "ACTUAL_FINAL" : "NOT_SETTLED" }] }),
    extensions: [pi => pi.on("agent_before_settle", () => {
      if (continued) return;
      assert.equal(events().length, 0);
      continued = true;
      return { entries: [{ type: "custom_message", customType: "review", content: "Finish reviewing", display: false }], continue: true };
    })] }, async ({ session, requests, shutdowns }) => {
      await session.prompt("Work");
      assert.equal(requests.length, 2);
      assert.equal(events().length, 1);
      assert.equal(events()[0].summary, "ACTUAL_FINAL");
      assert.equal(shutdowns(), 0);
    });
});

for (const outcome of ["stop", "length", "error", "ping", "blocked"] as const) {
  test(`explicit completion without delegated work reports ${outcome} at native Pi settlement`, async () => {
    const blocked = { status: "blocked", summary: "Need test fixtures", artifacts: [], checks: [], unmetCriterionIds: ["F1"], risks: [] };
    await withChildSession({ autoExit: false, completionMode: "explicit", respond: () => {
      if (outcome === "ping") return { stopReason: "toolUse", content: [call("caller_ping", { message: "Need a decision" })] };
      if (outcome === "blocked") return { stopReason: "toolUse", content: [call("subagent_done", { result: blocked, close: true })] };
      if (outcome === "length") return { stopReason: "length" };
      return outcome === "error" ? { stopReason: "error", errorMessage: "OFFLINE_PROVIDER_ERROR" } : {};
    } }, async ({ session, shutdowns }) => {
      await session.prompt("Coordinate one feature");
      assert.equal(events().length, 1);
      const [result] = events();
      if (outcome === "stop" || outcome === "length" || outcome === "error") {
        assert.equal(result.type, "error");
        assert.equal(result.keepOpen, true);
        assert.match(result.errorMessage, outcome === "length" ? /Incomplete.*token limit/ : outcome === "stop" ? /Incomplete.*no confirmed delegation/ : /OFFLINE_PROVIDER_ERROR/);
        assert.equal(shutdowns(), 0);
      } else {
        assert.equal(shutdowns(), 1);
        if (outcome === "ping") {
          assert.equal(result.type, "ping");
          assert.equal(result.message, "Need a decision");
        } else {
          assert.equal(result.type, "done");
          assert.deepEqual(result.structuredResult, blocked);
        }
      }
    });
  });
}

test("reload notices a wake source lost while extensions were unbound, exactly once", async () => {
  let active = true;
  await withChildSession({ completionMode: "explicit", liveContinuation: true,
    setup: manager => manager.appendMessage({ role: "user", content: "Seed saved session for CLOSE identity", timestamp: Date.now() }),
    extensions: [pi => pi.events.on(DELEGATION_WAIT_QUERY, (query: { confirm: () => void }) => { if (active) query.confirm(); })],
  }, async ({ session, requests, shutdowns }) => {
    await session.prompt("Wait for a worker");
    const close = `${process.env.PI_SUBAGENT_ACTIVITY_FILE}.close`;
    assert.ok(existsSync(close), "real CLOSE watcher initialized");
    assert.ok(!existsSync(`${close}/current.json`), "silent coordinator is not closable");
    assert.equal(events().length, 0);
    active = false; // No pause notification can be replayed by this wake source.
    await session.reload();
    await session.reload();
    assert.equal(requests.length, 1);
    assert.equal(events().length, 1);
    assert.equal(events()[0].keepOpen, true);
    assert.match(events()[0].errorMessage, /no confirmed delegation wakeup after reload/i);
    assert.equal(shutdowns(), 0);
  });
});

for (const scenario of ["normal", "park", "reload-park", "ping", "early-done"] as const) test(`native coordinator delegation: ${scenario}`, { timeout: 20_000 }, async () => {
  const park = scenario === "park" || scenario === "reload-park";
  const twoWorkers = scenario === "ping" || scenario === "early-done";
  // The Pi host, tools, watcher and outbox are real; the terminal and worker
  // process are simulated at their transport and immutable result boundaries.
  const originalExec = childProcess.execFile;
  const env = Object.fromEntries(["HERDR_ENV", "HERDR_WORKSPACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET",
    "PI_SUBAGENT_LAYOUT", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS"].map(key => [key, process.env[key]]));
  mock.method(childProcess, "execSync", () => "herdr");
  mock.method(childProcess, "execFileSync", (command: string, args: string[]) => {
    if (command === "powershell.exe") return "[]";
    return args[0] === "tab" && args[1] === "create" ? JSON.stringify({ result: { root_pane: { pane_id: "worker-pane" } } }) : "";
  });
  childProcess.execFile = Object.assign(() => { throw new Error("unexpected transport"); }, {
    [promisify.custom]: async () => ({ stdout: JSON.stringify({ result: { pane: { pane_id: "worker-pane", agent_status: "working" } } }) }),
  }) as any;
  syncBuiltinESMExports();
  try {
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HC_TERMINAL_SOCKET;
    delete process.env.PI_SUBAGENT_LAYOUT;
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "test", PI_SUBAGENT_AGENT: "feature-coordinator", PI_SUBAGENT_SHELL_READY_DELAY_MS: "0" });
    const { default: orchestration } = await import("../pi-extension/subagents/index.ts");
    const definition = parseAgentDefinition(readFileSync(new URL("../agents/feature-coordinator.md", import.meta.url), "utf8"), "coordinator")!;
    assert.equal(definition.sessionMode, "lineage-only");
    assert.equal(definition.completionMode, "explicit");
    const proposal = { status: "complete", summary: "Export interface ready", artifacts: [], checks: [], unmetCriterionIds: [], risks: [] };
    let settled!: () => void;
    const finalTurn = new Promise<void>(resolve => { settled = resolve; });
    let intermediateSettled!: () => void;
    const intermediateTurn = new Promise<void>(resolve => { intermediateSettled = resolve; });
    let count = 0;
    const launchTool = (id: string) => ({ ...call("subagent", { agent: "worker", name: id, task: `Implement ${id}` }), id });
    await withChildSession({ autoExit: false, completionMode: definition.completionMode,
      tools: buildSubagentToolAllowlist(definition.tools)!.split(","),
      extensions: [orchestration, pi => pi.on("agent_settled", () => {
        if (++count === 2 && twoWorkers) intermediateSettled();
        if (count === (twoWorkers ? 3 : 2)) settled();
      })],
      respond: index => {
        if (index === 0) return { stopReason: "toolUse", content: twoWorkers ? [launchTool("First"), launchTool("Second")] : [launchTool("First")] };
        if (index === 1) return { content: [{ type: "text", text: "WAITING_INTERIM_ONLY" }] };
        if (index === 2 && scenario === "ping") return { stopReason: "toolUse", content: [call("caller_ping", { message: "Need decision" })] };
        return { stopReason: "toolUse", content: [call("subagent_done", { result: proposal, close: true })] };
      },
    }, async ({ session, requests, shutdowns }) => {
      assert.equal(loadAgentDefaults("feature-coordinator")?.source, "package");
      assert.equal(loadAgentDefaults("worker")?.completionMode, undefined);
      for (const name of ["subagent", "subagents_list", "subagent_done", "subagent_close"]) assert.ok(session.getActiveToolNames().includes(name), name);
      for (const name of ["bash", "write", "edit"]) assert.ok(!session.getActiveToolNames().includes(name), name);
      await session.prompt("Coordinate export");
      assert.equal(shutdowns(), 0);
      assert.equal(events().length, 0, "initial wait does not report to the ancestor");
      const launches = requests[1].messages.filter((message: any) => message.role === "toolResult" && message.toolName === "subagent").map((m: any) => m.details);
      assert.equal(launches.length, twoWorkers ? 2 : 1);
      const [launch, second] = launches;
      assert.equal(launch?.status, "started");
      assert.match(readFileSync(launch.launchScriptFile, "utf8"), /PI_SUBAGENT_COMPLETION_MODE=automatic/);
      const artifact = `${launch.sessionFile}.${launch.id}.exit.events/worker-result.json`;
      mkdirSync(dirname(artifact), { recursive: true });
      if (scenario === "reload-park") {
        await session.reload();
        assert.equal(events().length, 0, "a verified wait survives reload without a spurious report");
      }
      let settledOutcome = finalTurn;
      if (park) {
        let parked!: () => void;
        settledOutcome = new Promise<void>(resolve => { parked = resolve; });
        const delivery = RuntimeStore.prototype.delivery;
        mock.method(RuntimeStore.prototype, "delivery", function (this: RuntimeStore, eventId: string, kind: Parameters<RuntimeStore["delivery"]>[1]) {
          if (kind === "dispatching" && eventId.includes(launch.id)) {
            parked(); // Await resumes after the synchronous failure handler.
            throw new Error("TEST_PARKED_OUTBOX");
          }
          return delivery.call(this, eventId, kind);
        });
      }
      writeFileSync(artifact, JSON.stringify({ type: "done", runId: launch.id, eventId: "worker-result", summary: "PRIVATE_WORKER_REPORT" }));
      if (park) {
        // The send fails during the observed first result; callback unwinds by
        // the next microtask, once diagnostic and retry bookkeeping settle.
        await settledOutcome;
        assert.equal(requests.length, 2);
        assert.equal(events().length, 1);
        assert.match(events()[0].errorMessage, /TEST_PARKED_OUTBOX/);
        assert.equal(events()[0].keepOpen, true);
        assert.equal(shutdowns(), 0);
        return;
      }
      if (twoWorkers) {
        await intermediateTurn;
        assert.equal(shutdowns(), 0, "a local completion intent must not close a worker's recipient");
        const ping = scenario === "ping";
        assert.equal(events().length, ping ? 1 : 0, "only explicit help, not premature success, is reported");
        if (ping) {
          const retained = readRetainedCompletion(process.env.PI_SUBAGENT_SESSION!, process.env.PI_SUBAGENT_ID!, []);
          assert.equal(retained?.reason, "ping");
          assert.equal(retained?.ping?.message, "Need decision");
          assert.equal(retained?.keepOpen, true, "the ancestor watcher must not close the pane");
        }
        const path = `${second.sessionFile}.${second.id}.exit.events/second.json`;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ type: "done", runId: second.id, eventId: "second", summary: "SECOND_REPORT" }));
      }
      await settledOutcome;
      assert.equal(requests.length, twoWorkers ? 4 : 3, "each worker result woke the coordinator exactly once");
      if (twoWorkers) assert.match(JSON.stringify(requests.at(-1).messages), /SECOND_REPORT/);
      assert.match(JSON.stringify(requests[2].messages), /PRIVATE_WORKER_REPORT/);
      assert.equal(events().length, scenario === "ping" ? 2 : 1);
      const final = events().find(e => e.type === "done");
      assert.deepEqual(final?.structuredResult, proposal);
      assert.doesNotMatch(JSON.stringify(final), /PRIVATE_WORKER_REPORT|WAITING_INTERIM_ONLY/);
      assert.equal(shutdowns(), 1);
    });
  } finally {
    childProcess.execFile = originalExec;
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
