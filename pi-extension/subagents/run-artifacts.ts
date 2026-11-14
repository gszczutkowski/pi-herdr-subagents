import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";

let completionSequence = 0;
let turnEventId = randomUUID();
const published = new Set<string>();

export function beginCompletionTurn(): void {
  completionSequence++;
  turnEventId = `${Date.now()}-${String(completionSequence).padStart(8, "0")}-${randomUUID()}`;
}

export function runCompletionFile(sessionFile: string, runId: string): string {
  return `${sessionFile}.${runId}.exit`;
}

export function writeRunCompletion(payload: object): void {
  const session = process.env.PI_SUBAGENT_SESSION;
  if (!session) return;
  const runId = process.env.PI_SUBAGENT_ID;
  const eventId = turnEventId;
  const base = runId ? runCompletionFile(session, runId) : `${session}.exit`;
  const target = runId && completionSequence > 0 ? `${base}.events/${eventId}.json` : base;
  // A tool result (especially ping/error) must not be replaced by auto-exit.
  if (published.has(target) || existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...payload, ...(runId ? { runId, eventId, summary: existsSync(session) ? findLastAssistantMessage(getNewEntries(session, 0)) : undefined } : {}) }));
    // Publish a complete file atomically without replacing earlier evidence.
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    published.add(target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
