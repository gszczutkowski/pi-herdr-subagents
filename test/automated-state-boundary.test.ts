import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeFixture } from "./automated-boundary-fixture.ts";
import * as plan from "../pi-extension/subagents/plan-store.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";
import { createDeliveryState, enqueueDelivery, restoreDurableDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { canonicalSessionPath } from "../pi-extension/subagents/ownership.ts";
import { beginCompletionTurn, runCompletionFile, writeRunCompletion } from "../pi-extension/subagents/run-artifacts.ts";
import { readRetainedCompletion } from "../pi-extension/subagents/completion.ts";

test("shared session aliases isolate run artifacts while canonical outbox IDs dedupe native task imports", () => {
  const f = nativeFixture();
  const env = { session: process.env.PI_SUBAGENT_SESSION, id: process.env.PI_SUBAGENT_ID };
  let runtime: RuntimeStore | undefined;
  try {
    f.mutate((p, c) => plan.addTask(p, c, "Shared-session worker"));
    f.mutate((p, c) => plan.startAttempt(p, c, p.tasks[0].taskId));
    const session = join(f.dir, "child.jsonl");
    const alias = join(f.dir, "alias", "..", "child.jsonl");
    mkdirSync(join(f.dir, "alias"));
    writeFileSync(session, "");
    assert.equal(canonicalSessionPath(alias), canonicalSessionPath(session));
    runtime = new RuntimeStore(join(f.dir, "runtime"), {
      sessionFile: f.sm.getSessionFile()!, headerId: f.sm.getSessionId(), branchToken: "boundary", checkpoint: "test",
    });
    const state = createDeliveryState(); state.store = runtime;
    state.onEnvelope = (runId, envelope) => importPlanEnvelope(f.p, f.ctx, runtime!.snapshot().runs[runId].planTask, runId, envelope);
    for (const [id, path] of [["old-run", session], ["new-run", alias]]) {
      const p = f.read(); const task = p.tasks[0];
      const binding = bindPlanRun(f.p, f.ctx, id, { planId: p.planId, taskId: task.taskId,
        attemptId: task.attempts[0].attemptId, expectedRevision: p.revision });
      runtime.prepare({ id, sessionFile: path, name: id, task: task.title, startTime: 1, planTask: binding });
      process.env.PI_SUBAGENT_SESSION = path; process.env.PI_SUBAGENT_ID = id;
      beginCompletionTurn();
      writeRunCompletion({ type: "done", keepOpen: true });
      const completion = readRetainedCompletion(path, id, [])!;
      assert.equal(completion.reason, "done"); assert.ok(completion.eventId);
      const owner = { id, lifecycle: createLifecycle(1) };
      const message = { customType: "subagent_result", content: "proposal", display: true, details: { sessionFile: path } };
      enqueueDelivery(state, owner, message, () => {}, completion.eventId);
      const revision = f.read().revision;
      enqueueDelivery(state, owner, message, () => assert.fail("duplicate handoff"), completion.eventId);
      assert.equal(f.read().revision, revision);
      const cursor = runtime.snapshot().runs[id].eventCursor;
      assert.deepEqual(cursor, [`subagent:${id}:completion:${completion.eventId}`]);
      assert.equal(readRetainedCompletion(path, id, cursor), null);
      assert.equal(f.read().tasks[0].status, "in_review", "process success is not acceptance");
    }
    assert.notEqual(runCompletionFile(session, "old-run"), runCompletionFile(session, "new-run"));
    // A correctly named file with a foreign run payload must not cross custody.
    writeFileSync(runCompletionFile(session, "victim"), JSON.stringify({ type: "done", runId: "old-run", eventId: "foreign" }));
    assert.equal(readRetainedCompletion(session, "victim", []), null);
    assert.equal(JSON.parse(readFileSync(runCompletionFile(session, "victim"), "utf8")).runId, "old-run");
    const snapshot = runtime.snapshot();
    assert.equal(Object.keys(snapshot.outbox).length, 2);
    assert.equal(f.read().tasks[0].attempts.length, 1);
    assert.equal(f.read().tasks[0].attempts[0].results.length, 2);
    assert.deepEqual(f.read().tasks[0].evidence, []);
    const recovered = createDeliveryState();
    restoreDurableDeliveries(recovered, runtime, new Set());
    for (const event of Object.values(snapshot.outbox)) {
      const revision = f.read().revision;
      importPlanEnvelope(f.p, f.ctx, snapshot.runs[event.runId].planTask, event.runId, event.envelope);
      assert.equal(f.read().revision, revision, "durable replay shares native canonical dedupe");
    }
    assert.equal(recovered.pending.size, 2);
  } finally {
    runtime?.close();
    if (env.session === undefined) delete process.env.PI_SUBAGENT_SESSION; else process.env.PI_SUBAGENT_SESSION = env.session;
    if (env.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = env.id;
    f.cleanup();
  }
});
