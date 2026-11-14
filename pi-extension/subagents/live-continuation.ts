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
  pi.on("session_start", (_event, ctx) => {
    watcher?.close();
    mkdirSync(dir, { recursive: true });
    // Only atomic request renames are dispatchable, never partial temporary files.
    watcher = watch(dir, (_event, filename) => {
      try {
        const names = filename ? [filename.toString()] : readdirSync(dir);
        for (const name of names) {
          if (name.endsWith(".request.json")) receive(name.slice(0, -".request.json".length), ctx);
        }
      } catch {
        // An I/O or API failure is ambiguous after claiming. Never replay it.
        watcher?.close();
        watcher = undefined;
        busy();
      }
    });
    watcher.on("error", () => { watcher?.close(); watcher = undefined; busy(); });
    busy(); // Startup/reload invalidates every previous settled token.
  });
  pi.on("before_agent_start", busy);
  pi.on("agent_start", busy);
  pi.on("session_shutdown", () => { watcher?.close(); watcher = undefined; busy(); });
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
      const reject = (reason: string) => publish(resultFile, { runId, requestId, status: "rejected", reason });
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
      publish(resultFile, { runId, requestId, status: "accepted" });
  }
  pi.registerCommand(CONTINUE_COMMAND, {
    description: "Private run-bound continuation transport (manual compatibility)",
    handler: receive,
  });
}

interface LiveChild {
  id: string; name: string; cli?: string; sessionFile: string; surface: string;
  activityFile?: string; lifecycle: SubagentLifecycle; hasTurnResult?: boolean;
}

/** Reserve synchronously before inspection/transport awaits; never launch a replacement on failure. */
export async function continueLiveChild(owner: SessionOwner, child: LiveChild | undefined,
  params: { message?: string; name?: string },
  transport: { inspect: (surface: string) => Promise<PaneInspection>; send?: (surface: string, text: string) => void;
    beforeSend?: () => void; timeoutMs?: number },
): Promise<{ requestId: string; status: "accepted" | "pending" }> {
  if (owner.closeRequestId) throw new Error(`Close ${owner.closeRequestId} is pending/retained; do not continue or relaunch this process.`);
  if (owner.continuationRequestId) throw new Error(`Continuation ${owner.continuationRequestId} is in flight or uncertain; do not retry.`);
  if (!child || child.id !== owner.runId || child.cli !== "pi" || !child.activityFile ||
      child.lifecycle.process.kind !== "running" || !(child.lifecycle.turn.kind === "interrupted" || (child.hasTurnResult && child.lifecycle.turn.kind === "waiting"))) {
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
    if (child.lifecycle.process.kind !== "running" || !(child.lifecycle.turn.kind === "interrupted" || (child.hasTurnResult && child.lifecycle.turn.kind === "waiting"))) {
      throw new Error("Live child changed state during continuation inspection.");
    }
    const dir = continuationDir(child.activityFile);
    const state = read(join(dir, "state.json"));
    if (state?.runId !== child.id || state?.sessionFile !== canonicalSessionPath(child.sessionFile) ||
        state?.state !== (child.lifecycle.turn.kind === "interrupted" ? "interrupted-idle" : "settled-idle") || !uuid.test(state?.idleToken)) {
      throw new Error("Child has not confirmed settled interrupted idle.");
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
      const result = read(join(dir, `${requestId}.result.json`));
      if (result?.runId === child.id && result?.requestId === requestId) {
        if (result.status === "accepted") { delete owner.continuationRequestId; return { requestId, status: "accepted" }; }
        if (result.status === "rejected") {
          dispatched = false;
          throw new Error(`Child rejected continuation: ${result.reason}`);
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() <= deadline);
    return { requestId, status: "pending" };
  } finally {
    if (!dispatched) delete owner.continuationRequestId;
  }
}
