import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { planLines } from "../pi-extension/subagents/plan-view.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { nativeFixture } from "./automated-boundary-fixture.ts";
import * as store from "../pi-extension/subagents/plan-store.ts";
import { PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { createDeliveryState, enqueueDelivery, type DeliveryEnvelope } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

const adapter = (sm: SessionManager) => new PlanPersistence((type, data) => sm.appendCustomEntry(type, data), false);

test("native restore, retry and fork detach fence late runtime proposals and dependent acceptance", () => {
  const f = nativeFixture();
  try {
    const criterionId = randomUUID();
    const criteria = [{ criterionId, text: "Parent verified" }];
    f.mutate((p, c) => store.addTask(p, c, "Prerequisite", { criteria }));
    const prerequisite = f.read().tasks[0].taskId;
    f.mutate((p, c) => store.addTask(p, c, "Dependent", { dependencies: [prerequisite], criteria }));
    const dependent = f.read().tasks[1].taskId;
    f.mutate((p, c) => store.startAttempt(p, c, prerequisite));
    const p = f.read();
    const binding = bindPlanRun(f.p, f.ctx, "origin-run", { planId: p.planId, taskId: prerequisite,
      attemptId: p.tasks[0].attempts[0].attemptId, expectedRevision: p.revision })!;
    const state = createDeliveryState();
    state.onEnvelope = (id, envelope) => importPlanEnvelope(f.p, f.ctx, binding, id, envelope);
    enqueueDelivery(state, { id: "origin-run", lifecycle: createLifecycle(1) }, {
      customType: "subagent_ping", content: "Need schema approval", display: true,
      details: { message: "Need schema approval" },
    }, () => assert.fail("no transport attached"), "decision");
    assert.equal(f.read().tasks[0].status, "blocked");
    const blocked = f.read();
    const disk = SessionManager.open(f.sm.getSessionFile()!);
    const restored = adapter(disk);
    assert.deepEqual(restored.restore(disk).snapshot, blocked);
    assert.equal(restored.read(disk).snapshot!.tasks[0].statusReason, "Need schema approval");
    assert.deepEqual(restored.read(disk).snapshot!.tasks[0].attempts[0].runIds, ["origin-run"], "restore never creates runs");
    const mutate = (fn: Parameters<PlanPersistence["mutate"]>[3]) => {
      const p = restored.read(disk).snapshot!;
      return restored.mutate(disk, p.planId, p.revision, fn);
    };
    mutate((p, c) => store.retry(p, c, prerequisite));
    const retry = restored.read(disk).snapshot!;
    assert.equal(retry.tasks[0].attempts.length, 2);
    assert.deepEqual(retry.tasks[0].attempts[1].runIds, [], "retry is a parent command, not a relaunch");
    const late: DeliveryEnvelope = { message: { customType: "subagent_result", content: "Late proposal", display: true,
      details: { eventId: "subagent:origin-run:completion:late", sessionFile: "origin.jsonl" } },
      options: { triggerTurn: true, deliverAs: "steer" } };
    importPlanEnvelope(restored, { sessionManager: disk } as any, binding, "origin-run", late);
    assert.equal(restored.read(disk).snapshot!.tasks[0].status, "in_progress");
    assert.equal(restored.read(disk).snapshot!.tasks[0].attempts[0].results.length, 2);
    mutate((p, c) => store.submitReview(p, c, dependent, "Ready for parent"));
    assert.match(planLines(restored.read(disk), true).join("\n"), /Waiting on: T1/);
    assert.throws(() => mutate((p, c) => store.accept(p, c, dependent, {}, "No evidence")), /criteria/);
    const selected = disk.getLeafId()!;
    const sourceBytes = readFileSync(disk.getSessionFile()!, "utf8");
    const clone = SessionManager.open(disk.getSessionFile()!);
    clone.createBranchedSession(selected);
    const cp = adapter(clone);
    assert.equal(cp.restore(clone).detachRequired, "foreign");
    assert.throws(() => importPlanEnvelope(cp, { sessionManager: clone } as any, binding, "origin-run", late), /Foreign|read-only/);
    const copy = cp.detach(clone, retry.planId, cp.read(clone).snapshot!.revision, "Independent branch");
    assert.equal(copy.tasks[0].status, "blocked");
    const copyBefore = cp.read(clone).snapshot;
    assert.throws(() => importPlanEnvelope(cp, { sessionManager: clone } as any, binding, "origin-run", late), /identity|authority/);
    assert.deepEqual(cp.read(clone).snapshot, copyBefore);
    const copiedRetry = cp.mutate(clone, copy.planId, copy.revision, (p, c) => store.retry(p, c, prerequisite));
    assert.deepEqual(copiedRetry.tasks[0].attempts.at(-1)!.runIds, []);
    assert.equal(readFileSync(disk.getSessionFile()!, "utf8"), sourceBytes);
    // Only the origin branch may accept, after its own review and evidence.
    mutate((p, c) => store.submitReview(p, c, prerequisite, "Parent checked retry"));
    for (const id of [prerequisite, dependent]) {
      mutate((p, c) => store.addEvidence(p, c, id, { criterionId, ref: "Parent-reviewed report" }));
      mutate((p, c) => store.accept(p, c, id, { [criterionId]: p.tasks.find(t => t.taskId === id)!.evidence.map(e => e.evidenceId) }, "Verified"));
    }
    assert.doesNotMatch(planLines(restored.read(disk), true).join("\n"), /Waiting on:/);
    const accepted = restored.read(disk).snapshot!;
    const latePing: DeliveryEnvelope = { ...late, message: { ...late.message, customType: "subagent_ping",
      details: { eventId: "subagent:origin-run:completion:late-ping", message: "Obsolete blocker" } } };
    importPlanEnvelope(restored, { sessionManager: disk } as any, binding, "origin-run", latePing);
    assert.deepEqual(restored.read(disk).snapshot!.tasks.map(t => t.status), ["accepted", "accepted"]);
    assert.equal(restored.read(disk).snapshot!.tasks[0].decisions.length, accepted.tasks[0].decisions.length);
    const final = SessionManager.open(disk.getSessionFile()!);
    assert.deepEqual(adapter(final).restore(final).snapshot, restored.read(disk).snapshot);
    assert.equal(cp.read(clone).snapshot!.tasks[0].status, "in_progress", "origin results never accept the independent branch");
  } finally { f.cleanup(); }
});
