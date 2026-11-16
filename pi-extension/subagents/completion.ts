import { existsSync, readFileSync, readdirSync, rmSync, statSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import type { EventMembership } from "./runtime-store.ts";
import { normalizeStructuredResult, type StructuredResult } from "./contracts.ts";
import { runCompletionFile } from "./run-artifacts.ts";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

export interface CompletionResult {
  eventId?: string;
  summary?: string;
  structuredResult?: StructuredResult;
  resultDiagnostic?: string;
  reason: "done" | "ping" | "sentinel" | "error";
  exitCode: number;
  keepOpen?: boolean;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

export interface CompletionOptions {
  intervalMs: number;
  readTerminalTail: () => Promise<string>;
  inspectPane?: () => Promise<import("./lifecycle.ts").PaneInspection>;
  /** Bounded artifact grace after explicit pane disappearance. Default: 500ms. */
  paneDisappearanceGraceMs?: number;
  onPaneInspection?: (
    inspection: import("./lifecycle.ts").PaneInspection,
    observedAt: number,
  ) => void;
  sessionFile?: string;
  /** Absent only for explicitly legacy runtime entries. */
  runId?: string;
  sentinelFile?: string;
  /** Durable watchers retain immutable evidence and skip committed outbox IDs. */
  retainedEventIds?: () => RetainedEventCursor;
  retainedEventIndex?: RetainedCompletionIndex;
  onTick?: (elapsedSeconds: number) => void;
}

export function interpretExitSidecar(data: unknown): CompletionResult {
  const payload = data as {
    type?: unknown;
    keepOpen?: unknown;
    structuredResult?: unknown;
    resultDiagnostic?: unknown;
    name?: unknown;
    message?: unknown;
    errorMessage?: unknown;
  };

  if (payload?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: {
        name: typeof payload.name === "string" ? payload.name : "subagent",
        message: typeof payload.message === "string" ? payload.message : "",
      },
    };
  }

  if (payload?.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim()
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return {
      reason: "error", exitCode: 1, errorMessage,
      ...normalizeStructuredResult(payload.structuredResult),
      ...(typeof payload.resultDiagnostic === "string" ? { resultDiagnostic: payload.resultDiagnostic.slice(0, 8192) } : {}),
      ...(typeof payload.keepOpen === "boolean" ? { keepOpen: payload.keepOpen } : {}),
    };
  }

  if (payload?.type === "done") {
    return {
      reason: "done",
      exitCode: 0,
      ...normalizeStructuredResult(payload.structuredResult),
      ...(typeof payload.resultDiagnostic === "string" ? { resultDiagnostic: payload.resultDiagnostic.slice(0, 8192) } : {}),
      ...(typeof payload.keepOpen === "boolean" ? { keepOpen: payload.keepOpen } : {}),
    };
  }

  return {
    reason: "error",
    exitCode: 1,
    errorMessage: "Invalid subagent completion sidecar: unsupported payload type.",
  };
}

export type RetainedEventCursor = readonly string[] | EventMembership;
const eventKey = (runId: string, eventId?: string) => `subagent:${runId}:completion${eventId ? `:${eventId}` : ""}`;

/** Cache only validated identities/fingerprints, never discard immutable files.
 * Every poll still checks ctime/mtime/size/inode: directory mtime alone misses
 * in-place corruption, including a same-size edit with restored mtime. */
export class RetainedCompletionIndex {
  private readonly files = new Map<string, { stamp: string; hash: string; eventKey?: string }>();

  read(file: string, runId: string, committed: EventMembership): any | undefined {
    let stat: BigIntStats;
    try { stat = statSync(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const previous = this.files.get(file);
    if (previous?.stamp === stamp && (!previous.eventKey || committed.has(previous.eventKey))) return;
    const text = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(text).digest("hex");
    if (previous && previous.hash !== hash) throw new Error(`Immutable completion changed/corrupt: ${file}`);
    const payload = JSON.parse(text);
    if (typeof payload?.runId === "string" && payload.runId !== runId) {
      // Foreign evidence is retained but cannot cross run custody. Remember its
      // fingerprint so an empty poll neither rereads it nor hides later edits.
      this.files.set(file, { stamp, hash });
      return;
    }
    if (payload?.runId !== runId || (payload.eventId !== undefined && (typeof payload.eventId !== "string" || !payload.eventId))) {
      throw new Error(`Invalid run-bound retained completion: ${file}`);
    }
    const key = eventKey(runId, payload.eventId);
    this.files.set(file, { stamp, hash, eventKey: key });
    return committed.has(key) ? undefined : payload;
  }
}

// Compatibility callers need no new lifecycle API. Explicitly scoped indexes
// are preferred for watchers/recovery; bound the fallback's session retention.
const retainedIndexes = new Map<string, RetainedCompletionIndex>();
function retainedIndex(base: string): RetainedCompletionIndex {
  let index = retainedIndexes.get(base);
  if (!index) {
    index = new RetainedCompletionIndex();
    if (retainedIndexes.size >= 64) retainedIndexes.delete(retainedIndexes.keys().next().value!);
    retainedIndexes.set(base, index);
  }
  return index;
}
function completionPayload(payload: any): CompletionResult {
  return { ...interpretExitSidecar(payload), ...(typeof payload.eventId === "string" ? { eventId: payload.eventId } : {}),
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}) };
}
function consumeExitSidecar(sessionFile: string | undefined, runId?: string,
  retainedEventIds?: () => RetainedEventCursor, index?: RetainedCompletionIndex,
): CompletionResult | null {
  if (!sessionFile) return null;
  const base = runId ? runCompletionFile(sessionFile, runId) : `${sessionFile}.exit`;
  const events = `${base}.events`;
  if (runId && retainedEventIds) {
    const cursor = retainedEventIds();
    const committed: EventMembership = Array.isArray(cursor) ? new Set(cursor) : cursor as EventMembership;
    index ??= retainedIndex(base);
    let names: string[];
    try { names = readdirSync(events); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const payload = index.read(`${events}/${name}`, runId, committed);
      if (payload) return completionPayload(payload);
    }
    const payload = index.read(base, runId, committed);
    return payload ? completionPayload(payload) : null;
  }
  const next = runId && existsSync(events) ? readdirSync(events).filter(name => name.endsWith(".json")).sort()[0] : undefined;
  const exitFile = next ? `${events}/${next}` : base;
  if (!existsSync(exitFile)) return null;
  try {
    const payload = JSON.parse(readFileSync(exitFile, "utf8"));
    if (runId && payload.runId !== runId) return null;
    const result = completionPayload(payload);
    if (!retainedEventIds) rmSync(exitFile, { force: true });
    return result;
  } catch {
    // Legacy mutable sidecars may still be in flight. Retained immutable
    // evidence instead reports corruption/I/O to its supervisor above.
    return null;
  }
}

/** Artifact-only recovery must never inspect or control a stale terminal. */
export function readRetainedCompletion(sessionFile: string, runId: string, cursor: RetainedEventCursor,
  index?: RetainedCompletionIndex,
): CompletionResult | null {
  return consumeExitSidecar(sessionFile, runId, () => cursor, index);
}

function terminalExitCode(screen: string, runId?: string): number | null {
  if (!runId) {
    const match = screen.match(TERMINAL_SENTINEL);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  const prefix = `__SUBAGENT_DONE_${runId}_`;
  for (const line of screen.split(/\r?\n/).reverse()) {
    const text = line.trim();
    if (!text.startsWith(prefix)) continue;
    const match = text.slice(prefix.length).match(/^(\d+)__$/);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function completionArtifact(options: CompletionOptions): CompletionResult | null {
  const sidecar = consumeExitSidecar(options.sessionFile, options.runId, options.retainedEventIds, options.retainedEventIndex);
  if (sidecar) return sidecar;
  if (options.sentinelFile && existsSync(options.sentinelFile)) {
    return { reason: "sentinel", exitCode: 0 };
  }
  return null;
}

async function waitForDisappearanceArtifacts(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult | null> {
  const immediate = completionArtifact(options);
  if (immediate) return immediate;

  const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await abortableDelay(Math.min(25, remaining), signal);
    const result = completionArtifact(options);
    if (result) return result;
  }
  return null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORT_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCompletion(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const startedAt = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error(ABORT_MESSAGE);

    const sidecarResult = consumeExitSidecar(options.sessionFile, options.runId, options.retainedEventIds, options.retainedEventIndex);
    if (sidecarResult) return sidecarResult;

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const exitCode = terminalExitCode(await options.readTerminalTail(), options.runId);
      if (exitCode !== null) {
        // The terminal read is asynchronous. The child may publish its final
        // result (or provider failure/ping) while that read is in flight. Prefer
        // that richer evidence before falling back to the shell's exit code.
        const racedCompletion = consumeExitSidecar(options.sessionFile, options.runId, options.retainedEventIds, options.retainedEventIndex);
        if (racedCompletion) return racedCompletion;
        return { reason: "sentinel", exitCode };
      }
    } catch {
      // Terminal reads are only sentinel/output probes; Herdr status is polled
      // independently below, even when terminal reads succeed.
    }

    if (options.inspectPane) {
      let inspection: import("./lifecycle.ts").PaneInspection;
      try {
        inspection = await options.inspectPane();
      } catch {
        inspection = { kind: "unavailable", error: "inspectPane threw" };
      }
      const observedAt = Date.now();
      options.onPaneInspection?.(inspection, observedAt);
      if (inspection.kind === "missing") {
        // Pane closure and atomic artifact publication are separate operations.
        // Allow a short bounded grace window before declaring evidence lost.
        const racedCompletion = await waitForDisappearanceArtifacts(signal, options);
        if (racedCompletion) return racedCompletion;
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
        };
      }
    }

    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await abortableDelay(options.intervalMs, signal);
  }
}
