import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { globalStateSlot } from "./global-state.ts";

export interface SessionOwner {
  runId: string;
  surface?: string;
  dispatched: boolean;
  continuationRequestId?: string;
  closeRequestId?: string;
}

// Deliberately scoped to this parent process, not a cross-process file lock.
// Symbol.for preserves reservations even while extension modules reload.
export const sessionOwners = globalStateSlot<Map<string, SessionOwner>>("pi-subagents/session-owners/v1").value ??= new Map();

export function canonicalSessionPath(path: string, cwd = process.cwd()): string {
  let ancestor = resolve(cwd, path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonical = join(realpathSync.native(ancestor), ...suffix);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function reserveSession(path: string, runId: string): SessionOwner {
  const key = canonicalSessionPath(path);
  const previous = sessionOwners.get(key);
  if (previous) throw new Error(`Session already owned by run ${previous.runId}; interrupt/continue that child or close its process before resuming.`);
  const owner = { runId, dispatched: false };
  sessionOwners.set(key, owner);
  return owner;
}

export function releaseSession(path: string, runId: string): void {
  const key = canonicalSessionPath(path);
  if (sessionOwners.get(key)?.runId === runId) sessionOwners.delete(key);
}
