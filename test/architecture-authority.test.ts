import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { PLAN_ENTRY } from "../pi-extension/subagents/plan-persistence.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import type { DeliveryEnvelope } from "../pi-extension/subagents/delivery.ts";

test("model commands and runtime imports share the parent compare-command-append authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "architecture-authority-"));
  const saved = { id: process.env.PI_SUBAGENT_ID, session: process.env.PI_SUBAGENT_SESSION };
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_SESSION;
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  const ctx: any = { sessionManager: sm, hasUI: false };
  let appends = 0;
  const tools = new Map<string, any>();
  const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, registerCommand() {},
    appendEntry(type: string, data: any) { assert.equal(type, PLAN_ENTRY); appends++; sm.appendCustomEntry(type, data); } };
  const persistence = registerPlanTools(pi);
  const boundary = mock.method(persistence, "mutate");
  const read = () => persistence.read(sm).snapshot!;
  const update = (command: any, expectedRevision = read()?.revision ?? 0) => tools.get("plan_update").execute("call", { command, expectedRevision }, undefined, undefined, ctx);
  const unchanged = (bytes: string, count: number) => {
    assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), bytes);
    assert.equal(appends, count);
  };
  try {
    await update({ action: "create", title: "Parent owned" });
    const criterionId = randomUUID();
    await update({ action: "add", planId: read().planId, title: "Implementation", details: { criteria: [{ criterionId, text: "Verified by parent" }] } });
    const taskId = read().tasks[0].taskId;
    await update({ action: "attempt", planId: read().planId, taskId, mode: "start" });
    const attemptId = read().tasks[0].attempts[0].attemptId;
    const selection = { planId: read().planId, taskId, attemptId, expectedRevision: read().revision };
    const binding = bindPlanRun(persistence, ctx, "run", selection)!;
    const attachedTip = sm.getLeafId()!;
    const staleRevision = read().revision;
    const envelope: DeliveryEnvelope = { message: { customType: "subagent_result", display: true, content: "Worker claims completion",
      details: { eventId: "event", sessionFile: "child.jsonl", exitCode: 0 } }, options: { triggerTurn: true, deliverAs: "steer" } };
    const beforeImport = boundary.mock.callCount();
    importPlanEnvelope(persistence, ctx, binding, "run", envelope);
    assert.equal(boundary.mock.callCount(), beforeImport + 1, "runtime uses returned tool persistence boundary");
    assert.equal(read().tasks[0].status, "in_review", "a worker result cannot certify acceptance");
    const imported = read();
    const bytes = readFileSync(sm.getSessionFile()!, "utf8");
    const count = appends;
    await assert.rejects(update({ action: "edit", planId: binding.planId, taskId, patch: { title: "Stale model command" } }, staleRevision), /Revision conflict/);
    unchanged(bytes, count);
    importPlanEnvelope(persistence, ctx, binding, "run", envelope);
    unchanged(bytes, count); // canonical event replay is a no-op, not another task list
    await assert.rejects(update({ action: "accept", planId: binding.planId, taskId, criteria: {}, reason: "Worker says done" }), /Map ALL criteria/);
    unchanged(bytes, count);

    // Child policy applies even when passed the actual ancestor manager: neither
    // model commands nor runtime imports may append snapshots to that file.
    process.env.PI_SUBAGENT_ID = "child";
    const childTools = new Map<string, any>();
    const child = registerPlanTools({ ...pi, registerTool: (tool: any) => childTools.set(tool.name, tool) });
    await assert.rejects(childTools.get("plan_update").execute("child", { expectedRevision: imported.revision,
      command: { action: "status", planId: binding.planId, taskId, transition: "submitReview", reason: "Self review" } }, undefined, undefined, ctx), /Child/);
    assert.throws(() => importPlanEnvelope(child, ctx, binding, "run", { ...envelope,
      message: { ...envelope.message, details: { eventId: "child-event", exitCode: 0 } } }), /Child/);
    unchanged(bytes, count);
    delete process.env.PI_SUBAGENT_ID;

    sm.branch(attachedTip);
    assert.throws(() => importPlanEnvelope(persistence, ctx, binding, "run", envelope), /Historical.*read-only/);
    unchanged(bytes, count);
    const detached = persistence.detach(sm, binding.planId, staleRevision, "Alternative branch");
    const detachedBytes = readFileSync(sm.getSessionFile()!, "utf8");
    const detachedCount = appends;
    assert.throws(() => importPlanEnvelope(persistence, ctx, binding, "run", envelope), /identity conflict/);
    assert.throws(() => importPlanEnvelope(persistence, ctx, { ...binding, planId: detached.planId }, "run", envelope), /origin authority mismatch/);
    unchanged(detachedBytes, detachedCount);
    const reopened = SessionManager.open(sm.getSessionFile()!);
    assert.deepEqual(persistence.read(reopened).snapshot, detached, "native active branch is authoritative after reopen");
    assert.ok(boundary.mock.calls.length >= 6, "tool and runtime commands were audited at the same boundary");
  } finally {
    boundary.mock.restore();
    if (saved.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = saved.id;
    if (saved.session === undefined) delete process.env.PI_SUBAGENT_SESSION; else process.env.PI_SUBAGENT_SESSION = saved.session;
    rmSync(dir, { recursive: true, force: true });
  }
});
