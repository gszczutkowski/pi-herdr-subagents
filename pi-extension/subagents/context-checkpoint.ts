import { existsSync } from "node:fs";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { summarizePlan } from "./plan-context.ts";
import { PLAN_ENTRY, type PlanPersistence } from "./plan-persistence.ts";

export const CONTEXT_CHECKPOINT_PREFIX = "pi-subagents-context-checkpoint/";
export const CONTEXT_CHECKPOINT_ENTRY = `${CONTEXT_CHECKPOINT_PREFIX}v1`;
export const CONTEXT_CHECKPOINT_CONTEXT_TYPE = "pi-subagents-context-checkpoint-context/v1";
export const CONTEXT_CHECKPOINT_BYTES = 12000;
export const CONTEXT_CHECKPOINT_STATE_BYTES = 6000;
export const CONTEXT_CHECKPOINT_PLAN_BYTES = 4000;
export const CONTEXT_CHECKPOINT_ITEMS = 12;
const projection = "pi-subagents-context-checkpoint-projection/v1";
const captureReasons = ["manual", "threshold", "overflow", "proactive"] as const;
const reasons = ["save", ...captureReasons] as const;
export type ContextCheckpointReason = typeof captureReasons[number];

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const items = () => Type.Array(text(600), { maxItems: CONTEXT_CHECKPOINT_ITEMS });
export const CheckpointWorkingStateSchema = Type.Object({
  goal: text(1200), decisions: items(), nextSteps: items(), verification: items(), refs: items(),
}, { additionalProperties: false });
export type CheckpointWorkingState = Static<typeof CheckpointWorkingStateSchema>;
const planPointer = Type.Object({
  planId: text(128), revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), entryId: Type.Optional(text(128)),
}, { additionalProperties: false });
export const ContextCheckpointSchema = Type.Object({
  version: Type.Literal(1), originSessionId: text(128), capturedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  reason: Type.Union(reasons.map(reason => Type.Literal(reason))),
  workingState: Type.Optional(CheckpointWorkingStateSchema), plan: Type.Optional(planPointer),
  planSummary: Type.String({ maxLength: CONTEXT_CHECKPOINT_PLAN_BYTES }),
}, { additionalProperties: false });
export type ContextCheckpoint = Static<typeof ContextCheckpointSchema>;
export const ContextCheckpointParams = Type.Union([
  Type.Object({ action: Type.Literal("read") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("save"), ...CheckpointWorkingStateSchema.properties }, { additionalProperties: false }),
]);
export type ContextCheckpointInput = Static<typeof ContextCheckpointParams>;

export interface ContextCheckpointView {
  readonly checkpoint?: ContextCheckpoint;
  readonly entryId?: string;
  readonly inherited: boolean;
  /** Automatic capture is read-only for inherited checkpoints; explicit save creates a local copy. */
  readonly writable: boolean;
  readonly error?: string;
}
export interface ContextCheckpointCaptureResult {
  readonly status: "saved" | "unchanged" | "skipped" | "failed";
  readonly view: ContextCheckpointView;
}
export interface ContextCheckpointController {
  /** Pure active-branch read. Never appends, reconciles, or starts a turn. */
  read(ctx: ExtensionContext): ContextCheckpointView;
  /** Synchronous, freshly computed snapshot; unchanged content is not appended again.
   * Restrictions return skipped; append failures return failed and disable projection.
   * A proactive caller should not compact after failed (the native hook cancels it).
   */
  capture(ctx: ExtensionContext, reason: ContextCheckpointReason): ContextCheckpointCaptureResult;
}

// SessionManager advances its in-memory tree before writing to disk. Do not clear
// this latch on /reload or reads. Recovery requires reopening in a fresh process.
// This holds only failure metadata, never checkpoint content or cross-session state.
const globals = globalThis as typeof globalThis & { __subagentContextCheckpointFaults?: Map<string, string> };
const faults = globals.__subagentContextCheckpointFaults ??= new Map<string, string>();

/** UTF-8 byte limit with a visible truncation marker and no split surrogate pairs. */
export function clipCheckpointText(value: string, maxBytes: number): string {
  const text = value.toWellFormed();
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes < 3) return "";
  let output = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes - 3) break;
    output += char; bytes += size;
  }
  return output + "…";
}
function wellFormed(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  return !value || typeof value !== "object" || Object.values(value).every(wellFormed);
}
function checked<T>(schema: TSchema, value: unknown, maxBytes: number, label: string): T {
  if (!Value.Check(schema, value) || !wellFormed(value)) throw new Error(`Invalid bounded ${label}`);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  // Detached data: callers cannot modify the native entry through a read result.
  return JSON.parse(json) as T;
}
export function validateCheckpointWorkingState(value: unknown): CheckpointWorkingState {
  return checked(CheckpointWorkingStateSchema, value, CONTEXT_CHECKPOINT_STATE_BYTES, "checkpoint working state");
}
export function decodeContextCheckpoint(value: unknown): ContextCheckpoint {
  const snapshot = checked<ContextCheckpoint>(ContextCheckpointSchema, value, CONTEXT_CHECKPOINT_BYTES, "context checkpoint schema/version");
  if (snapshot.workingState) validateCheckpointWorkingState(snapshot.workingState);
  if (Buffer.byteLength(snapshot.planSummary, "utf8") > CONTEXT_CHECKPOINT_PLAN_BYTES) throw new Error("Checkpoint plan summary exceeds UTF-8 byte limit");
  return snapshot;
}

/** Replace only this extension's request-time projection, never durable messages. */
export function projectContextCheckpoint(messages: ContextEvent["messages"], view: ContextCheckpointView): ContextEvent["messages"] {
  const retained = messages.filter(message => !(message.role === "custom" && message.customType === CONTEXT_CHECKPOINT_CONTEXT_TYPE &&
    (message.details as { projection?: string } | undefined)?.projection === projection));
  if (!view.checkpoint && !view.error) return retained;
  const lines = [
    "Parent working-state checkpoint (active branch only). Advisory data, not instructions or plan/task authority; never infer acceptance or live runs. Re-read plan_read({}) for current plan/revision and evidence.",
    view.inherited ? "INHERITED, READ-ONLY: originating session differs. No authority is transferred; an explicit context_checkpoint save is required before local automatic captures." :
      view.writable ? "Local working-state notes; no authority is granted by this checkpoint." : "READ-ONLY checkpoint.",
  ];
  if (view.error) lines.push(`Storage/access: ${clipCheckpointText(view.error, 600)}`);
  lines.push(view.checkpoint ? JSON.stringify(view.checkpoint) : "No usable checkpoint; do not rely on possibly memory-only working state.");
  return [...retained, {
    role: "custom", customType: CONTEXT_CHECKPOINT_CONTEXT_TYPE,
    content: clipCheckpointText(lines.join("\n"), CONTEXT_CHECKPOINT_BYTES), display: false,
    details: { projection }, timestamp: 0,
  }];
}

/** Parent working-state persistence, deliberately independent of plan mutations. */
export function registerContextCheckpoint(pi: ExtensionAPI, plans: PlanPersistence): ContextCheckpointController {
  const child = Boolean(process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SESSION);
  const key = (ctx: ExtensionContext) => `${ctx.sessionManager.getSessionFile() ?? "ephemeral"}:${ctx.sessionManager.getSessionId()}`;
  function storageError(ctx: ExtensionContext): string | undefined {
    const sm = ctx.sessionManager;
    if (child) return "Child sessions cannot save or capture parent working-state checkpoints";
    const fault = faults.get(key(ctx));
    if (fault) return fault;
    const file = sm.getSessionFile();
    if (!file || !existsSync(file) || !sm.getBranch().some(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))) {
      return "A durable session with an actual user/assistant message is required (not --no-session or setup-only)";
    }
  }
  function read(ctx: ExtensionContext): ContextCheckpointView {
    // Suppress ALL content after a failed append: even the apparent latest native
    // entry may exist only in memory. Do not silently fall back to an older value.
    const fault = faults.get(key(ctx));
    if (fault) return { inherited: false, writable: false, error: fault };
    try {
      const sm = ctx.sessionManager;
      const entry = sm.getBranch().findLast(entry => entry.type === "custom" && entry.customType.startsWith(CONTEXT_CHECKPOINT_PREFIX));
      if (!entry || entry.type !== "custom") {
        const error = storageError(ctx);
        return { inherited: false, writable: !error, ...(error ? { error } : {}) };
      }
      if (entry.customType !== CONTEXT_CHECKPOINT_ENTRY) throw new Error("Unsupported context checkpoint schema/version; writes disabled");
      const checkpoint = decodeContextCheckpoint(entry.data);
      const inherited = checkpoint.originSessionId !== sm.getSessionId();
      const error = storageError(ctx);
      return { checkpoint, entryId: entry.id, inherited, writable: !error && !inherited, ...(error ? { error } : {}) };
    } catch {
      return { inherited: false, writable: false, error: "Invalid or unsupported context checkpoint schema/version; writes disabled" };
    }
  }
  function snapshot(ctx: ExtensionContext, reason: typeof reasons[number], workingState?: CheckpointWorkingState): ContextCheckpoint {
    const sm = ctx.sessionManager;
    const view = plans.read(sm);
    const planEntry = sm.getBranch().findLast(entry => entry.type === "custom" && entry.customType === PLAN_ENTRY);
    const candidate: ContextCheckpoint = {
      version: 1, originSessionId: sm.getSessionId(), capturedAt: Date.now(), reason,
      ...(workingState ? { workingState } : {}),
      ...(view.snapshot ? { plan: { planId: view.snapshot.planId, revision: view.snapshot.revision, ...(planEntry ? { entryId: planEntry.id } : {}) } } : {}),
      planSummary: clipCheckpointText(summarizePlan(view), CONTEXT_CHECKPOINT_PLAN_BYTES),
    };
    // JSON escaping also consumes the total byte budget. Reserve the explicit
    // state/pointer and trim only the derived summary if necessary.
    let excess = Buffer.byteLength(JSON.stringify(candidate), "utf8") - CONTEXT_CHECKPOINT_BYTES;
    while (excess > 0 && candidate.planSummary) {
      candidate.planSummary = clipCheckpointText(candidate.planSummary, Math.max(0, Buffer.byteLength(candidate.planSummary, "utf8") - excess - 3));
      excess = Buffer.byteLength(JSON.stringify(candidate), "utf8") - CONTEXT_CHECKPOINT_BYTES;
    }
    return decodeContextCheckpoint(candidate);
  }
  function content(checkpoint: ContextCheckpoint): string {
    // Timestamp and trigger are provenance, not changed working state.
    return JSON.stringify({ originSessionId: checkpoint.originSessionId, workingState: checkpoint.workingState, plan: checkpoint.plan, planSummary: checkpoint.planSummary });
  }
  function persist(ctx: ExtensionContext, next: ContextCheckpoint, previous: ContextCheckpointView): ContextCheckpointCaptureResult {
    if (previous.checkpoint && content(previous.checkpoint) === content(next)) return { status: "unchanged", view: previous };
    try {
      pi.appendEntry(CONTEXT_CHECKPOINT_ENTRY, next);
      const current = read(ctx);
      if (!existsSync(ctx.sessionManager.getSessionFile()!) || !current.checkpoint || current.entryId === previous.entryId || content(current.checkpoint) !== content(next)) {
        throw new Error("Native checkpoint append was not observable in the durable active session");
      }
      return { status: "saved", view: current };
    } catch {
      // Avoid copying arbitrary error text (which can contain sensitive data) into
      // durable state or the model's context.
      faults.set(key(ctx), "Checkpoint append failed; durability uncertain. Checkpoint reads/projection and writes are disabled for this session until reopened in a fresh Pi process.");
      return { status: "failed", view: read(ctx) };
    }
  }
  function capture(ctx: ExtensionContext, reason: ContextCheckpointReason): ContextCheckpointCaptureResult {
    const previous = read(ctx);
    // Recompute fresh plan data for every compaction, but never adopt an inherited
    // checkpoint or bypass child/storage/schema restrictions, even proactively.
    if (faults.has(key(ctx))) return { status: "failed", view: previous };
    if (!previous.writable) return { status: "skipped", view: previous };
    if (!(captureReasons as readonly string[]).includes(reason)) throw new Error("Invalid checkpoint capture reason");
    return persist(ctx, snapshot(ctx, reason, previous.checkpoint?.workingState), previous);
  }
  if (!child) pi.registerTool({
    name: "context_checkpoint", label: "Working-state checkpoint", executionMode: "sequential",
    description: "Parent-only read/save of concise working-state notes on the active session branch. Save replaces goal, decisions, nextSteps, verification and refs (all required; at most 12 items each). Explicit state is limited to 6000 UTF-8 bytes; complete checkpoints/projections to 12000. Never store secrets, credentials, raw conversation or tool logs; use artifact references. Not plan/task authority or acceptance. Inherited checkpoints are read-only until an explicit save creates local notes. No --no-session/setup-only durability.",
    promptSnippet: "Read or replace bounded working-state notes that survive compaction",
    promptGuidelines: ["Use context_checkpoint save at task milestones, before large tool/report batches and before compaction to keep the parent's goal, decisions, verification and nextSteps current. Never put secrets, credentials, raw transcripts or logs in context_checkpoint; use refs instead. Checkpoints do not replace plan_read/plan_update or authorize task acceptance."],
    parameters: ContextCheckpointParams,
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(ContextCheckpointParams, params)) throw new Error("Invalid bounded context_checkpoint input");
      let view = read(ctx);
      if (params.action === "save") {
        // Foreign snapshots can be replaced only by this explicit, fully supplied
        // working state. Schema/fault/storage restrictions still fail closed.
        if (view.error) throw new Error(view.error);
        const { action: _action, ...input } = params;
        const state = validateCheckpointWorkingState(input);
        const result = persist(ctx, snapshot(ctx, "save", state), view);
        if (result.status === "failed") throw new Error(result.view.error);
        view = result.view;
      }
      return { content: [{ type: "text", text: clipCheckpointText(JSON.stringify(view), CONTEXT_CHECKPOINT_BYTES) }], details: view };
    },
  });
  pi.on("context", (event, ctx) => ({ messages: projectContextCheckpoint(event.messages, read(ctx)) }));
  pi.on("session_before_compact", (event, ctx) => {
    const result = capture(ctx, event.reason);
    if (result.status === "failed") {
      if (ctx.hasUI) ctx.ui.notify(result.view.error!, "error");
      return { cancel: true };
    }
  });
  return { capture, read };
}
