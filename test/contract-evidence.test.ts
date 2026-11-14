import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerPlanTools } from "../pi-extension/subagents/plan-tools.ts";
import { bindPlanRun, importPlanEnvelope } from "../pi-extension/subagents/plan-runtime.ts";
import { resultClaimDiagnostics } from "../pi-extension/subagents/contracts.ts";

test("bound structured claims remain proposals; parent imports exact evidence through registered commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-evidence-"));
  const child = process.env.PI_SUBAGENT_ID; const childSession = process.env.PI_SUBAGENT_SESSION;
  delete process.env.PI_SUBAGENT_ID; delete process.env.PI_SUBAGENT_SESSION;
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "Parent assignment", timestamp: Date.now() });
    const tools = new Map<string, any>();
    const persistence = registerPlanTools({ appendEntry: (t: string, d: any) => sm.appendCustomEntry(t, d),
      registerTool: (t: any) => tools.set(t.name, t), on() {}, registerCommand() {}, registerShortcut() {} } as any);
    const ctx: any = { sessionManager: sm, hasUI: false };
    const read = () => persistence.read(sm).snapshot!;
    const execute = (command: any) => tools.get("plan_update").execute("parent", { expectedRevision: read()?.revision ?? 0, command }, undefined, undefined, ctx);
    await execute({ action: "create", title: "Review" });
    const criteria = [1, 2].map(n => ({ criterionId: randomUUID(), text: `Criterion ${n}` }));
    await execute({ action: "add", planId: read().planId, title: "Work", details: { criteria } });
    const taskId = read().tasks[0].taskId;
    const command = (action: string, extra = {}) => ({ action, planId: read().planId, taskId, ...extra });
    await execute(command("attempt", { mode: "start" }));
    const attemptId = read().tasks[0].attempts[0].attemptId;
    const binding = bindPlanRun(persistence, ctx, "worker", { planId: read().planId, taskId, attemptId, expectedRevision: read().revision })!;
    const structuredResult = { status: "complete" as const, summary: "All tests passed", artifacts: ["report.txt"],
      checks: criteria.map(c => ({ criterionIds: [c.criterionId], ref: `report.txt#${c.criterionId}`, outcome: "passed" as const })), unmetCriterionIds: [], risks: [] };
    const eventId = "subagent:worker:completion:turn";
    const envelope: any = { message: { customType: "subagent_result", display: true, content: "claim", details: { eventId, sessionFile: "child.jsonl", structuredResult } }, options: { triggerTurn: true, deliverAs: "steer" } };
    importPlanEnvelope(persistence, ctx, binding, "worker", envelope);
    assert.equal(read().tasks[0].status, "in_review");
    assert.equal(read().tasks[0].evidence.length, 0, "worker passing claims cannot import evidence themselves");
    await assert.rejects(execute(command("accept", { criteria: {}, reason: "Tests passed" })), /ALL criteria/);
    const retained = read().tasks[0].attempts[0].results;
    await assert.rejects(execute(command("evidence", { evidence: { criterionId: criteria[0].criterionId, ref: "report", resultEventId: "missing-event" } })), /Unknown result reference/);
    await assert.rejects(execute(command("evidence", { evidence: { criterionId: randomUUID(), ref: "report", resultEventId: eventId } })), /Unknown criterion/);
    assert.deepEqual(read().tasks[0].attempts[0].results, retained, "bad evidence never loses the delivered proposal");
    for (const check of structuredResult.checks) await execute(command("evidence", { evidence: {
      criterionId: check.criterionIds[0], ref: check.ref, resultEventId: eventId,
    } }));
    assert.equal(read().tasks[0].status, "in_review", "evidence is not acceptance");
    const evidence = read().tasks[0].evidence;
    await assert.rejects(execute(command("accept", { criteria: { [criteria[0].criterionId]: [evidence[1].evidenceId], [criteria[1].criterionId]: [evidence[0].evidenceId] }, reason: "Wrong mapping" })), /criterion evidence/);
    const mapping = Object.fromEntries(evidence.map(e => [e.criterionId, [e.evidenceId]]));
    await execute(command("accept", { criteria: mapping, reason: "Parent inspected both report sections" }));
    assert.equal(read().tasks[0].status, "accepted");
    assert.deepEqual(read().tasks[0].decisions.at(-1)?.criteria, mapping);
    const malformedRefs = { ...structuredResult, checks: [{ criterionIds: ["unknown"], ref: "report", outcome: "passed" as const }] };
    assert.match(resultClaimDiagnostics(malformedRefs, read().tasks[0]).join(";"), /Unknown criterion.*lacks passing/);
    importPlanEnvelope(persistence, ctx, binding, "worker", { ...envelope, message: { ...envelope.message, details: { ...envelope.message.details, eventId: "late", structuredResult: malformedRefs } } });
    assert.equal(read().tasks[0].status, "accepted", "late malformed claims do not undo parent decision");
    assert.equal(read().tasks[0].attempts[0].results.at(-1)?.eventId, "late");
    assert.match(read().tasks[0].attempts[0].results.at(-1)?.reason ?? "", /Unknown criterion/);
    await execute(command("edit", { patch: { criteria: [{ criterionId: randomUUID(), text: "Changed definition" }] } }));
    const revision = read().revision;
    importPlanEnvelope(persistence, ctx, binding, "worker", envelope);
    assert.equal(read().revision, revision, "definition edits do not make immutable replay conflict");
  } finally {
    if (child !== undefined) process.env.PI_SUBAGENT_ID = child;
    if (childSession !== undefined) process.env.PI_SUBAGENT_SESSION = childSession;
    rmSync(dir, { recursive: true, force: true });
  }
});
