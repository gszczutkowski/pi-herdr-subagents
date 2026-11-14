import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function runCompletionFile(sessionFile: string, runId: string): string {
  return `${sessionFile}.${runId}.exit`;
}

export function writeRunCompletion(payload: object): void {
  const session = process.env.PI_SUBAGENT_SESSION;
  if (!session) return;
  const runId = process.env.PI_SUBAGENT_ID;
  const target = runId ? runCompletionFile(session, runId) : `${session}.exit`;
  // A tool result (especially ping/error) must not be replaced by auto-exit.
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...payload, ...(runId ? { runId } : {}) }));
    // Publish a complete file atomically without replacing earlier evidence.
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    rmSync(temporary, { force: true });
  }
}
