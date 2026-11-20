import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linkSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalSessionPath } from "./ownership.ts";
import { runCompletionFile } from "./run-artifacts.ts";
import { atomicRuntimeWrite } from "./runtime-store.ts";
import { globalStateSlot } from "./global-state.ts";
import { probeProcess, sameProcess, type ProcessIdentity } from "./process-identity.ts";

interface ChildIdentity {
  schema: 1;
  runId: string;
  sessionFile: string;
  headerId: string;
  nonce: string;
  process: ProcessIdentity;
}
interface Challenge extends ChildIdentity { challenge: string; generation: string }
function read(file: string): any { return JSON.parse(readFileSync(file, "utf8")); }
function matches(a: ChildIdentity, b: ChildIdentity): boolean {
  return a.schema === 1 && b.schema === 1 && a.runId === b.runId && a.sessionFile === b.sessionFile &&
    a.headerId === b.headerId && a.nonce === b.nonce && sameProcess(a.process, b.process);
}

/** Non-model responder. A fresh generation-bound challenge authenticates this
 * process under same-user filesystem trust, NOT against a malicious local user.
 * It deliberately makes no claim that an old terminal locator still targets it. */
export function registerRecoveryIdentity(pi: ExtensionAPI): void {
  const runId = process.env.PI_SUBAGENT_ID;
  const session = process.env.PI_SUBAGENT_SESSION;
  if (!runId || !session) return;
  const nonce = globalStateSlot<string>("pi-subagents/process-nonce/v1").value ??= randomUUID();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  pi.on("session_start", (_event, ctx) => {
    stop();
    const header = ctx.sessionManager.getHeader?.();
    const file = ctx.sessionManager.getSessionFile();
    const processProbe = probeProcess(process.pid);
    if (!header?.id || !file || canonicalSessionPath(file) !== canonicalSessionPath(session) || processProbe.kind !== "present") return;
    const identity: ChildIdentity = { schema: 1, runId, sessionFile: canonicalSessionPath(file), headerId: header.id,
      nonce, process: processProbe.identity };
    const base = runCompletionFile(identity.sessionFile, runId);
    // First process wins this run's immutable identity. A later process with
    // copied environment must not replace the old nonce/birth and claim adoption.
    const publication = `${base}.identity.${randomUUID()}.tmp`;
    atomicRuntimeWrite(publication, identity);
    try { linkSync(publication, `${base}.identity.json`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !matches(identity, read(`${base}.identity.json`))) return;
    } finally { rmSync(publication, { force: true }); }
    let answered = "";
    timer = setInterval(() => {
      try {
        const challenge: Challenge = read(`${base}.challenge.json`);
        if (!matches(identity, challenge) || typeof challenge.challenge !== "string" || typeof challenge.generation !== "string") return;
        const key = `${challenge.generation}:${challenge.challenge}`;
        if (key === answered) return;
        // Do not answer after /tree/session replacement changed the child session.
        if (ctx.sessionManager.getHeader()?.id !== identity.headerId || canonicalSessionPath(ctx.sessionManager.getSessionFile()!) !== identity.sessionFile) return;
        atomicRuntimeWrite(`${base}.response.json`, challenge);
        answered = key;
      } catch { /* No valid challenge yet, or unavailable storage/context. */ }
    }, 100);
    timer.unref?.();
  });
  pi.on("session_shutdown", stop);
}

export function readChildIdentity(sessionFile: string, runId: string): ChildIdentity | undefined {
  try {
    const identity: ChildIdentity = read(`${runCompletionFile(sessionFile, runId)}.identity.json`);
    const header = JSON.parse(readFileSync(sessionFile, "utf8").split(/\r?\n/)[0]);
    if (identity.schema !== 1 || identity.runId !== runId || identity.sessionFile !== canonicalSessionPath(sessionFile) ||
        header.type !== "session" || header.id !== identity.headerId || !identity.nonce ||
        !Number.isSafeInteger(identity.process?.pid) || !identity.process.birth) return undefined;
    return identity;
  } catch { return undefined; }
}

export type ChildVerification = "verified-live" | "exited" | "unverified";
export async function verifyRecoveryChild(
  sessionFile: string, runId: string, generation: string, stillCurrent: () => boolean,
  timeoutMs = 1500,
): Promise<ChildVerification> {
  try {
    const base = runCompletionFile(sessionFile, runId);
    const identity: ChildIdentity = read(`${base}.identity.json`);
    if (identity.schema !== 1 || identity.runId !== runId || identity.sessionFile !== canonicalSessionPath(sessionFile) ||
        typeof identity.nonce !== "string" || !identity.nonce || typeof identity.headerId !== "string" || !identity.process?.birth) return "unverified";
    const header = JSON.parse(readFileSync(sessionFile, "utf8").split(/\r?\n/)[0]);
    if (header.type !== "session" || header.id !== identity.headerId) return "unverified";
    const probe = probeProcess(identity.process.pid);
    if (probe.kind === "absent" || (probe.kind === "present" && !sameProcess(identity.process, probe.identity))) return "exited";
    if (probe.kind !== "present" || !stillCurrent()) return "unverified";
    const challenge: Challenge = { ...identity, challenge: randomUUID(), generation };
    atomicRuntimeWrite(`${base}.challenge.json`, challenge);
    const deadline = Date.now() + timeoutMs;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!stillCurrent()) return "unverified";
      try {
        const response: Challenge = read(`${base}.response.json`);
        if (matches(identity, response) && response.generation === generation && response.challenge === challenge.challenge) {
          const fresh = probeProcess(identity.process.pid);
          return fresh.kind === "present" && sameProcess(identity.process, fresh.identity) ? "verified-live" : "unverified";
        }
      } catch { /* Stale/absent response is not proof. */ }
    } while (Date.now() < deadline);
  } catch { /* Legacy/foreign/unsupported children require an explicit decision. */ }
  return "unverified";
}
