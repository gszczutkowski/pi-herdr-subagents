import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { withChildSession } from "./child-session.ts";

const result = { status: "partial", summary: "Exact structured proposal", artifacts: ["patch.diff"], checks: [], unmetCriterionIds: [], risks: [] };

for (const code of ["ENOSPC", "EACCES", "EIO"]) {
  test(`native keep-open ${code}: bounded observable retry retains the exact settled result without a model turn`, async t => {
    await withChildSession({ autoExit: false, respond: () => ({ stopReason: "toolUse", content: [
      { type: "text", text: "EXACT_SETTLED_RESULT" },
      { type: "toolCall", id: "done", name: "subagent_done", arguments: { close: false, result } },
    ] }) },
      async ({ session, requests, shutdowns }) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const realLink = fs.linkSync;
        const realWrite = fs.writeFileSync;
        let unavailable = true;
        const attempted: string[] = [];
        const serialized: string[] = [];
        const notifications: string[] = [];
        const statuses: string[] = [];
        session.extensionRunner!.setUIContext({ notify: (message: string) => notifications.push(message),
          setStatus: (_key: string, message: string) => statuses.push(message) } as any);
        const write = t.mock.method(fs, "writeFileSync", (file: any, data: any, ...args: any[]) => {
          if (String(file).includes(".exit.events/") || String(file).includes(".exit.events\\")) serialized.push(String(data));
          return (realWrite as any)(file, data, ...args);
        });
        const link = t.mock.method(fs, "linkSync", (source: any, target: any) => {
          if (String(target).includes(".exit.events")) {
            attempted.push(String(target));
            if (unavailable) throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return realLink(source, target);
        });
        syncBuiltinESMExports();
        try {
          await session.prompt("Complete once");
          const dir = `${process.env.PI_SUBAGENT_SESSION}.${process.env.PI_SUBAGENT_ID}.exit.events`;
          assert.equal(existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".json")).length : 0, 0);
          assert.match(notifications.join("\n"), /pending/i);
          assert.match(statuses.join("\n"), /pending/i);
          assert.equal(shutdowns(), 0);
          t.mock.timers.tick(100); t.mock.timers.tick(500); t.mock.timers.tick(1000);
          assert.equal(attempted.length, 4, "initial publication plus three automatic retries");
          t.mock.timers.tick(100_000);
          assert.equal(attempted.length, 4, "retry exhaustion does not spin");
          assert.match(notifications.join("\n"), /subagent_retry_completion/);
          // Storage recovers. An explicit command retries without invoking the provider.
          unavailable = false;
          session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "LATER_BRANCH_TEXT_MUST_NOT_REPLACE_RESULT" }],
            stopReason: "stop", timestamp: Date.now() } as any);
          await session.prompt("/subagent_retry_completion");
          assert.equal(requests.length, 1);
          assert.equal(new Set(attempted).size, 1, "same immutable event identity across retries");
          assert.equal(new Set(serialized).size, 1, "summary and result bytes are frozen at settlement");
          const files = readdirSync(dir).filter(n => n.endsWith(".json"));
          assert.equal(files.length, 1);
          const completion = JSON.parse(readFileSync(`${dir}/${files[0]}`, "utf8"));
          assert.equal(completion.summary, "EXACT_SETTLED_RESULT");
          assert.deepEqual(completion.structuredResult, result);
          await session.prompt("/subagent_retry_completion");
          assert.equal(attempted.length, 5, "success removes the pending result");
          assert.equal(shutdowns(), 0);
        } finally {
          link.mock.restore(); write.mock.restore(); syncBuiltinESMExports(); t.mock.timers.reset();
        }
      });
  });
}

for (const reload of [false, true]) {
  test(`native automatic publication retry recovers exactly once (reload=${reload})`, async t => {
    await withChildSession({ autoExit: false }, async ({ session, requests, shutdowns }) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const realLink = fs.linkSync;
      let unavailable = true;
      let attempts = 0;
      const link = t.mock.method(fs, "linkSync", (source: any, target: any) => {
        if (String(target).includes(".exit.events")) {
          attempts++;
          if (unavailable) throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
        }
        return realLink(source, target);
      });
      syncBuiltinESMExports();
      try {
        await session.prompt("Complete before storage recovers");
        assert.equal(attempts, 1);
        unavailable = false;
        if (reload) await session.reload();
        else t.mock.timers.tick(100);
        const dir = `${process.env.PI_SUBAGENT_SESSION}.${process.env.PI_SUBAGENT_ID}.exit.events`;
        assert.equal(readdirSync(dir).filter(n => n.endsWith(".json")).length, 1);
        t.mock.timers.tick(100_000);
        assert.equal(attempts, 2);
        assert.equal(requests.length, 1, "no model turn needed for publication recovery");
        assert.equal(shutdowns(), 0);
      } finally { link.mock.restore(); syncBuiltinESMExports(); t.mock.timers.reset(); }
    });
  });
}
