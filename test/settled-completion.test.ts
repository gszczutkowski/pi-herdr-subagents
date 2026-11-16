import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { withChildSession } from "./child-session.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";

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
