import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, opendirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isLineage, LineageSchema, LINEAGE_ASSIGNMENT, sessionLineage, type Lineage } from "./lineage.ts";
import { canonicalSessionPath } from "./ownership.ts";
import type { PlanPersistence } from "./plan-persistence.ts";

const text = Type.String({ maxLength: 4096 });
export const HistorySchema = Type.Object({
  version: Type.Literal(1), id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  timestamp: Type.String({ maxLength: 32 }), lineage: LineageSchema,
  runId: text, kind: Type.Union(["assignment", "result", "ping", "continuation", "failure", "state", "decision"].map(v => Type.Literal(v))),
  summary: Type.String({ maxLength: 320 }), refs: Type.Array(text, { maxItems: 4 }),
}, { additionalProperties: false });
export type HistoryEvent = Static<typeof HistorySchema>;
export function boundedSummary(text: string): string {
  let result = "";
  for (const char of text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()) {
    if (Buffer.byteLength(result + char, "utf8") > 320) break;
    result += char;
  }
  return result;
}
export function isHistoryEvent(value: unknown): value is HistoryEvent {
  return Value.Check(HistorySchema, value) && isLineage(value.lineage)
    && Buffer.byteLength(value.summary, "utf8") <= 320 && Number.isFinite(Date.parse(value.timestamp));
}

/** Immutable unique records. A hard link publishes fully fsynced bytes without replacement.
 * Same-user filesystem trust, not authentication or a security sandbox. Failures are best-effort UI only. */
export function recordHistory(lineage: Lineage | undefined, runId: string, kind: HistoryEvent["kind"],
  summary: string, sourceId: string, refs: string[] = []): boolean {
  if (!lineage || !isLineage(lineage)) return false;
  const id = createHash("sha256").update(JSON.stringify([lineage, runId, kind, sourceId])).digest("hex");
  const event: HistoryEvent = { version: 1, id, timestamp: new Date().toISOString(), lineage,
    runId, kind, summary: boundedSummary(summary), refs: refs.slice(0, 4).map(ref => ref.slice(0, 4096)) };
  if (!isHistoryEvent(event) || Buffer.byteLength(JSON.stringify(event), "utf8") > 24576) return false;
  const temporary = join(lineage.eventDirectory, `${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    mkdirSync(lineage.eventDirectory, { recursive: true, mode: 0o700 });
    fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, JSON.stringify(event)); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, join(lineage.eventDirectory, `${id}.json`));
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); try { rmSync(temporary, { force: true }); } catch { /* fail closed */ } }
}

/** Only native active-branch root assignments confer visibility. File/pane presence never grants custody. */
export function historyAnchors(manager: any): Lineage[] {
  if (typeof manager.getBranch !== "function" || !manager.getSessionFile()) return [];
  const branch = manager.getBranch();
  const file = canonicalSessionPath(manager.getSessionFile());
  const own = sessionLineage(manager);
  if (own) return [own];
  return branch.flatMap((e: any) => e.type === "custom" && e.customType === LINEAGE_ASSIGNMENT && isLineage(e.data)
    && e.data.root.sessionFile === file && e.data.root.sessionId === manager.getSessionId()
    && branch.some((c: any) => c.id === e.data.rootCheckpoint && c.type === "custom" && c.customType === "subagent-custody"
      && c.data?.branchToken === e.data.rootBranchToken) ? [e.data] : []);
}
export function readHistory(anchors: Lineage[], limit = 2000): HistoryEvent[] {
  const events = new Map<string, HistoryEvent>();
  // Bounded even on hostile/corrupt directories. Omitted records stay on disk.
  for (const directory of new Set(anchors.map(a => a.eventDirectory))) {
    try {
      const names: string[] = [];
      const directoryHandle = opendirSync(directory);
      try {
        for (let count = 0; count < 10000; count++) {
          const entry = directoryHandle.readSync();
          if (!entry) break;
          if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) names.push(entry.name);
        }
      } finally { directoryHandle.closeSync(); }
      for (const name of names.sort()) {
        try {
          const path = join(directory, name);
          if (statSync(path).size > 24576) continue;
          const e = JSON.parse(readFileSync(path, "utf8"));
          if (!isHistoryEvent(e) || name !== `${e.id}.json`) continue;
          if (!anchors.some(a => a.eventDirectory === directory && a.rootAssignmentId === e.lineage.rootAssignmentId
            && a.rootCheckpoint === e.lineage.rootCheckpoint && a.rootBranchToken === e.lineage.rootBranchToken
            && JSON.stringify(a.root) === JSON.stringify(e.lineage.root))) continue;
          events.set(e.id, e);
        } catch { /* malformed/partial/unknown records do not become history */ }
      }
    } catch { /* missing history is not permission to invent it */ }
  }
  return [...events.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)).slice(-Math.min(2000, Math.max(0, limit)));
}

/** Observe the authoritative persistence boundary, never a second task store. */
export function registerPlanHistory(persistence: PlanPersistence): () => void {
  const revisions = new Map<string, number>();
  return persistence.subscribe(manager => {
    const view = persistence.read(manager);
    const plan = view.snapshot;
    if (!plan || !view.writable) return;
    const key = `${manager.getSessionId()}:${plan.planId}:${plan.authority.branchInstanceId}`;
    const previous = revisions.get(key);
    revisions.set(key, plan.revision);
    if (previous === undefined || plan.revision <= previous) return; // restore is not a new decision
    for (const lineage of historyAnchors(manager)) for (const task of plan.tasks) {
      for (const change of task.statusHistory.filter(c => c.revision > previous)) {
        recordHistory(lineage, task.attempts.at(-1)?.runIds.at(-1) ?? task.taskId, "state",
          `${task.taskId}: ${change.status}: ${change.reason}`, `${plan.planId}:${task.taskId}:status:${change.revision}`,
          [manager.getSessionFile()!, `plan:${plan.planId}/task:${task.taskId}@${change.revision}`]);
      }
      for (const decision of task.decisions.filter(d => d.revision > previous)) {
        recordHistory(lineage, task.attempts.at(-1)?.runIds.at(-1) ?? task.taskId, "decision",
          `${task.taskId}: ${decision.kind}: ${decision.reason}`, `${plan.planId}:${task.taskId}:decision:${decision.revision}`,
          [manager.getSessionFile()!, `plan:${plan.planId}/task:${task.taskId}@${decision.revision}`]);
      }
    }
  });
}
