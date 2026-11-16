import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { withChildSession } from "./child-session.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";
import { Type } from "@sinclair/typebox";

for (const batch of ["solo", "mixed", "all-terminating"] as const) {
  test(`caller_ping native loop: ${batch}`, async () => {
    let shutdownsBeforeSettlement: () => number;
    await withChildSession({
      respond: (index) => index === 0 ? { stopReason: "toolUse", content: [
        { type: "toolCall", id: "ping", name: "caller_ping", arguments: { message: "Please clarify exactly this" } },
        ...(batch === "solo" ? [] : [{ type: "toolCall" as const, id: "other", name: "other", arguments: {} }]),
      ] } : {},
      extensions: [(pi) => pi.registerTool({ name: "other", label: "Other", description: "test", parameters: Type.Object({}),
        execute: async () => {
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(readRetainedCompletion(process.env.PI_SUBAGENT_SESSION!, process.env.PI_SUBAGENT_ID!, []), null,
            "ping is not visible to the parent while a sibling still runs");
          assert.equal(shutdownsBeforeSettlement(), 0);
          return { content: [{ type: "text", text: "sibling" }], details: {}, terminate: batch === "all-terminating" };
        } })],
    }, async ({ session, requests, shutdowns }) => {
      shutdownsBeforeSettlement = shutdowns;
      await session.prompt("perform task or ask for help");
      // Native Pi semantics: only an entirely terminating batch suppresses the next request.
      assert.equal(requests.length, batch === "mixed" ? 2 : 1);
      assert.ok(shutdowns() >= 1);
      const eventsDir = `${process.env.PI_SUBAGENT_SESSION}.${process.env.PI_SUBAGENT_ID}.exit.events`;
      const files = readdirSync(eventsDir).filter((name) => name.endsWith(".json"));
      assert.equal(files.length, 1, "one immutable notification, no done overwrite");
      const event = JSON.parse(readFileSync(`${eventsDir}/${files[0]}`, "utf8"));
      assert.equal(event.type, "ping");
      assert.equal(event.message, "Please clarify exactly this");
    });
  });
}
