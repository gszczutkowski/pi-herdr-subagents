import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RuntimeManifest } from "./runtime-store.ts";
import { registerContextPublication } from "./context-publication.ts";
import type { DispatchIncident } from "./dispatch-recovery.ts";

export interface RecoveryView {
  manifest?: RuntimeManifest; error?: string; paused?: string; diagnostics?: string[];
  storageError?: string;
  dispatch?: DispatchIncident[];
  /** Identity of a verified active plan when no manifest supplies notice scope. */
  planNoticeScope?: readonly string[];
  history?: { runId: string; message: string }[];
}
export const RECOVERY_CONTEXT_TYPE = "pi-subagents-recovery-context/v1";
const guidance = "Saved reconciliation is NOT current liveness. Delivery pending/unknown/handedOff is NOT task acceptance. Review retained results and original assignment before deciding; audit the session and process before explicit subagent_resume. Never automatically relaunch, resume, close, or infer acceptance. Resume the original parent session/branch; use subagents_recovery or /subagents-recovery for details.";

function clip(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  let output = "", used = 0;
  for (const char of value.toWellFormed()) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes - 16) break;
    output += char; used += size;
  }
  return output + "… [truncated]";
}

export function dispatchReport(view: RecoveryView, runId?: string, limit = 10): string[] {
  const selected = (view.dispatch ?? []).filter(item => !runId || item.runId === runId);
  const lines = selected.slice(0, limit).map(item => clip(`${item.runId}: ${item.status} (${item.code})${item.phase ? `; phase=${item.phase}` : ""}${item.reason ? `; reason=${item.reason}` : ""}${item.recordedAt ? `; recorded=${new Date(item.recordedAt).toISOString()}` : ""}${item.evidence ? `; evidence=${item.evidence}` : ""}${item.attempts !== undefined ? `; repair writes attempted=${item.attempts}` : ""}. ${item.next}`, 640));
  if (selected.length > limit) lines.push(`${selected.length - limit} dispatch incidents omitted; query subagents_recovery by runId.`);
  return lines;
}

export function recoveryHistory(view: RecoveryView, runId?: string): string[] {
  const history = (view.history ?? []).filter(item => !runId || item.runId === runId);
  const lines = history.slice(0, 3).map(item => `Historical dispatch diagnostic (${clip(item.runId, 160)}; not a current storage check): ${clip(item.message, 500)}`);
  if (history.length > 3) lines.push(`${history.length - 3} historical diagnostics omitted; query subagents_recovery by runId.`);
  return lines;
}

/** Pure bounded projection of existing evidence. No probing, delivery or store mutation. */
export function recoveryReport(view: RecoveryView, options: { runId?: string; offset?: number; limit?: number; compact?: boolean } = {}): string {
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Recovery bounds: limit 1..20, offset a nonnegative safe integer");
  }
  const lines = ["Read-only assignment recovery (saved evidence; no control granted).", guidance];
  if (view.error) return [...lines, `Unavailable/blocked: ${clip(view.error, 800)}`].join("\n");
  if (view.storageError) lines.push(`Storage uncertain; showing last verified evidence, not liveness: ${clip(view.storageError, 800)}`);
  lines.push(...dispatchReport(view, options.runId, options.compact ? 3 : limit));
  for (const diagnostic of (view.diagnostics ?? []).slice(0, 5)) lines.push(`Diagnostic: ${clip(diagnostic, 300)}`);
  if ((view.diagnostics?.length ?? 0) > 5) lines.push("Additional diagnostics omitted.");
  if (!options.compact) lines.push(...recoveryHistory(view, options.runId));
  if (!view.manifest) return clip([...lines, "No durable manifest for this parent. Legacy/missing records cannot establish that no unfinished work exists."].join("\n"), options.compact ? 4096 : 24000);
  if (view.paused) lines.push(`Paused diagnostics only: ${clip(view.paused, 500)}`);
  const runs = Object.values(view.manifest.runs).sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
  const selected = options.runId ? runs.filter(run => run.id === options.runId) : runs.slice(offset, offset + limit);
  const countLine = lines.length;
  lines.push(`Recorded assignments: ${runs.length}; offset=${offset}.`);
  if (options.runId && !selected.length) lines.push("Run not found in this parent's manifest.");
  let shown = 0;
  for (const run of selected) {
    const events = run.eventCursor.map(id => view.manifest!.outbox[id]);
    const counts = { pending: 0, unknown: 0, handedOff: 0 };
    for (const event of events) counts[event.status === "dispatching" ? "unknown" : event.status]++;
    const row = { runId: clip(run.id, 160), name: clip(run.name, 80), task: clip(run.task, options.runId ? 6000 : options.compact ? 160 : 240),
      sessionPath: clip(run.sessionFile, options.runId ? 1000 : 300),
      savedReconciliation: clip(run.reconciliation ?? `Not reconciled; saved phase=${run.phase}`, options.runId ? 300 : 100), delivery: counts };
    const line = JSON.stringify(row);
    if (!options.runId && Buffer.byteLength([...lines, line].join("\n")) > (options.compact ? 3800 : 23000)) break;
    lines.push(line);
    shown++;
    if (options.runId) {
      lines.push("Retained delivery evidence (first 10; content excerpts, not accepted results):");
      for (const id of run.eventCursor.slice(0, 10)) {
        const event = view.manifest.outbox[id];
        lines.push(JSON.stringify({ eventId: clip(id, 160), delivery: event.status === "dispatching" ? "unknown" : event.status,
          content: clip(typeof event.envelope.message.content === "string" ? event.envelope.message.content : JSON.stringify(event.envelope.message.content), 600) }));
      }
      if (run.eventCursor.length > 10) lines.push(`${run.eventCursor.length - 10} delivery events omitted; review retained artifacts in the saved session.`);
    }
  }
  lines[countLine] = `Recorded assignments: ${runs.length}; showing ${shown}; offset=${offset}.`;
  if (!options.runId && offset + shown < runs.length) lines.push(`More assignments: subagents_recovery({offset:${offset + shown},limit:${limit}}).`);
  return clip(lines.join("\n"), options.compact ? 4096 : 24000);
}

export function recoveryContext(view: RecoveryView): string | undefined {
  if (!view.error && !view.storageError && !view.paused && !view.diagnostics?.length && !view.dispatch?.length && !Object.keys(view.manifest?.runs ?? {}).length) return;
  return recoveryReport(view, { limit: 3, compact: true });
}

const noticeEntry = "pi-subagents-recovery-notice-ack/v1";

function unresolvedDispatchCount(view: RecoveryView): number {
  return (view.dispatch ?? []).filter(item => item.status !== "resolved").length;
}

function noticeFingerprint(view: RecoveryView): string | undefined {
  const saved = view.manifest;
  // Do not acknowledge a stale/unavailable view or a custody pause.
  if (view.error || view.storageError || view.paused || saved?.custodyPaused) return;
  const runIds = Object.keys(saved?.runs ?? {}).sort();
  if (!runIds.length && !unresolvedDispatchCount(view)) return;
  const parent = saved?.parent;
  const scope = parent ? [parent.sessionFile, parent.headerId, parent.branchToken, parent.checkpoint]
    : view.planNoticeScope && ["plan-only", ...view.planNoticeScope];
  if (!scope) return;
  const runs = runIds.map(id => {
    const run = saved!.runs[id];
    return [id, run.phase, run.reconciliation, [...run.eventCursor].sort().map(eventId => [eventId, saved!.outbox[eventId].status])];
  });
  // Revision/generation can advance on startup without changing saved evidence.
  // Retry counters and diagnostic timestamps are not changes of dispatch status.
  const incidents = (view.dispatch ?? []).map(item => JSON.stringify([item.runId, item.status, item.code, item.phase, item.evidence])).sort();
  return createHash("sha256").update(JSON.stringify([...scope, runs, incidents, [...(view.diagnostics ?? [])].sort()])).digest("hex");
}

function acknowledged(ctx: ExtensionContext, fingerprint: string): boolean {
  const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === noticeEntry);
  const data = entry?.type === "custom" ? entry.data : undefined;
  return !!data && typeof data === "object" && "fingerprint" in data && data.fingerprint === fingerprint;
}

export function notifyRecoveryOnStartup(ctx: ExtensionContext, view: RecoveryView): void {
  if (!ctx.hasUI) return;
  const count = Object.keys(view.manifest?.runs ?? {}).length;
  const unresolved = unresolvedDispatchCount(view);
  if (!count && !unresolved) return;
  const fingerprint = noticeFingerprint(view);
  if (fingerprint && acknowledged(ctx, fingerprint)) return;
  const assignments = count ? `Saved subagent assignments found (${count}). ` : "";
  const incidents = unresolved ? `Unresolved subagent dispatch incidents (${unresolved}). ` : "";
  ctx.ui.notify(`${assignments}${incidents}Review /subagents-recovery or subagents_recovery before explicit resume; saved evidence is not current liveness or acceptance.${fingerprint ? " After reviewing, use /subagents-recovery-ack to silence this notice until the saved state changes." : ""}`, "warning");
}

export function registerRecoveryReport(pi: ExtensionAPI, read: (ctx: ExtensionContext) => RecoveryView): void {
  pi.registerTool({
    name: "subagents_recovery", label: "Subagent recovery", description: "Read-only saved assignment recovery for the current parent branch. List with offset/limit (1..20), or runId detail. Output capped at 24KB; saved evidence is not current liveness or acceptance.",
    parameters: Type.Object({ runId: Type.Optional(Type.String({ maxLength: 160 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const view = read(ctx);
      return { content: [{ type: "text", text: recoveryReport(view, params) }], details: {}, isError: !!(view.error || view.storageError) };
    },
  });
  pi.registerCommand("subagents-recovery", {
    description: "Read-only saved assignments; optional runId for detail (no terminal control)",
    handler: async (args, ctx) => { ctx.ui.notify(recoveryReport(read(ctx), { runId: args.trim() || undefined }), "info"); },
  });
  pi.registerCommand("subagents-recovery-ack", {
    description: "Acknowledge the current startup recovery notice without accepting results or controlling children",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /subagents-recovery-ack (after reviewing /subagents-recovery).", "warning");
        return;
      }
      const fingerprint = noticeFingerprint(read(ctx));
      if (!fingerprint) {
        ctx.ui.notify("No verifiable saved assignment notice to acknowledge. See /subagents-recovery.", "warning");
        return;
      }
      try {
        if (!acknowledged(ctx, fingerprint)) pi.appendEntry(noticeEntry, { fingerprint });
      } catch {
        ctx.ui.notify("Could not save the recovery notice acknowledgement.", "warning");
        return;
      }
      ctx.ui.notify("Recovery notice acknowledged for this branch and saved state. Assignments, results and custody are unchanged.", "info");
    },
  });
  registerContextPublication(pi, { customType: RECOVERY_CONTEXT_TYPE, read: ctx => recoveryContext(read(ctx)),
    absent: "No saved assignment recovery state is currently available on this branch; previous recovery context no longer applies. This does not establish current liveness or acceptance.",
  });
}
