import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { withChildSession } from "./child-session.ts";
import { canonicalSessionPath, type SessionOwner } from "../pi-extension/subagents/ownership.ts";
import { continuationDir, continueLiveChild } from "../pi-extension/subagents/live-continuation.ts";
import { createLifecycle, markInterruptRequested, markProcessRunning, observeActivity, observePaneInspection } from "../pi-extension/subagents/lifecycle.ts";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "native child failed to reach expected state");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function response(model: any, aborted: boolean): AssistantMessage {
  return { role: "assistant", provider: model.provider, model: model.id, api: model.api,
    content: aborted ? [] : [{ type: "text", text: "FOLLOW_UP_COMPLETED" }],
    stopReason: aborted ? "aborted" : "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

for (const scenario of ["manual-active-Escape", "idle-Escape", "missed-HC-working-Escape"] as const) {
  test(`native continuation: ${scenario} resumes the same process with current model context`, async () => {
    await withChildSession({ liveContinuation: true, autoExit: false, stream(model, _context, options, index) {
      const stream = createAssistantMessageEventStream();
      const finish = (aborted: boolean) => {
        const message = response(model, aborted);
        if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end();
      };
      if (index === 0 && scenario !== "idle-Escape") {
        options.signal.addEventListener("abort", () => finish(true), { once: true });
      } else finish(false);
      return stream;
    } }, async ({ session, requests, shutdowns }) => {
      const runId = process.env.PI_SUBAGENT_ID!;
      const sessionFile = canonicalSessionPath(process.env.PI_SUBAGENT_SESSION!);
      const activityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE!;
      const dir = continuationDir(activityFile);
      const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      const child = { id: runId, name: "Worker", cli: "pi", sessionFile, activityFile, surface: "same-process",
        lifecycle: scenario === "missed-HC-working-Escape"
          ? observePaneInspection(createLifecycle(1), { kind: "present", agentStatus: "idle", observedAt: 2 }, 2)
          : { ...markProcessRunning(createLifecycle(1), 2), turn: { kind: "waiting" as const, startedAt: 3 } },
        hasTurnResult: false };
      const owner: SessionOwner = { runId, surface: child.surface, dispatched: true };
      const transport = { inspect: async () => ({ kind: "present", agentStatus: "idle", observedAt: Date.now() } as const), timeoutMs: 2000 };
      const initial = session.prompt("INITIAL_NATIVE_TASK");
      await until(() => requests.length === 1);
      if (scenario !== "idle-Escape") {
        assert.equal(state().state, "busy");
        await assert.rejects(continueLiveChild(owner, child, { message: "must not dispatch while working" }, transport), /not confirmed settled/);
        assert.equal(readdirSync(dir).some(name => name.endsWith(".request.json")), false);
        if (scenario === "missed-HC-working-Escape") {
          // Control parent sampling only; activity and settlement are native Pi.
          const active = readSubagentActivityFile(activityFile, runId);
          assert.ok(active.ok);
          assert.equal(active.activity.phase, "active");
          child.lifecycle = markInterruptRequested(child.lifecycle, active.activity.updatedAt);
          child.lifecycle = observeActivity(child.lifecycle, active, active.activity.updatedAt);
          assert.equal(child.lifecycle.turn.kind, "active");
        }
        // SDK abort is the same native AgentSession cancellation used by Escape;
        // no synthetic agent_settled event or fabricated child token.
        await session.abort();
        await initial;
        assert.equal(state().state, "interrupted-idle");
        if (scenario === "missed-HC-working-Escape") {
          const waiting = readSubagentActivityFile(activityFile, runId);
          assert.ok(waiting.ok);
          assert.equal(waiting.activity.phase, "waiting");
          child.lifecycle = observeActivity(child.lifecycle, waiting, Date.now());
          child.lifecycle = observePaneInspection(child.lifecycle, { kind: "present", agentStatus: "idle", observedAt: Date.now() }, Date.now());
          assert.equal(child.lifecycle.hasWorked, false);
          assert.equal(child.lifecycle.turn.kind, "starting");
        }
        assert.equal(child.hasTurnResult, false, "manual Escape has no completion result");
      } else {
        await initial;
        child.hasTurnResult = true;
        assert.equal(state().state, "settled-idle");
        const token = state().idleToken;
        child.lifecycle = markInterruptRequested(child.lifecycle, Date.now()) as typeof child.lifecycle;
        await session.abort(); // Idle Escape produces no new settlement.
        assert.equal(state().idleToken, token);
      }
      const message = "  FOLLOW_UP_EXACT\n/skill:not-a-command\n@not-a-file\n!not-a-shell  ";
      assert.equal((await continueLiveChild(owner, child, { message }, transport)).status, "accepted");
      await until(() => requests.length === 2 && state().state === "settled-idle");
      const user = requests[1].messages.filter((entry: any) => entry.role === "user").at(-1);
      assert.deepEqual(user.content, [{ type: "text", text: message }]);
      assert.match(JSON.stringify(requests[1]), /INITIAL_NATIVE_TASK/);
      assert.equal(session.sessionFile, process.env.PI_SUBAGENT_SESSION);
      assert.equal(owner.continuationRequestId, undefined);
      assert.equal(shutdowns(), 0, "the supervised child remains open in every scenario");
      assert.equal(readdirSync(dir).filter(name => name.endsWith(".claim.json")).length, 1);
      // A stale parent idle label is insufficient after a new native run starts.
      assert.equal(requests.length, 2);
    });
  });
}
