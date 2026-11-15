import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  retainedEventIds?: () => readonly string[];
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

function consumeExitSidecar(sessionFile: string | undefined, runId?: string, retainedEventIds?: () => readonly string[]): CompletionResult | null {
  if (!sessionFile) return null;

  const base = runId ? runCompletionFile(sessionFile, runId) : `${sessionFile}.exit`;
  const events = `${base}.events`;
  const committed = retainedEventIds?.();
  const next = runId && existsSync(events) ? readdirSync(events).filter((name) => {
    if (!name.endsWith(".json")) return false;
    if (!committed) return true;
    try {
      const payload = JSON.parse(readFileSync(`${events}/${name}`, "utf8"));
      return !committed.includes(`subagent:${runId}:completion:${payload.eventId}`);
    } catch { return true; }
  }).sort()[0] : undefined;
  const exitFile = next ? `${events}/${next}` : base;
  if (!existsSync(exitFile)) return null;

  try {
    const payload = JSON.parse(readFileSync(exitFile, "utf8"));
    if (runId && payload.runId !== runId) return null;
    if (committed?.includes(`subagent:${runId}:completion${payload.eventId ? `:${payload.eventId}` : ""}`)) return null;
    const result = interpretExitSidecar(payload);
    if (!retainedEventIds) rmSync(exitFile, { force: true });
    return { ...result, ...(typeof payload.eventId === "string" ? { eventId: payload.eventId } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}) };
  } catch {
    // The child may still be writing the file. Retry on the next polling cycle.
    return null;
  }
}

/** Artifact-only recovery must never inspect or control a stale terminal. */
export function readRetainedCompletion(sessionFile: string, runId: string, cursor: readonly string[]): CompletionResult | null {
  return consumeExitSidecar(sessionFile, runId, () => cursor);
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
  const sidecar = consumeExitSidecar(options.sessionFile, options.runId, options.retainedEventIds);
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

    const sidecarResult = consumeExitSidecar(options.sessionFile, options.runId, options.retainedEventIds);
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
        const racedCompletion = consumeExitSidecar(options.sessionFile, options.runId, options.retainedEventIds);
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
