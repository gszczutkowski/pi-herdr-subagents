import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { Type } from "@sinclair/typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withChildSession } from "./child-session.ts";
import { withCompletionRuntime } from "./completion-runtime-fixture.ts";
import { beginCompletionTurn, writeRunCompletion } from "../pi-extension/subagents/run-artifacts.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";

for (const operation of ["new", "resume", "fork"] as const) {
  for (const mode of ["auto", "done", "ping", "bootstrap"] as const) {
    test(`native /${operation} detaches old supervision (${mode}), without blocking interaction`, async () => {
      await withCompletionRuntime(index => mode === "auto" || mode === "bootstrap" || index > 0 ? { content: [{ type: "text", text: "UNRELATED" }] }
        : { stopReason: "toolUse", content: [{ type: "toolCall", id: mode, name: mode === "done" ? "subagent_done" : "caller_ping",
          arguments: mode === "done" ? { close: true } : { message: "UNRELATED" } }] }, async ({ runtime, dir, shutdowns }) => {
        const session = runtime.session;
        const original = process.env.PI_SUBAGENT_SESSION!;
        const manager = session.sessionManager;
        manager.appendMessage({ role: "user", content: "Original task", timestamp: 1 });
        // Fork requires a persisted assistant before the selected user message.
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "OLD" }], stopReason: "stop", timestamp: 2 } as any);
        const other = SessionManager.create(dir, dir);
        other.appendMessage({ role: "user", content: "Another session", timestamp: 3 });
        other.appendMessage({ role: "assistant", content: [{ type: "text", text: "OTHER_OLD" }], stopReason: "stop", timestamp: 4 } as any);
        if (mode === "bootstrap") process.env.PI_SUBAGENT_INITIAL_SKILLS = "missing-in-replacement";
        if (operation === "new") assert.equal((await runtime.newSession()).cancelled, false);
        else if (operation === "resume") assert.equal((await runtime.switchSession(other.getSessionFile()!)).cancelled, false);
        else assert.equal((await runtime.fork(manager.getBranch().find((entry: any) => entry.message?.role === "user")!.id)).cancelled, false);
        assert.notEqual(runtime.session.sessionManager.getSessionFile(), original);
        await runtime.session.prompt("Unrelated interactive task");
        assert.equal(readRetainedCompletion(original, process.env.PI_SUBAGENT_ID!, []), null,
          "parent sees no old-run completion, so cannot close the replacement pane");
        assert.equal(shutdowns(), 0);
        assert.equal(existsSync(`${runtime.session.sessionManager.getSessionFile()}.${process.env.PI_SUBAGENT_ID}.exit.events`), false);
      });
    });
  }
}

test("native /reload retains supervision and /tree only summarizes newly emitted active-branch text", async () => {
  await withChildSession({ autoExit: false, respond: index => ({ content: [{ type: "text", text: index ? "NEW_BRANCH" : "OLD_BRANCH" }] }) },
    async ({ session, shutdowns }) => {
      await session.prompt("First task");
      const original = session.sessionManager.getSessionFile();
      const user = session.sessionManager.getBranch().find((entry: any) => entry.message?.role === "user")!;
      await session.reload();
      await session.navigateTree(user.id, { summarize: false });
      await session.prompt("New task on earlier branch");
      assert.equal(session.sessionManager.getSessionFile(), original);
      const dir = `${original}.${process.env.PI_SUBAGENT_ID}.exit.events`;
      const events = readdirSync(dir).sort().map(n => JSON.parse(readFileSync(join(dir, n), "utf8")));
      assert.deepEqual(events.map(e => e.summary), ["OLD_BRANCH", "NEW_BRANCH"]);
      assert.equal(shutdowns(), 0);
    });
});

test("same canonical file with replaced session header cannot publish the original run", async () => {
  await withChildSession({ autoExit: false }, async ({ session }) => {
    await session.prompt("Bind original session");
    const file = process.env.PI_SUBAGENT_SESSION!;
    const before = readdirSync(`${file}.${process.env.PI_SUBAGENT_ID}.exit.events`);
    beginCompletionTurn(session.sessionManager);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), id: "replacement-header" });
    writeFileSync(file, lines.join("\n"));
    assert.throws(() => writeRunCompletion({ type: "done" }, session.sessionManager), /session.*identity|identity.*session/i);
    const replacement = SessionManager.open(file);
    beginCompletionTurn(replacement);
    assert.throws(() => writeRunCompletion({ type: "done" }, replacement), /session.*identity|identity.*session/i);
    assert.deepEqual(readdirSync(`${file}.${process.env.PI_SUBAGENT_ID}.exit.events`), before);
  });
});

test("native completion accepts canonical aliases of the same supervised session", async () => {
  await withChildSession({ autoExit: false }, async ({ session }) => {
    const original = process.env.PI_SUBAGENT_SESSION!;
    process.env.PI_SUBAGENT_SESSION = `${dirname(original)}/./${basename(original)}`;
    await session.prompt("Same canonical path");
    const completion = readRetainedCompletion(original, process.env.PI_SUBAGENT_ID!, []);
    assert.equal(completion?.summary, "completed");
    assert.equal(completion?.keepOpen, true);
  });
});

test("native resume of the exact original file/header reattaches supervision, without replaying its old result", async () => {
  await withCompletionRuntime(index => ({ content: [{ type: "text", text: `TASK_${index}` }] }), async ({ runtime, shutdowns }) => {
    const original = process.env.PI_SUBAGENT_SESSION!;
    const runId = process.env.PI_SUBAGENT_ID!;
    await runtime.session.prompt("Original task");
    const first = readRetainedCompletion(original, runId, [])!;
    const cursor = [`subagent:${runId}:completion:${first.eventId}`];
    await runtime.newSession();
    await runtime.session.prompt("Unrelated task");
    assert.equal(readRetainedCompletion(original, runId, cursor), null);
    await runtime.switchSession(original);
    await runtime.session.prompt("Supervised follow-up");
    const followup = readRetainedCompletion(original, runId, cursor)!;
    assert.equal(followup.summary, "TASK_2");
    assert.notEqual(followup.eventId, first.eventId);
    assert.equal(followup.keepOpen, true);
    assert.equal(shutdowns(), 0);
  });
});

for (const intent of ["subagent_done", "caller_ping"]) {
  test(`native /new aborting an active ${intent} batch never closes the replacement session`, async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    await withCompletionRuntime(index => index === 0 ? { stopReason: "toolUse", content: [
      { type: "toolCall", id: "intent", name: intent, arguments: intent === "subagent_done" ? { close: true } : { message: "Help" } },
      { type: "toolCall", id: "slow", name: "slow", arguments: {} },
    ] } : { content: [{ type: "text", text: "Unrelated new session" }] }, async ({ runtime, shutdowns }) => {
      const original = process.env.PI_SUBAGENT_SESSION!;
      const oldPrompt = runtime.session.prompt("Start supervised work");
      await started;
      assert.equal(readRetainedCompletion(original, process.env.PI_SUBAGENT_ID!, []), null);
      assert.equal((await runtime.newSession()).cancelled, false);
      await oldPrompt;
      const interrupted = readRetainedCompletion(original, process.env.PI_SUBAGENT_ID!, [])!;
      assert.equal(interrupted.reason, "error");
      assert.equal(interrupted.keepOpen, true, "parent must not close a pane about to host a replacement session");
      const cursor = [`subagent:${process.env.PI_SUBAGENT_ID}:completion:${interrupted.eventId}`];
      await runtime.session.prompt("Unrelated work");
      assert.equal(readRetainedCompletion(original, process.env.PI_SUBAGENT_ID!, cursor), null);
      assert.equal(shutdowns(), 0);
    }, [pi => pi.registerTool({ name: "slow", label: "Slow", description: "test", parameters: Type.Object({}),
      execute: async (_id: string, _args: any, signal: AbortSignal) => {
        entered();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("Aborted outgoing sibling");
      } })]);
  });
}
