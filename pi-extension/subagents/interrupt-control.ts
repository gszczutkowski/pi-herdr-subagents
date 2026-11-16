import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { canonicalSessionPath, type SessionOwner } from "./ownership.ts";
import { readChildIdentity } from "./recovery-identity.ts";
import { probeProcess, sameProcess } from "./process-identity.ts";
import { setTimeout as delay } from "node:timers/promises";

export const INTERRUPT_CAPABILITY = "interrupt-v1";
export const interruptDir = (activityFile: string) => `${activityFile}.interrupt`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Identity = NonNullable<ReturnType<typeof readChildIdentity>>;
interface Request extends Identity { capability: typeof INTERRUPT_CAPABILITY; activeToken: string; requestId: string }
function read(file: string): any { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } }
/** Requests, claims and acknowledgements are immutable, including across reload. */
function publish(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try { linkSync(temp, file); } finally { rmSync(temp, { force: true }); }
}
function matches(a: any, b: Identity): boolean {
  return !!a && a.schema === b.schema && a.runId === b.runId && a.sessionFile === b.sessionFile &&
    a.headerId === b.headerId && a.nonce === b.nonce && !!a.process && sameProcess(a.process, b.process);
}
function correlates(record: any, request: Request): boolean {
  return matches(record, request) && record.capability === INTERRUPT_CAPABILITY &&
    record.requestId === request.requestId && record.activeToken === request.activeToken;
}
function currentSession(ctx: ExtensionContext, identity: Identity): boolean {
  const file = ctx.sessionManager.getSessionFile();
  return !!file && canonicalSessionPath(file) === identity.sessionFile && ctx.sessionManager.getHeader()?.id === identity.headerId;
}

/** Child-only, non-model turn cancellation. No terminal, shutdown or signal API. */
export function registerInterruptControl(pi: ExtensionAPI, probe = probeProcess): void {
  const runId = process.env.PI_SUBAGENT_ID;
  const session = process.env.PI_SUBAGENT_SESSION;
  const activity = process.env.PI_SUBAGENT_ACTIVITY_FILE;
  if (!runId || !session || !activity) return;
  const dir = interruptDir(activity);
  let watcher: FSWatcher | undefined;
  let identity: Identity | undefined;
  let activeToken: string | undefined;
  let claimed: Request | undefined;
  const invalidate = () => {
    activeToken = undefined;
    try { rmSync(join(dir, "current.json"), { force: true }); } catch { /* In-memory token still fences stale proofs. */ }
  };
  const stop = () => {
    const previous = watcher;
    watcher = undefined;
    claimed = undefined;
    identity = undefined;
    invalidate();
    try { previous?.close(); } catch { /* Native callbacks must never escape cleanup. */ }
  };
  pi.on("session_start", (_event, ctx) => {
    stop(); // Startup/reload/session replacement never inherits an active token or claim.
    try {
      const own = probe(process.pid);
      const saved = readChildIdentity(session, runId);
      if (!saved || own.kind !== "present" || !sameProcess(saved.process, own.identity) ||
          !currentSession(ctx, saved) || typeof ctx.abort !== "function") return;
      identity = saved;
      mkdirSync(dir, { recursive: true });
      const receive = (name: string) => {
        if (!name.endsWith(".request.json")) return;
        const requestId = name.slice(0, -".request.json".length);
        if (!uuid.test(requestId) || !identity || !watcher) return;
        const claimFile = join(dir, `${requestId}.claim.json`), ackFile = join(dir, `${requestId}.ack.json`);
        if (existsSync(claimFile) || existsSync(ackFile)) return; // An ambiguous claim is NEVER replayed.
        const request = read(join(dir, name));
        const valid = matches(request, identity) && request.capability === INTERRUPT_CAPABILITY &&
          request.requestId === requestId && currentSession(ctx, identity);
        if (!valid || !activeToken || request.activeToken !== activeToken || ctx.isIdle() || typeof ctx.abort !== "function") {
          publish(ackFile, { ...identity, capability: INTERRUPT_CAPABILITY, requestId, activeToken: request?.activeToken,
            status: "rejected", dispatched: false, reason: valid ? "Child is idle or active proof expired" : "Wrong run/session/header/process identity" });
          return;
        }
        // All live checks, the durable claim, token consumption and public abort
        // execute in ONE synchronous callback. Never yield between them.
        publish(claimFile, { ...request, status: "claimed" });
        claimed = request;
        invalidate();
        ctx.abort();
        publish(ackFile, { ...request, status: "requested" }); // API return is not settlement proof.
      };
      watcher = watch(dir, (_event, filename) => {
        try { for (const name of filename ? [filename.toString()] : readdirSync(dir)) receive(name); }
        catch { stop(); } // I/O/API ambiguity fails closed; no replay, fallback or background rejection.
      });
      watcher.unref(); // SDK disposal need not emit session_shutdown.
      watcher.on("error", stop);
    } catch { stop(); }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    invalidate();
    claimed = undefined;
    try {
      if (!watcher || !identity || !currentSession(ctx, identity) || ctx.isIdle()) return;
      activeToken = randomUUID();
      const file = `${activeToken}.active.json`;
      publish(join(dir, file), { ...identity, capability: INTERRUPT_CAPABILITY, activeToken, state: "active" });
      const temp = join(dir, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify({ file }), { mode: 0o600, flag: "wx" });
        renameSync(temp, join(dir, "current.json"));
      } finally { rmSync(temp, { force: true }); }
    } catch { stop(); }
  });
  // agent_end is NOT settlement: retries and queued continuations retain the
  // same active token. Only final settlement can confirm this exact abort.
  pi.on("agent_settled", (event, ctx) => {
    const request = claimed;
    claimed = undefined;
    invalidate();
    try {
      if (request && watcher && identity && currentSession(ctx, identity) && ctx.isIdle() && event.aborted) {
        publish(join(dir, `${request.requestId}.settled.json`), { ...request, status: "aborted" });
      }
    } catch { stop(); }
  });
  pi.on("session_shutdown", stop);
}

interface InterruptChild { id: string; cli?: string; sessionFile: string; activityFile?: string }
export interface InterruptResult {
  status: "requested" | "pending" | "rejected";
  requestId: string;
  settlement: "aborted" | "unconfirmed";
  reason?: string;
}
interface InterruptTransport { validate: () => void; timeoutMs?: number; signal?: AbortSignal }

/** Publish once per child-issued active token. Rechecks never republish, and a
 * timeout never implies cancellation, confirmation, or permission to retry. */
export async function interruptOwnedChild(owner: SessionOwner, child: InterruptChild, transport: InterruptTransport): Promise<InterruptResult> {
  const validate = () => { transport.signal?.throwIfAborted(); transport.validate(); };
  validate();
  if (owner.runId !== child.id || !owner.dispatched || child.cli !== "pi" || !child.activityFile) {
    throw new Error("Only tracked owned Pi children support guarded interrupt; legacy/untracked children require manual handling.");
  }
  if (owner.closeRequestId || owner.continuationRequestId) throw new Error("Close/continuation is pending; interrupt would race another control request.");
  const identity = readChildIdentity(child.sessionFile, child.id);
  if (!identity) throw new Error("Child lacks verified INTERRUPT identity/support; no terminal or signal fallback was attempted.");
  const dir = interruptDir(child.activityFile);
  const pointer = read(join(dir, "current.json"));
  if (typeof pointer?.file !== "string" || !/^[0-9a-f-]{36}\.active\.json$/.test(pointer.file)) {
    throw new Error("Child has no fresh active INTERRUPT capability (idle, legacy or unsupported); no fallback was attempted.");
  }
  const state = read(join(dir, pointer.file));
  if (!matches(state, identity) || state.capability !== INTERRUPT_CAPABILITY || state.state !== "active" || !uuid.test(state.activeToken) ||
      pointer.file !== `${state.activeToken}.active.json`) throw new Error("Child INTERRUPT identity/active proof is invalid.");
  const intentFile = join(dir, `${state.activeToken}.intent.json`);
  let request: Request = read(intentFile);
  if (!request) {
    request = { ...identity, capability: INTERRUPT_CAPABILITY, activeToken: state.activeToken, requestId: randomUUID() };
    validate(); // Last binding/custody fence before any request becomes observable; no awaits above.
    let created = false;
    try { publish(intentFile, request); created = true; }
    catch (error) {
      // A concurrent explicit call can inspect the winner, never dispatch it.
      const existing = read(intentFile);
      if (!matches(existing, identity) || existing.capability !== INTERRUPT_CAPABILITY ||
          existing.activeToken !== state.activeToken || !uuid.test(existing.requestId)) throw error;
      request = existing;
    }
    // An existing reservation (even without a request after a crash) is NOT retry permission.
    if (created) {
      // Only this invocation's newly-created reservation may publish.
      // Identity is checked again in the child immediately before claiming.
      validate();
      publish(join(dir, `${request.requestId}.request.json`), request);
    }
  }
  if (!matches(request, identity) || request.capability !== INTERRUPT_CAPABILITY ||
      request.activeToken !== state.activeToken || !uuid.test(request.requestId)) throw new Error("Interrupt intent belongs to a different run/active token; no retry attempted.");
  const deadline = Date.now() + (transport.timeoutMs ?? 3000);
  for (;;) {
    validate(); // Including after EVERY acknowledgement wait, even on timeout.
    const ack = read(join(dir, `${request.requestId}.ack.json`));
    const claim = read(join(dir, `${request.requestId}.claim.json`));
    if (correlates(ack, request)) {
      if (ack.status === "rejected" && ack.dispatched === false && !existsSync(join(dir, `${request.requestId}.claim.json`))) {
        return { requestId: request.requestId, status: "rejected", settlement: "unconfirmed",
          reason: typeof ack.reason === "string" ? ack.reason.slice(0, 256) : "Child rejected interrupt." };
      }
      if (ack.status === "requested" && correlates(claim, request) && claim.status === "claimed") {
        const settled = read(join(dir, `${request.requestId}.settled.json`));
        return { requestId: request.requestId, status: "requested",
          settlement: correlates(settled, request) && settled.status === "aborted" ? "aborted" : "unconfirmed" };
      }
    }
    if (Date.now() >= deadline) break;
    await delay(25, undefined, { ref: false, signal: transport.signal });
  }
  return { requestId: request.requestId, status: "pending", settlement: "unconfirmed",
    reason: "Interrupt acknowledgement timed out/uncertain; process and watcher retained. Do not retry or use terminal/signal fallback." };
}
