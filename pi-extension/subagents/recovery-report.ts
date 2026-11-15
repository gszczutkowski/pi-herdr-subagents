import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { RuntimeManifest } from "./runtime-store.ts";

export interface RecoveryView { manifest?: RuntimeManifest; error?: string; paused?: string; diagnostics?: string[] }
export const RECOVERY_CONTEXT_TYPE = "pi-subagents-recovery-context/v1";
const guidance = "Saved reconciliation is NOT current liveness. Delivery pending/unknown/handedOff is NOT task acceptance. Review retained results and original assignment before deciding; audit the session and process before explicit subagent_resume. Never automatically relaunch, resume, close, or infer acceptance. Resume the original parent session/branch; use subagents_recovery or /subagents-recovery for details.";

function clip(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  return buffer.subarray(0, bytes - 16).toString("utf8") + "… [truncated]";
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
  for (const diagnostic of (view.diagnostics ?? []).slice(0, 5)) lines.push(`Diagnostic: ${clip(diagnostic, 300)}`);
  if ((view.diagnostics?.length ?? 0) > 5) lines.push("Additional diagnostics omitted.");
  if (!view.manifest) return [...lines, "No durable manifest for this parent. Legacy/missing records cannot establish that no unfinished work exists."].join("\n");
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

export function projectRecoveryContext(messages: ContextEvent["messages"], view: RecoveryView): ContextEvent["messages"] {
  const retained = messages.filter(message => !(message.role === "custom" && message.customType === RECOVERY_CONTEXT_TYPE &&
    (message.details as { projection?: string } | undefined)?.projection === RECOVERY_CONTEXT_TYPE));
  if (!view.error && !view.paused && !Object.keys(view.manifest?.runs ?? {}).length) return retained;
  return [...retained, { role: "custom", customType: RECOVERY_CONTEXT_TYPE, content: recoveryReport(view, { limit: 3, compact: true }),
    display: false, details: { projection: RECOVERY_CONTEXT_TYPE }, timestamp: 0 }];
}

export function registerRecoveryReport(pi: ExtensionAPI, read: (ctx: ExtensionContext) => RecoveryView): void {
  pi.registerTool({
    name: "subagents_recovery", label: "Subagent recovery", description: "Read-only saved assignment recovery for the current parent branch. List with offset/limit (1..20), or runId detail. Output capped at 24KB; saved evidence is not current liveness or acceptance.",
    parameters: Type.Object({ runId: Type.Optional(Type.String({ maxLength: 160 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const view = read(ctx);
      return { content: [{ type: "text", text: recoveryReport(view, params) }], details: {}, isError: !!view.error };
    },
  });
  pi.registerCommand("subagents-recovery", {
    description: "Read-only saved assignments; optional runId for detail (no terminal control)",
    handler: async (args, ctx) => { ctx.ui.notify(recoveryReport(read(ctx), { runId: args.trim() || undefined }), "info"); },
  });
  pi.on("context", (event, ctx) => ({ messages: projectRecoveryContext(event.messages, read(ctx)) }));
}
