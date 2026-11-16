import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { canonicalSessionPath, type SessionOwner } from "./ownership.ts";
import { readChildIdentity } from "./recovery-identity.ts";
import { reconcileContinuation } from "./live-continuation.ts";
import { auditSession, assertSessionWriters, type SessionAudit } from "./session-audit.ts";
import { isProtectedProcess, probeProcess, sameProcess, type ProcessIdentity, type ProcessProbe } from "./process-identity.ts";

export const CLOSE_CAPABILITY = "close-v1";
export const closeDir = (activityFile: string) => `${activityFile}.close`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function read(file: string): any { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } }
/** Immutable publication. Claims and acknowledgements must survive reload/replay. */
function publish(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try { linkSync(temp, file); } finally { rmSync(temp, { force: true }); }
}
function matches(a: any, b: any): boolean {
  return !!a && !!b && a.schema === b.schema && a.headerId === b.headerId &&
    a.runId === b.runId && a.sessionFile === b.sessionFile && a.nonce === b.nonce &&
    !!a.process && !!b.process && sameProcess(a.process, b.process);
}

/** Only the TUI has a synchronous live editor getter. RPC UI getters return
 * defaults, so they cannot prove that a client's editor is safe to discard. */
function editorSafe(ctx: ExtensionContext): boolean {
  if (!ctx.hasUI) return true;
  try { return ctx.mode === "tui" && typeof ctx.ui.getEditorText === "function" && ctx.ui.getEditorText() === ""; }
  catch { return false; }
}

/** A distinct non-model CLOSE capability. Never terminal input, Escape, or force kill. */
export function registerCloseControl(pi: ExtensionAPI): void {
  const runId = process.env.PI_SUBAGENT_ID;
  const session = process.env.PI_SUBAGENT_SESSION;
  const activity = process.env.PI_SUBAGENT_ACTIVITY_FILE;
  if (!runId || !session || !activity) return;
  const dir = closeDir(activity);
  let watcher: FSWatcher | undefined;
  let identity: ReturnType<typeof readChildIdentity>;
  let idleToken: string | undefined;
  const stop = () => { watcher?.close(); watcher = undefined; idleToken = undefined; };
  const busy = () => {
    idleToken = undefined;
    try { rmSync(join(dir, "current.json"), { force: true }); } catch { /* Child-side checks still reject stale proofs. */ }
  };
  pi.on("session_start", (_event, ctx) => {
    stop();
    busy();
    identity = readChildIdentity(session, runId);
    const own = probeProcess(process.pid);
    if (!identity || own.kind !== "present" || !sameProcess(identity.process, own.identity)) return;
    mkdirSync(dir, { recursive: true });
    const receive = (name: string) => {
      if (!name.endsWith(".request.json")) return;
      const requestId = name.slice(0, -".request.json".length);
      if (!uuid.test(requestId)) return;
      const claim = join(dir, `${requestId}.claim.json`), ack = join(dir, `${requestId}.ack.json`);
      if (existsSync(claim) || existsSync(ack)) return;
      const request = read(join(dir, name));
      const valid = request?.capability === CLOSE_CAPABILITY && request.requestId === requestId && matches(request, identity) &&
        canonicalSessionPath(ctx.sessionManager.getSessionFile() ?? "") === identity!.sessionFile &&
        ctx.sessionManager.getHeader()?.id === identity!.headerId;
      if (!valid || !idleToken || request.idleToken !== idleToken || !ctx.isIdle() || ctx.hasPendingMessages() || !editorSafe(ctx)) {
        publish(ack, { ...identity, capability: CLOSE_CAPABILITY, idleToken: request?.idleToken,
          runId, requestId, status: "rejected", dispatched: false, reason: valid ? "Child is busy, has a draft/unverifiable editor, or idle proof expired" : "Wrong run/session/process identity" });
        return;
      }
      publish(claim, { runId, requestId, status: "requested" });
      busy();
      publish(ack, { ...identity, requestId, status: "requested" });
      ctx.shutdown(); // Graceful and deferred by Pi; acknowledgement is NOT exit proof.
    };
    watcher = watch(dir, (_event, filename) => {
      try { for (const name of filename ? [filename.toString()] : readdirSync(dir)) receive(name); }
      catch { stop(); } // Claimed/ambiguous requests never replay, and never reject in the background.
    });
    // SDK AgentSession.dispose() does not emit session_shutdown. This control
    // must never keep an otherwise disposed/finished host alive.
    watcher.unref();
    watcher.on("error", stop);
  });
  pi.on("before_agent_start", busy);
  pi.on("agent_start", busy);
  pi.on("agent_settled", (_event, ctx) => {
    busy();
    if (!watcher || !identity || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    idleToken = randomUUID();
    // State is per-settlement immutable; a small pointer chooses the newest proof.
    const file = `${idleToken}.idle.json`;
    try {
      publish(join(dir, file), { ...identity, capability: CLOSE_CAPABILITY, idleToken });
      writeFileSync(join(dir, "current.json"), JSON.stringify({ file }), { mode: 0o600 });
    } catch { busy(); }
  });
  pi.on("session_shutdown", stop);
}

interface CloseChild { id: string; cli?: string; sessionFile: string; activityFile?: string }
export interface CloseResult {
  status: "closed" | "pending" | "uncertain" | "rejected";
  requestId?: string; process: ProcessIdentity; remainingOwners?: number; reason?: string;
}
interface CloseTransport {
  validate: () => void;
  /** Binding/lease fences still apply, but normal watcher cleanup may have
   * removed the original owner only AFTER verified original process death. */
  validateClosed?: (original: ProcessIdentity) => void;
  timeoutMs?: number;
  continuationSettled?: (requestId: string) => void;
  audit?: (path: string) => SessionAudit;
  probe?: (pid: number) => ProcessProbe;
  protected?: (pid: number) => boolean | undefined;
}

/** Reentrant/reload-safe status check. Only original PID+birth absence proves closure.
 * No signal or terminal API exists on this path. Ownership is released only by the caller after proof. */
export async function closeOwnedChild(owner: SessionOwner, child: CloseChild, transport: CloseTransport): Promise<CloseResult> {
  transport.validate();
  if (owner.runId !== child.id || child.cli !== "pi" || !child.activityFile) throw new Error("Only tracked owned Pi children support close; legacy/untracked processes require manual cleanup.");
  reconcileContinuation(owner, child, transport.continuationSettled);
  if (owner.continuationRequestId) throw new Error("Continuation is pending; closing would race active work.");
  const identity = readChildIdentity(child.sessionFile, child.id);
  if (!identity) throw new Error("Child lacks verified process identity/CLOSE support. Reload/update the child and finish a turn, or close it manually.");
  const probe = transport.probe ?? probeProcess;
  const audit = transport.audit ?? auditSession;
  const protectedProcess = (transport.protected ?? isProtectedProcess)(identity.process.pid);
  if (protectedProcess !== false) throw new Error("Refusing self/ancestor close, or ancestry is unverified.");
  const dir = closeDir(child.activityFile);
  let intent = read(join(dir, "intent.json"));
  if (intent && (!matches(intent, identity) || !uuid.test(intent.requestId))) throw new Error("Close intent belongs to a different run/process instance; manual inspection required.");
  const gone = (): boolean | undefined => {
    const current = probe(identity.process.pid);
    if (current.kind === "unverified") return undefined;
    return current.kind === "absent" || !sameProcess(identity.process, current.identity);
  };
  const closed = async (): Promise<CloseResult> => {
    const remaining = audit(child.sessionFile);
    // Both the death probe and owner audit block on Windows. Yield AFTER those
    // OS reads so supervision can consume pending I/O before final validation;
    // correctness must not depend on starving the normal cleanup callbacks.
    await new Promise(resolve => setTimeout(resolve, 50));
    if (transport.validateClosed) transport.validateClosed(identity.process);
    else transport.validate();
    return { status: "closed", requestId: intent?.requestId, process: identity.process, remainingOwners: remaining.ownerCount,
      reason: remaining.ownerCount || remaining.uncertainCount ? "Original owned process exited; session still has other or unverified possible writers." : "Original owned process exited; no other CLI owners observed." };
  };
  if (gone() === true) return closed();
  if (!intent) {
    assertSessionWriters(audit(child.sessionFile), identity.process);
    const pointer = read(join(dir, "current.json"));
    if (typeof pointer?.file !== "string" || !/^[0-9a-f-]{36}\.idle\.json$/.test(pointer.file)) throw new Error("Child has no fresh idle CLOSE capability; busy/legacy/unknown children cannot be closed automatically.");
    const state = read(join(dir, pointer.file));
    if (!matches(state, identity) || state.capability !== CLOSE_CAPABILITY || !uuid.test(state.idleToken)) throw new Error("Child CLOSE identity/idle proof is invalid.");
    transport.validate();
    // Revalidate immediately before making a shutdown request observable.
    if (gone() !== false) throw new Error("Child process identity became absent/unverified before close request.");
    assertSessionWriters(audit(child.sessionFile), identity.process);
    intent = { ...identity, capability: CLOSE_CAPABILITY, requestId: randomUUID(), idleToken: state.idleToken };
    try { publish(join(dir, "intent.json"), intent); }
    catch (error) {
      const existing = read(join(dir, "intent.json"));
      if (!matches(existing, identity) || !uuid.test(existing?.requestId)) throw error;
      intent = existing;
    }
  }
  owner.closeRequestId = intent.requestId;
  transport.validate();
  const requestFile = join(dir, `${intent.requestId}.request.json`);
  if (!existsSync(requestFile)) {
    assertSessionWriters(audit(child.sessionFile), identity.process);
    // No await since ancestry validation. A fresh birth probe prevents dispatch
    // to a replacement PID without repeating expensive OS ancestry enumeration.
    if (gone() !== false) throw new Error("Process identity changed before close publication.");
    transport.validate();
    publish(requestFile, intent);
  }
  const deadline = Date.now() + (transport.timeoutMs ?? 3000);
  do {
    // Normal supervision can remove the maps before our OS wait completes.
    // Only proven original-process death can enter the closure validation phase.
    const absent = gone();
    if (absent === true) return closed();
    transport.validate(); // Live/unknown process still requires exact ownership.
    const ack = read(join(dir, `${intent.requestId}.ack.json`));
    if (ack?.requestId === intent.requestId && matches(ack, identity) && ack.capability === CLOSE_CAPABILITY &&
        ack.idleToken === intent.idleToken && ack.status === "rejected" && ack.dispatched === false &&
        !existsSync(join(dir, `${intent.requestId}.claim.json`))) {
      // Only a run/process/token-bound definite NON-dispatch releases this
      // request reservation. Keep immutable requests/acks as replay history.
      const current = read(join(dir, "intent.json"));
      if (matches(current, identity) && current.requestId === intent.requestId && current.idleToken === intent.idleToken) {
        rmSync(join(dir, "intent.json"));
      }
      if (owner.closeRequestId === intent.requestId) delete owner.closeRequestId;
      return { status: "rejected", requestId: intent.requestId, process: identity.process, reason: typeof ack.reason === "string" ? ack.reason.slice(0, 256) : "Child rejected shutdown." };
    }
    if (absent === undefined) return { status: "uncertain", requestId: intent.requestId, process: identity.process, reason: "Process probe unavailable; ownership retained." };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() <= deadline);
  if (gone() === true) return closed();
  transport.validate();
  return { status: "pending", requestId: intent.requestId, process: identity.process, reason: "Shutdown requested, but OS process exit not verified; ownership retained. Recheck with the same owned id, not a replacement launch." };
}
