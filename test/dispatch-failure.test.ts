import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as store from "../pi-extension/subagents/plan-store.ts";
import { PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { bindPlanRun, importPlanEnvelope, recordDispatchFailure } from "../pi-extension/subagents/plan-runtime.ts";
import { RuntimeStore } from "../pi-extension/subagents/runtime-store.ts";

test("failure evidence survives native append fault and fresh runtime custody with original authority", () => {
  for (const dispatched of [false, true]) {
    const dir = fs.mkdtempSync(join(tmpdir(), "failure-outbox-"));
    let runtime: RuntimeStore | undefined;
    try {
      const sm = SessionManager.create(dir, dir);
      sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
      let rejectAppend = false;
      const p = new PlanPersistence((t, d) => { if (rejectAppend) throw new Error("append unavailable"); sm.appendCustomEntry(t, d); }, false);
      let plan = p.create(sm, 0, "Failure durability");
      plan = p.mutate(sm, plan.planId, plan.revision, (p, c) => store.addTask(p, c, "Task"));
      plan = p.mutate(sm, plan.planId, plan.revision, (p, c) => store.startAttempt(p, c, p.tasks[0].taskId));
      const binding = bindPlanRun(p, { sessionManager: sm } as any, "run", { planId: plan.planId, taskId: plan.tasks[0].taskId, attemptId: plan.tasks[0].attempts[0].attemptId, expectedRevision: plan.revision })!;
      const parent = { sessionFile: sm.getSessionFile()!, headerId: sm.getSessionId(), branchToken: "original", checkpoint: "checkpoint" };
      runtime = new RuntimeStore(join(dir, "runtime"), parent);
      assert.throws(() => recordDispatchFailure(p, { sessionManager: sm } as any, binding, "unpersisted", new Error("launch failed"), undefined,
        { id: "unpersisted", sessionFile: join(dir, "child.jsonl"), name: "Child", task: "Task", startTime: 1 }), /NOT persisted/);
      assert.equal(p.read(sm).snapshot!.tasks[0].status, "in_progress");
      rejectAppend = true;
      assert.throws(() => recordDispatchFailure(p, { sessionManager: sm } as any, binding, "run", new Error("original launch error"), runtime,
        { id: "run", sessionFile: join(dir, "child.jsonl"), name: "Child", task: "Task", startTime: 1 }, dispatched), /append failed/);
      const event = Object.values(runtime.snapshot().outbox)[0];
      assert.equal(event.status, "handedOff");
      assert.deepEqual(runtime.snapshot().runs.run.planTask, binding);
      assert.equal(p.read(sm).snapshot!.tasks[0].status, "in_progress");
      rejectAppend = false;
      p.reconcile(sm);
      const leaf = sm.getLeafId()!;
      plan = p.read(sm).snapshot!;
      p.detach(sm, plan.planId, plan.revision, "Wrong branch");
      const wrong = p.read(sm).snapshot!;
      assert.throws(() => importPlanEnvelope(p, { sessionManager: sm } as any, binding, "run", event.envelope));
      assert.deepEqual(p.read(sm).snapshot, wrong);
      sm.branch(leaf);
      runtime.close();
      runtime = undefined;
      const script = `
        import assert from 'node:assert/strict';
        import { SessionManager } from '@earendil-works/pi-coding-agent';
        import { RuntimeStore } from ${JSON.stringify(new URL('../pi-extension/subagents/runtime-store.ts', import.meta.url).href)};
        import { PlanPersistence } from ${JSON.stringify(new URL('../pi-extension/subagents/plan-persistence.ts', import.meta.url).href)};
        import { importPlanEnvelope } from ${JSON.stringify(new URL('../pi-extension/subagents/plan-runtime.ts', import.meta.url).href)};
        const runtime = new RuntimeStore(${JSON.stringify(join(dir, 'runtime'))}, ${JSON.stringify(parent)});
        try {
          const disk = SessionManager.open(${JSON.stringify(sm.getSessionFile())});
          disk.branch(${JSON.stringify(leaf)});
          const fresh = new PlanPersistence((t, d) => disk.appendCustomEntry(t, d), false);
          const restored = runtime.snapshot();
          for (const event of Object.values(restored.outbox)) importPlanEnvelope(fresh, { sessionManager: disk }, restored.runs[event.runId].planTask, event.runId, event.envelope);
          const imported = fresh.read(disk).snapshot;
          assert.equal(imported.tasks[0].status, ${JSON.stringify(dispatched ? 'blocked' : 'failed')});
          assert.equal(imported.tasks[0].attempts[0].results.length, 1);
          assert.deepEqual(imported.authority, ${JSON.stringify(binding.authority)});
          for (const event of Object.values(restored.outbox)) importPlanEnvelope(fresh, { sessionManager: disk }, restored.runs[event.runId].planTask, event.runId, event.envelope);
          assert.equal(fresh.read(disk).snapshot.revision, imported.revision);
        } finally { runtime.close(); }
      `;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
    } finally { runtime?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
