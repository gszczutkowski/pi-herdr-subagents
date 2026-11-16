import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type { PlanView } from "./plan-persistence.ts";
import type { PlanSnapshot, PlanTask } from "./plan-store.ts";

const text = () => Type.String({ minLength: 1, maxLength: 8192 });
const sections = ["tasks", "definition", "criteria", "dependencies", "artifacts", "attempts", "runs", "results", "evidence", "decisions", "statusHistory", "json"] as const;
export const PlanReadParams = Type.Object({
  taskId: Type.Optional(text()), reconcile: Type.Optional(Type.Boolean()),
  section: Type.Optional(Type.Union(sections.map(section => Type.Literal(section)))),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
  planId: Type.Optional(text()), expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  documentHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" })),
}, { additionalProperties: false });
export type PlanRead = Static<typeof PlanReadParams>;
const MAX_BYTES = 40000;
const MAX_LINES = 2000;
const encode = (value: unknown) => JSON.stringify(value, null, 2);
const fits = (value: unknown) => {
  const json = encode(value);
  return Buffer.byteLength(json, "utf8") <= MAX_BYTES && json.split("\n").length <= MAX_LINES;
};

function overview(plan: PlanSnapshot) {
  return { ...plan, tasks: plan.tasks.map(task => ({ taskId: task.taskId, title: task.title, status: task.status, statusReason: task.statusReason })) };
}
function* items(section: Exclude<PlanRead["section"], undefined | "json">, plan: PlanSnapshot, task?: PlanTask): Generator<unknown> {
  if (section === "tasks") {
    for (const task of plan.tasks) yield { taskId: task.taskId, title: task.title, status: task.status, statusReason: task.statusReason };
  } else if (section === "definition") {
    yield { taskId: task!.taskId, title: task!.title, scope: task!.scope, owner: task!.owner, status: task!.status, statusReason: task!.statusReason };
  } else if (section === "attempts") {
    for (const { runIds, results, ...attempt } of task!.attempts) yield { ...attempt, runCount: runIds.length, resultCount: results.length };
  } else if (section === "runs" || section === "results") {
    for (const attempt of task!.attempts) {
      for (const item of section === "runs" ? attempt.runIds : attempt.results) {
        yield section === "runs" ? { attemptId: attempt.attemptId, runId: item } : { attemptId: attempt.attemptId, ...item as object };
      }
    }
  } else yield* task![section];
}

/** Pages contain only their slice, never an unbounded snapshot in hidden details.
 * The original small-read shape is preserved. Partial reads cannot certify that
 * the model saw the complete ordinary plan-context projection. */
export function preparePlanRead(view: PlanView, params: PlanRead): { data: Record<string, unknown>; completeOverview: boolean } {
  const plan = view.snapshot;
  const task = params.taskId ? plan?.tasks.find(task => task.taskId === params.taskId) : undefined;
  if (params.taskId && !task) throw new Error("Unknown task");
  if ((params.planId === undefined) !== (params.expectedRevision === undefined)) throw new Error("Read cursor requires both planId and expectedRevision");
  if (params.planId !== undefined && (plan?.planId !== params.planId || plan.revision !== params.expectedRevision)) {
    throw new Error("Plan changed during pagination; restart plan_read without the cursor");
  }
  if (!params.section && (params.offset !== undefined || params.limit !== undefined)) throw new Error("offset/limit require a plan_read section");
  if (params.documentHash !== undefined && (params.section !== "json" || params.planId === undefined)) throw new Error("documentHash requires json section and a pinned plan cursor");
  if (params.section === "json" && (params.offset ?? 0) > 0 && params.documentHash === undefined) throw new Error("JSON continuation requires the returned documentHash cursor; restart from offset 0");
  if (params.section && params.section !== "json" && (params.limit ?? 50) > 100) throw new Error("Collection page limit must be between 1 and 100; json accepts up to 8192 characters");
  if (params.section && params.section !== "json" && ((params.section === "tasks") === Boolean(task))) {
    throw new Error(params.section === "tasks" ? "tasks section does not accept taskId" : "Task section requires taskId");
  }
  if (!plan) {
    if (params.section) throw new Error("No active plan");
    return { data: { ...view }, completeOverview: true };
  }
  const raw = { ...view, snapshot: task ? { ...plan, tasks: [task] } : plan };
  if (!params.section) {
    const data = { ...view, snapshot: task ? { ...plan, tasks: [task] } : overview(plan) };
    if (fits(data)) return { data, completeOverview: !task };
  }
  const cursor = (section: NonNullable<PlanRead["section"]>, offset = 0, limit?: number) => ({
    ...(task ? { taskId: task.taskId } : {}), section, offset, ...(limit === undefined ? {} : { limit }),
    planId: plan.planId, expectedRevision: plan.revision,
  });
  // Recovery diagnostics are bounded here, not discarded from storage. Full
  // authority, diagnostics and all task fields remain recoverable through json.
  const base = { planId: plan.planId, revision: plan.revision, writable: view.writable,
    ...(view.detachRequired ? { detachRequired: view.detachRequired } : {}),
    ...(view.error ? { error: view.error.slice(0, 512), errorTruncated: view.error.length > 512 } : {}),
    recoveryUncertainCount: view.recoveryUncertain.length,
    ...(task ? { taskId: task.taskId } : {}), partial: true, jsonRead: cursor("json") };
  if (!params.section) {
    const available = task ? sections.filter(section => section !== "tasks" && section !== "json") : ["tasks" as const];
    return { data: { ...base, message: "Full read exceeds 40KB/2000 lines; read collection pages or reconstruct the complete view with json pages.",
      sections: available.map(section => ({ section, read: cursor(section) })) }, completeOverview: false };
  }
  const section = params.section;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? (section === "json" ? 4096 : 50);
  if (section === "json") {
    // UTF-16 string offsets, not byte/line offsets. Rejoining jsonText slices
    // reconstructs exactly one JSON document, even across escaped or astral text.
    const json = encode(raw);
    // Restore/reconcile can change access or recovery diagnostics at the same
    // plan revision. Pin the exact document, not only its immutable snapshot.
    const documentHash = createHash("sha256").update(json).digest("hex");
    if (params.documentHash !== undefined && params.documentHash !== documentHash) throw new Error("Read document changed during pagination; restart JSON read from offset 0");
    if (offset > json.length) throw new Error("Read offset exceeds section length");
    const page = (length: number) => ({ ...base, section, offset, total: json.length, returned: length, documentHash,
      jsonText: json.slice(offset, offset + length), next: offset + length < json.length ? { ...cursor(section, offset + length, limit), documentHash } : null });
    let low = 0, high = Math.min(limit, json.length - offset);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(page(mid))) low = mid; else high = mid - 1;
    }
    if (low === 0 && offset < json.length) throw new Error("Cannot fit a JSON fragment within the plan_read output budget");
    return { data: page(low), completeOverview: false };
  }
  // Iterate flattened results without constructing up to a million-item array.
  const count = section === "tasks" ? plan.tasks.length : section === "definition" ? 1 :
    section === "runs" || section === "results" ? task!.attempts.reduce((sum, attempt) => sum + (section === "runs" ? attempt.runIds.length : attempt.results.length), 0) :
    section === "attempts" ? task!.attempts.length : task![section].length;
  if (offset > count) throw new Error("Read offset exceeds section length");
  const selected: unknown[] = [];
  const page = () => ({ ...base, section, offset, total: count, returned: selected.length, items: selected,
    next: offset + selected.length < count ? cursor(section, offset + selected.length, limit) : null });
  let index = 0;
  for (const item of items(section, plan, task)) {
    if (index++ < offset) continue;
    if (selected.length === limit) break;
    selected.push(item);
    if (!fits(page())) {
      selected.pop();
      if (selected.length === 0) return { data: { ...base, section, offset, total: count, returned: 0, items: [], next: null,
        oversizedItem: true, message: "This item exceeds the output budget. Use jsonRead and join jsonText pages to recover the complete view; no item was skipped." }, completeOverview: false };
      break;
    }
  }
  return { data: page(), completeOverview: false };
}
