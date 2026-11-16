import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findLastAssistantMessage, type SessionEntry } from "./session.ts";
import { canonicalSessionPath } from "./ownership.ts";

let completionSequence = 0;
let turnEventId = randomUUID();
const published = new Set<string>();
type CompletionSession = Pick<ExtensionContext["sessionManager"], "getEntries" | "getBranch" | "getSessionFile" | "getHeader">;
interface SessionIdentity { sessionFile: string; headerId: string }
// Process-scoped, not branch state: /reload must retain the original task's
// identity, while /new, /resume and /fork remain unrestricted but detached.
const identityKey = Symbol.for("pi-subagents/completion-identities/v1");
const identities: Map<string, SessionIdentity> = (globalThis as any)[identityKey] ??= new Map();
let completionSessionFile: string | null | undefined;
let completionHeaderId: string | undefined;

export class CompletionSessionMismatch extends Error {
  constructor() { super("Completion session identity does not match the supervised task; this session is detached."); }
}

export function assertCompletionSession(context: CompletionSession, verifyDisk = true): SessionIdentity {
  const target = process.env.PI_SUBAGENT_SESSION;
  const current = context.getSessionFile();
  const headerId = context.getHeader?.()?.id;
  if (!target || !current || !headerId || canonicalSessionPath(current) !== canonicalSessionPath(target)) throw new CompletionSessionMismatch();
  const identity = { sessionFile: canonicalSessionPath(target), headerId };
  const key = `${process.env.PI_SUBAGENT_ID ?? "legacy"}:${identity.sessionFile}`;
  const bound = identities.get(key);
  if (bound && bound.headerId !== headerId) throw new CompletionSessionMismatch();
  // A new persistent SessionManager has not written its header yet. Once the
  // file exists, require BOTH the manager and disk header to match the binding.
  if (verifyDisk && existsSync(target)) {
    const header = JSON.parse(readFileSync(target, "utf8").split(/\r?\n/, 1)[0]);
    if (header.type !== "session" || header.id !== headerId) throw new CompletionSessionMismatch();
  }
  identities.set(key, identity);
  return identity;
}

export interface PreparedRunCompletion {
  readonly target: string;
  readonly serialized: string;
  readonly identity?: SessionIdentity;
}
let priorEntryIds = new Set<string>();

export function beginCompletionTurn(session?: CompletionSession): void {
  // Snapshot all existing IDs, not a physical JSONL offset or a branch leaf:
  // navigation during this run must not resurrect text from another task.
  completionSessionFile = session?.getSessionFile();
  completionHeaderId = session?.getHeader?.()?.id;
  priorEntryIds = new Set(session?.getEntries().map((entry) => entry.id));
  completionSequence++;
  turnEventId = `${Date.now()}-${String(completionSequence).padStart(8, "0")}-${randomUUID()}`;
}

export function runCompletionFile(sessionFile: string, runId: string): string {
  return `${sessionFile}.${runId}.exit`;
}

export function prepareRunCompletion(payload: object, context?: CompletionSession): PreparedRunCompletion | undefined {
  const session = process.env.PI_SUBAGENT_SESSION;
  if (!session) return;
  const identity = context ? assertCompletionSession(context, false) : undefined;
  if (context && (!completionSessionFile || canonicalSessionPath(completionSessionFile) !== identity!.sessionFile
      || completionHeaderId !== identity!.headerId)) throw new CompletionSessionMismatch();
  const runId = process.env.PI_SUBAGENT_ID;
  const eventId = turnEventId;
  const base = runId ? runCompletionFile(session, runId) : `${session}.exit`;
  const target = runId && completionSequence > 0 ? `${base}.events/${eventId}.json` : base;
  // Active branch at settlement, restricted to entries emitted since this task
  // started. Neither /tree nor a resumed history can resurrect an old summary.
  const entries = context?.getBranch().filter(entry => !priorEntryIds.has(entry.id)) ?? [];
  const summary = findLastAssistantMessage(entries as SessionEntry[])
    ?? "No assistant text was produced for this supervised task.";
  return { target, identity, serialized: JSON.stringify({ ...payload, ...(runId ? { runId, eventId, summary } : {}) }) };
}

/** Retry the exact settled bytes/target, never recompute from a later turn. */
export function publishRunCompletion(completion: PreparedRunCompletion, context?: CompletionSession): void {
  if (completion.identity) {
    if (!context) throw new CompletionSessionMismatch();
    const current = assertCompletionSession(context);
    if (current.headerId !== completion.identity.headerId || current.sessionFile !== completion.identity.sessionFile) throw new CompletionSessionMismatch();
  }
  const { target, serialized } = completion;
  if (published.has(target)) return;
  const verifyExisting = () => {
    if (readFileSync(target, "utf8") !== serialized) throw new Error(`Conflicting immutable completion: ${target}`);
  };
  if (existsSync(target)) { verifyExisting(); published.add(target); return; }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyExisting();
    }
    published.add(target);
  } finally {
    // Failure to clean a temporary file must not turn a successful immutable
    // publication into a false failure (or replace the original I/O error).
    try { rmSync(temporary, { force: true }); } catch { /* Harmless orphan temp. */ }
  }
}

export function writeRunCompletion(payload: object, context?: CompletionSession): void {
  const completion = prepareRunCompletion(payload, context);
  if (completion) {
    // Legacy/bootstrap callers retain first-publication-wins behavior.
    if (!context && (published.has(completion.target) || existsSync(completion.target))) return;
    publishRunCompletion(completion, context);
  }
}
