import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as store from "./plan-store.ts";
import { PlanPersistence } from "./plan-persistence.ts";

const text = () => Type.String({ minLength: 1, maxLength: 8192 });
const list = <T extends ReturnType<typeof text>>(item: T) => Type.Array(item, { maxItems: 1000 });
const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const criterion = object({ criterionId: text(), text: text() });
const artifact = object({ artifactId: text(), ref: text() });
const definitions = {
  scope: Type.Optional(text()), owner: Type.Optional(text()),
  criteria: Type.Optional(Type.Array(criterion, { maxItems: 1000 })),
  artifacts: Type.Optional(Type.Array(artifact, { maxItems: 1000 })),
  dependencies: Type.Optional(list(text())),
};
const command = <const A extends string, T extends TProperties>(action: A, props: T) => object({ action: Type.Literal(action), planId: text(), ...props });
const authority = object({ sessionId: text(), branchInstanceId: text() });
const mapping = Type.Record(Type.String({ maxLength: 8192 }), list(text()), { maxProperties: 1000 });
const statuses = ["block", "submitReview", "reject", "skip", "cancel", "reopen"] as const;
export const PlanUpdateParams = object({
  expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  command: Type.Union([
    object({ action: Type.Literal("create"), title: text() }),
    command("detach", { reason: text() }),
    command("add", { title: text(), details: Type.Optional(object(definitions)) }),
    command("edit", { taskId: text(), patch: object({ title: Type.Optional(text()), ...definitions }) }),
    command("attempt", { taskId: text(), mode: Type.Union([Type.Literal("start"), Type.Literal("retry")]), childSession: Type.Optional(text()) }),
    command("run", { taskId: text(), attemptId: text(), runId: text() }),
    command("result", {
      taskId: text(), attemptId: text(), origin: authority,
      result: object({ eventId: text(), runId: text(), ref: text(), kind: Type.Optional(Type.Union([Type.Literal("result"), Type.Literal("ping"), Type.Literal("failure"), Type.Literal("process_exit")])), reason: Type.Optional(text()) }),
    }),
    command("evidence", { taskId: text(), evidence: object({ criterionId: text(), ref: text(), artifactId: Type.Optional(text()), resultEventId: Type.Optional(text()) }) }),
    command("status", { taskId: text(), transition: Type.Union(statuses.map(s => Type.Literal(s))), reason: text() }),
    command("accept", { taskId: text(), criteria: mapping, reason: text() }),
  ]),
});
export type PlanUpdate = Static<typeof PlanUpdateParams>;

function apply(plan: store.PlanSnapshot, context: store.CommandContext, command: Exclude<PlanUpdate["command"], { action: "create" | "detach" }>): store.PlanSnapshot {
  switch (command.action) {
    case "add": return store.addTask(plan, context, command.title, command.details);
    case "edit": return store.editTask(plan, context, command.taskId, command.patch);
    case "attempt": return (command.mode === "retry" ? store.retry : store.startAttempt)(plan, context, command.taskId, command.childSession);
    case "run": return store.attachRun(plan, context, command.taskId, command.attemptId, command.runId);
    case "result": return store.recordResult(plan, context, command.taskId, command.attemptId, command.result);
    case "evidence": return store.addEvidence(plan, context, command.taskId, command.evidence);
    case "status": return store[command.transition](plan, context, command.taskId, command.reason);
    case "accept": return store.accept(plan, context, command.taskId, command.criteria, command.reason);
    default: throw new Error("Unsupported plan command");
  }
}

function response(details: unknown) {
  const json = JSON.stringify(details, null, 2);
  const output = truncateHead(json, { maxBytes: 40000, maxLines: 2000 });
  return { content: [{ type: "text" as const, text: output.content + (output.truncated ? "\n[Truncated; use plan_read with taskId for details]" : "") }], details };
}

/** Single registration boundary; no launches, runtime result adapters, or UI/context hooks. */
export function registerPlanTools(pi: ExtensionAPI): PlanPersistence {
  const persistence = new PlanPersistence((type, data) => pi.appendEntry(type, data), Boolean(process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SESSION));
  const restore = (_event: unknown, ctx: ExtensionContext) => { persistence.restore(ctx.sessionManager); };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.registerTool({
    name: "plan_read", label: "Read plan",
    description: "Read the active branch's durable plan, revision and recovery uncertainty. Optional taskId returns full task details. No runtime liveness is implied. Output bounded to 40KB.",
    parameters: object({ taskId: Type.Optional(text()), reconcile: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const view = params.reconcile ? persistence.reconcile(ctx.sessionManager) : persistence.read(ctx.sessionManager);
      const plan = view.snapshot;
      if (params.taskId && !plan?.tasks.some(task => task.taskId === params.taskId)) throw new Error("Unknown task");
      return response({ ...view, snapshot: plan ? { ...plan, tasks: params.taskId ? plan.tasks.filter(task => task.taskId === params.taskId) : plan.tasks.map(task => ({ taskId: task.taskId, title: task.title, status: task.status, statusReason: task.statusReason })) } : undefined });
    },
  });
  pi.registerTool({
    name: "plan_update", label: "Update plan", executionMode: "sequential",
    description: "Parent-only revision-checked durable commands (not snapshot replacement). Read first; supply planId and expectedRevision. Criteria/artifact IDs are UUIDs supplied by caller. Attempts/runs are references only, never launches. Results require original authority. Acceptance requires review and evidence for all criteria. Definition edits invalidate acceptance. Foreign/forked or historical plans are read-only until explicit detach (new planId/authority; inherited attempts need retry). No --no-session/setup-only durability.",
    parameters: PlanUpdateParams,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(PlanUpdateParams, params)) throw new Error("Invalid bounded plan command");
      const c = params.command;
      const snapshot = c.action === "create" ? persistence.create(ctx.sessionManager, params.expectedRevision, c.title) :
        c.action === "detach" ? persistence.detach(ctx.sessionManager, c.planId, params.expectedRevision, c.reason) :
        persistence.mutate(ctx.sessionManager, c.planId, params.expectedRevision, (plan, context) => apply(plan, context, c), c.action === "result" ? c.origin : undefined);
      return response({ planId: snapshot.planId, revision: snapshot.revision, authority: snapshot.authority, tasks: snapshot.tasks });
    },
  });
  return persistence;
}
