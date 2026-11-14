import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSessionPath, type SessionOwner } from "./ownership.ts";
import type { SubagentLifecycle, PaneInspection } from "./lifecycle.ts";

export const CONTINUE_COMMAND = "_subagent_continue";
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
  mkdirSync(dir, { recursive: true });
  let idleToken: string | undefined;
  const busy = () => {
    idleToken = undefined;
    publish(join(dir, "state.json"), { runId, sessionFile, state: "busy" });
  };
  pi.on("session_start", busy);
  pi.on("before_agent_start", busy);
  pi.on("agent_start", busy);
  pi.on("session_shutdown", busy);
  pi.on("agent_settled", (event, ctx) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) { busy(); return; }
    idleToken = randomUUID();
    publish(join(dir, "state.json"), { runId, sessionFile, state: event.aborted ? "interrupted-idle" : "settled-idle", idleToken });
  });
  pi.registerCommand(CONTINUE_COMMAND, {
    description: "Private run-bound continuation transport",
    handler: (requestId, ctx) => {
      if (!uuid.test(requestId)) return;
      const resultFile = join(dir, `${requestId}.result.json`);
      // A durable claim survives reload; even an ambiguous dispatch must never be replayed.
      if (existsSync(resultFile)) return;
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
      writeFileSync(resultFile, JSON.stringify({ runId, requestId, status: "dispatching" }), { flag: "wx", mode: 0o600 });
      busy();
      // Explicitly bypass extension slash commands, skills and prompt templates.
      // This is the API path, not terminal input: !, @ and multiline text stay data.
      pi.sendUserMessage(request.message, { expandPromptTemplates: false });
      publish(resultFile, { runId, requestId, status: "accepted" });
    },
  });
}

interface LiveChild {
  id: string; name: string; cli?: string; sessionFile: string; surface: string;
  activityFile?: string; lifecycle: SubagentLifecycle; hasTurnResult?: boolean;
}

/** Reserve synchronously before inspection/transport awaits; never launch a replacement on failure. */
export async function continueLiveChild(owner: SessionOwner, child: LiveChild | undefined,
  params: { message?: string; name?: string },
  transport: { inspect: (surface: string) => Promise<PaneInspection>; send: (surface: string, text: string) => void;
    beforeSend?: () => void; timeoutMs?: number },
): Promise<{ requestId: string; status: "accepted" | "pending" }> {
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
    if (pane.kind !== "present" || pane.agentStatus !== "idle") throw new Error("Live child pane is not confirmed idle.");
    if (child.lifecycle.process.kind !== "running" || !(child.lifecycle.turn.kind === "interrupted" || (child.hasTurnResult && child.lifecycle.turn.kind === "waiting"))) {
      throw new Error("Live child changed state during continuation inspection.");
    }
    const dir = continuationDir(child.activityFile);
    const state = read(join(dir, "state.json"));
    if (state?.runId !== child.id || state?.sessionFile !== canonicalSessionPath(child.sessionFile) ||
        state?.state !== (child.lifecycle.turn.kind === "interrupted" ? "interrupted-idle" : "settled-idle") || !uuid.test(state?.idleToken)) {
      throw new Error("Child has not confirmed settled interrupted idle.");
    }
    publish(join(dir, `${requestId}.request.json`), {
      runId: child.id, requestId, sessionFile: state.sessionFile, idleToken: state.idleToken, message: params.message,
    });
    transport.beforeSend?.(); // Rejected validation is not a transport attempt.
    dispatched = true; // A throwing transport may already have submitted the input.
    try { transport.send(child.surface, continuationCommand(requestId)); } catch { /* reconcile durable acknowledgement below */ }
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
