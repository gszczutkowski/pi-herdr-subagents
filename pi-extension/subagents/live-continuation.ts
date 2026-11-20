import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { canonicalSessionPath, type SessionOwner } from "./ownership.ts";
import type { SubagentLifecycle, PaneInspection } from "./lifecycle.ts";

export const CONTINUE_COMMAND = "_subagent_continue";
export const CONTINUATION_TRANSPORT = "artifact-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const continuationDir = (activityFile: string) => `${activityFile}.continuation`;
function read(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}
function publish(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

/** The terminal receives only this fixed command and a UUID, never user text or a file reference. */
export function continuationCommand(requestId: string): string {
  if (!uuid.test(requestId)) throw new Error("Invalid continuation request ID");
  return `/${CONTINUE_COMMAND} ${requestId}`;
}

export function registerLiveContinuation(pi: ExtensionAPI): void {
  const runId = process.env.PI_SUBAGENT_ID;
  const session = process.env.PI_SUBAGENT_SESSION;
  const activity = process.env.PI_SUBAGENT_ACTIVITY_FILE;
  if (!runId || !session || !activity) return;
  const sessionFile = canonicalSessionPath(session);
  const dir = continuationDir(activity);
  let watcher: FSWatcher | undefined;
  let idleToken: string | undefined;
  const busy = () => {
    idleToken = undefined;
    mkdirSync(dir, { recursive: true });
    publish(join(dir, "state.json"), { runId, sessionFile, transport: watcher ? CONTINUATION_TRANSPORT : undefined, state: "busy" });
  };
  const stopWatcher = () => {
    const previous = watcher;
    watcher = undefined;
    idleToken = undefined;
    try { previous?.close(); } catch { /* Cleanup must not depend on storage or diagnostics. */ }
  };
  const pause = (error: unknown, ctx: ExtensionContext) => {
    stopWatcher();
    const diagnostic = `Continuation paused/uncertain: ${String(error)}. Reload to restore transport; claimed requests must not be replayed.`;
    // Native fs callbacks are outside Pi's protected event dispatcher. Even the
    // diagnostic may hit the same failed disk (or a disposed UI).
    try { mkdirSync(dir, { recursive: true }); publish(join(dir, "state.json"), { runId, sessionFile, state: "paused", error: diagnostic }); } catch { /* Best effort only. */ }
    try { if (ctx.hasUI) ctx.ui.notify(diagnostic, "warning"); } catch { /* A failed observer cannot escape a native callback. */ }
  };
  pi.on("session_start", (_event, ctx) => {
    stopWatcher();
    mkdirSync(dir, { recursive: true });
    // Only atomic request renames are dispatchable, never partial temporary files.
    watcher = watch(dir, (_event, filename) => {
      try {
        const names = filename ? [filename.toString()] : readdirSync(dir);
        for (const name of names) {
          if (name.endsWith(".request.json")) receive(name.slice(0, -".request.json".length), ctx);
        }
      } catch (error) {
        // An I/O or API failure is ambiguous after claiming. Never replay it.
        pause(error, ctx);
      }
    });
    watcher.unref();
    watcher.on("error", (error) => pause(error, ctx));
    busy(); // Startup/reload invalidates every previous settled token.
  });
  pi.on("before_agent_start", busy);
  pi.on("agent_start", busy);
  pi.on("session_shutdown", () => { stopWatcher(); busy(); });
  pi.on("agent_settled", (event, ctx) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) { busy(); return; }
    idleToken = randomUUID();
    publish(join(dir, "state.json"), { runId, sessionFile, transport: watcher ? CONTINUATION_TRANSPORT : undefined, state: event.aborted ? "interrupted-idle" : "settled-idle", idleToken });
  });
  function receive(requestId: string, ctx: ExtensionContext): void {
      if (!uuid.test(requestId)) return;
      const resultFile = join(dir, `${requestId}.result.json`);
      const claimFile = join(dir, `${requestId}.claim.json`);
      // A durable claim survives reload; even an ambiguous dispatch must never be replayed.
      if (existsSync(claimFile) || existsSync(resultFile)) return;
      const request = read(join(dir, `${requestId}.request.json`));
      const reject = (reason: string) => publish(resultFile, { runId, requestId, sessionFile,
        idleToken: request?.idleToken, status: "rejected", reason });
      if (request?.runId !== runId || request?.requestId !== requestId ||
          request?.sessionFile !== sessionFile || canonicalSessionPath(ctx.sessionManager.getSessionFile() ?? "") !== sessionFile ||
          typeof request?.message !== "string" || !request.message.trim()) {
        reject("Invalid run-bound continuation payload"); return;
      }
      if (!idleToken || request.idleToken !== idleToken || !ctx.isIdle() || ctx.hasPendingMessages()) {
        reject("Child is not settled interrupted idle"); return;
      }
      writeFileSync(claimFile, JSON.stringify({ runId, requestId, status: "dispatching" }), { flag: "wx", mode: 0o600 });
      busy();
      // Explicitly bypass extension slash commands, skills and prompt templates.
      // This is the API path, not terminal input: !, @ and multiline text stay data.
      pi.sendUserMessage(request.message, { expandPromptTemplates: false });
      // Publish once to a distinct acknowledgement path: replacing a claim that a
      // parent is reading can fail on Windows. Never remove the durable claim.
      // Accepted means the API call returned, not exactly-once model execution.
      publish(resultFile, { runId, requestId, sessionFile, idleToken: request.idleToken, status: "accepted" });
  }
  pi.registerCommand(CONTINUE_COMMAND, {
    description: "Private run-bound continuation transport (manual compatibility)",
    handler: async (requestId, ctx) => receive(requestId, ctx),
  });
}

interface LiveChild {
  id: string; name: string; cli?: string; sessionFile: string; surface: string;
  activityFile?: string; lifecycle: SubagentLifecycle; hasTurnResult?: boolean;
}

/** Reconcile an existing request only. No transport, replay, or new request is possible here. */
export function reconcileContinuation(owner: SessionOwner,
  child: { id: string; sessionFile: string; activityFile?: string },
  persist?: (requestId: string) => void,
): { requestId: string; status: "accepted" | "rejected"; reason?: string } | undefined {
  const requestId = owner.continuationRequestId;
  if (!requestId || !uuid.test(requestId) || owner.runId !== child.id || !child.activityFile) return;
  const dir = continuationDir(child.activityFile);
  const request = read(join(dir, `${requestId}.request.json`));
  const result = read(join(dir, `${requestId}.result.json`));
  const sessionFile = canonicalSessionPath(child.sessionFile);
  if (request?.runId !== child.id || request?.requestId !== requestId || request?.sessionFile !== sessionFile
    || !uuid.test(request?.idleToken) || typeof request?.message !== "string" || !request.message.trim()
    || result?.runId !== child.id || result?.requestId !== requestId || result?.sessionFile !== sessionFile
    || result?.idleToken !== request.idleToken || !["accepted", "rejected"].includes(result?.status)) return;
  if (result.status === "accepted") {
    const claim = read(join(dir, `${requestId}.claim.json`));
    if (claim?.runId !== child.id || claim?.requestId !== requestId || claim?.status !== "dispatching") return;
  }
  // Persist resolution before dropping the in-memory fence. A failed durable
  // write leaves the original reservation intact for an explicit recheck.
  persist?.(requestId);
  if (owner.continuationRequestId !== requestId) throw new Error("Continuation ownership changed during reconciliation");
  delete owner.continuationRequestId;
  return { requestId, status: result.status, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
}

/** Reserve synchronously before inspection/transport awaits; never launch a replacement on failure. */
export async function continueLiveChild(owner: SessionOwner, child: LiveChild | undefined,
  params: { message?: string; name?: string },
  transport: { inspect: (surface: string) => Promise<PaneInspection>; send?: (surface: string, text: string) => void;
    beforeSend?: () => void; settled?: (requestId: string) => void; timeoutMs?: number },
): Promise<{ requestId: string; status: "accepted" | "pending" }> {
  if (owner.closeRequestId) throw new Error(`Close ${owner.closeRequestId} is pending/retained; do not continue or relaunch this process.`);
  if (owner.continuationRequestId) {
    if (!child) throw new Error("Pending continuation has no tracked child");
    const previous = reconcileContinuation(owner, child, transport.settled);
    if (!previous) throw new Error(`Continuation ${owner.continuationRequestId} is in flight or uncertain; do not retry.`);
    if (previous.status === "rejected") throw new Error(`Child rejected continuation: ${previous.reason}`);
    return previous as { requestId: string; status: "accepted" }; // A recheck never dispatches the newly supplied message.
  }
  if (!child || child.id !== owner.runId || child.cli !== "pi" || !child.activityFile ||
      child.lifecycle.process.kind !== "running" || !["interrupted", "waiting", "active", "starting"].includes(child.lifecycle.turn.kind)) {
    throw new Error("Owned session is not a tracked interrupted or settled idle live Pi child; close its process before closed-session resume.");
  }
  if (typeof params.message !== "string" || !params.message.trim()) throw new Error("Live continuation requires a nonempty message.");
  if (params.name !== undefined && params.name !== child.name) throw new Error("Live continuation cannot change the child name/configuration.");
  const requestId = randomUUID();
  owner.continuationRequestId = requestId;
  let dispatched = false;
  try {
    const pane = await transport.inspect(child.surface);
    // HC reports a completed turn as done even while the Pi process remains open.
    // Neither coarse status authorizes dispatch without the child-issued idle token below.
    if (pane.kind !== "present" || !["idle", "done"].includes(pane.agentStatus ?? "")) throw new Error("Live child pane is not confirmed idle.");
    if (child.lifecycle.process.kind !== "running" || !["interrupted", "waiting", "active", "starting"].includes(child.lifecycle.turn.kind)) {
      throw new Error("Live child changed state during continuation inspection.");
    }
    const dir = continuationDir(child.activityFile);
    const state = read(join(dir, "state.json"));
    if (state?.runId !== child.id || state?.sessionFile !== canonicalSessionPath(child.sessionFile) ||
        !["interrupted-idle", "settled-idle"].includes(state?.state) || !uuid.test(state?.idleToken)) {
      throw new Error("Child has not confirmed settled interrupted idle.");
    }
    // Cancellation drain can replace the local interrupt marker with active.
    // If HC never sampled working, subsequent idle inspection calls it starting.
    // Neither stale label outranks a fresh interrupted-idle token from this run
    // and session. Ordinary settled-idle does NOT get this exception.
    if (["active", "starting"].includes(child.lifecycle.turn.kind) && state.state !== "interrupted-idle") {
      throw new Error(`Child has not confirmed interrupted idle over the ${child.lifecycle.turn.kind} parent observation.`);
    }
    // Parent turn labels are observations, not an acknowledgement of Escape.
    // A manually aborted child can be `waiting` without any result; conversely
    // Escape sent to an already settled child need not generate another event.
    // Only a run/session-bound child token qualifies either case for dispatch.
    if (state.state === "settled-idle" && child.lifecycle.turn.kind !== "interrupted" && !child.hasTurnResult) {
      throw new Error("Child has not confirmed an interrupted turn or a supervised keepOpen result.");
    }
    if (state.transport !== CONTINUATION_TRANSPORT) {
      throw new Error("Child lacks artifact continuation support. Update/reload the child and complete a turn before continuing; no terminal fallback was attempted.");
    }
    transport.beforeSend?.(); // Validate binding/custody BEFORE making a request observable.
    dispatched = true; // A failed publication/acknowledgement is conservatively uncertain.
    publish(join(dir, `${requestId}.request.json`), {
      runId: child.id, requestId, sessionFile: state.sessionFile, idleToken: state.idleToken, message: params.message,
    });
    const deadline = Date.now() + (transport.timeoutMs ?? 3000);
    do {
      const result = reconcileContinuation(owner, child, transport.settled);
      if (result?.status === "accepted") return { requestId, status: "accepted" };
      if (result?.status === "rejected") throw new Error(`Child rejected continuation: ${result.reason}`);
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() <= deadline);
    return { requestId, status: "pending" };
  } finally {
    if (!dispatched) delete owner.continuationRequestId;
  }
}
