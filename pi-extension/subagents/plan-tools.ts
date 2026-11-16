import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as store from "./plan-store.ts";
import { PlanPersistence } from "./plan-persistence.ts";
import { PlanReadParams, preparePlanRead } from "./plan-read.ts";
import { PLAN_CONTEXT_TYPE, planContext, registerPlanContext } from "./plan-context.ts";
import { contextReceipt, publicationState } from "./context-publication.ts";
import { registerPlanView } from "./plan-view-registration.ts";

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

function response(details: Record<string, unknown>, current?: string) {
  const json = JSON.stringify(details, null, 2);
  if (Buffer.byteLength(json, "utf8") > 40000 || json.split("\n").length > 2000) throw new Error("plan_read metadata exceeds the bounded response budget");
  const content = [{ type: "text" as const, text: json }];
  return { content, details: { ...details,
    ...contextReceipt(content, current ? [publicationState(PLAN_CONTEXT_TYPE, current)] : []) } };
}

/** Compact mutation content; the full legacy details shape remains available to UI consumers. */
export function planMutationReceipt(snapshot: store.PlanSnapshot, previous?: store.PlanSnapshot) {
  const tasks = snapshot.tasks.filter(task => JSON.stringify(task) !== JSON.stringify(previous?.tasks.find(old => old.taskId === task.taskId)));
  return { planId: snapshot.planId, revision: snapshot.revision, authority: snapshot.authority,
    tasks: tasks.map(task => {
      const old = previous?.tasks.find(item => item.taskId === task.taskId);
      return { taskId: task.taskId, status: task.status,
        criterionIds: task.criteria.filter(item => !old?.criteria.some(prior => prior.criterionId === item.criterionId)).map(item => item.criterionId),
        artifactIds: task.artifacts.filter(item => !old?.artifacts.some(prior => prior.artifactId === item.artifactId)).map(item => item.artifactId),
        attemptIds: task.attempts.filter(item => !old?.attempts.some(prior => prior.attemptId === item.attemptId)).map(item => item.attemptId),
        evidenceIds: task.evidence.filter(item => !old?.evidence.some(prior => prior.evidenceId === item.evidenceId)).map(item => item.evidenceId),
      };
    }),
  };
}

/** One persistence boundary for tools, native publications and the plan view. */
export function registerPlanTools(pi: ExtensionAPI, options: { publish?: boolean } = {}): PlanPersistence {
  const persistence = new PlanPersistence((type, data) => pi.appendEntry(type, data), Boolean(process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SESSION));
  const refresh = registerPlanView(pi, persistence);
  const restore = (_event: unknown, ctx: ExtensionContext) => { persistence.restore(ctx.sessionManager); refresh(ctx); };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.registerTool({
    name: "plan_read", label: "Read plan",
    description: "Read the active branch's durable plan, revision and recovery uncertainty; no runtime liveness implied. Small taskId reads return full details. Large reads provide section navigation. Collection sections use zero-based offset/limit (default 50, max 100); results/runs flatten attempts with attemptId. Tasks section requires no taskId; other collections require taskId. json pages (default 4096, max 8192 UTF-16 characters) reconstruct the complete view by joining jsonText then parsing JSON, including oversized individual items. Follow next cursors verbatim with planId/expectedRevision and JSON documentHash; restart if the plan or read document changed. Valid JSON bounded to 40KB/2000 lines per response.",
    parameters: PlanReadParams,
    async execute(_id, params, _signal, _update, ctx) {
      try {
        if (!Value.Check(PlanReadParams, params)) throw new Error("Invalid bounded plan read");
        const view = params.reconcile ? persistence.reconcile(ctx.sessionManager) : persistence.read(ctx.sessionManager);
        const read = preparePlanRead(view, params);
        return response(read.data, read.completeOverview ? planContext(view) : undefined);
      } finally { refresh(ctx); }
    },
  });
  pi.registerTool({
    name: "plan_update", label: "Update plan", executionMode: "sequential",
    description: "Parent-only revision-checked durable commands (not snapshot replacement). Read first; supply planId and expectedRevision. Criteria/artifact IDs are UUIDs supplied by caller. Attempts/runs are references only, never launches. Results require original authority. Acceptance requires review and evidence for all criteria. Definition edits invalidate acceptance. Foreign/forked or historical plans are read-only until explicit detach (new planId/authority; inherited attempts need retry). No --no-session/setup-only durability.",
    parameters: PlanUpdateParams,
    async execute(_id, params, signal, _update, ctx) {
      try {
        signal?.throwIfAborted();
        if (!Value.Check(PlanUpdateParams, params)) throw new Error("Invalid bounded plan command");
        const c = params.command;
        const previousView = persistence.read(ctx.sessionManager);
        const previous = previousView.snapshot;
        const snapshot = c.action === "create" ? persistence.create(ctx.sessionManager, params.expectedRevision, c.title) :
          c.action === "detach" ? persistence.detach(ctx.sessionManager, c.planId, params.expectedRevision, c.reason) :
          persistence.mutate(ctx.sessionManager, c.planId, params.expectedRevision, (plan, context) => apply(plan, context, c), c.action === "result" ? c.origin : undefined);
        const content = [{ type: "text" as const, text: JSON.stringify(planMutationReceipt(snapshot, previous)) }];
        const current = planContext(persistence.read(ctx.sessionManager));
        return { content, details: { planId: snapshot.planId, revision: snapshot.revision, authority: snapshot.authority, tasks: snapshot.tasks,
          ...contextReceipt(content, current ? [{ ...publicationState(PLAN_CONTEXT_TYPE, current),
            ...(previous ? { previousIdentity: publicationState(PLAN_CONTEXT_TYPE, planContext(previousView)!).identity } : {}) }] : [], params) } };
      } finally { refresh(ctx); }
    },
  });
  if (options.publish !== false) registerPlanContext(pi, persistence);
  return persistence;
}
