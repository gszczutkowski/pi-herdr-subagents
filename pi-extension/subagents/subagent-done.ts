/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { assertCompletionSession, beginCompletionTurn, CompletionSessionMismatch, prepareRunCompletion, publishRunCompletion, type PreparedRunCompletion } from "./run-artifacts.ts";
import { getBehaviorConfig } from "./config.ts";
import { createSubagentActivityRecorder } from "./activity.ts";
import { registerSubagentAssignment } from "./assignment.ts";
import { registerLiveContinuation } from "./live-continuation.ts";
import { StructuredResultSchema, normalizeStructuredResult, prepareCompletionArguments } from "./contracts.ts";
import { registerRecoveryIdentity } from "./recovery-identity.ts";
import { registerCloseControl } from "./close-control.ts";
import { registerInterruptControl } from "./interrupt-control.ts";
import { registerInitialSkills } from "./initial-skills.ts";
import { globalStateSlot } from "./global-state.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason === "stop" || msg.stopReason === "error";
      }
    }
  }

  return false;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildCompletionSidecar(messages: any[] | undefined):
  | { type: "done" }
  | { type: "error"; errorMessage: string; stopReason: "error" } {
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done" };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  registerInitialSkills(pi, (errorMessage, ctx) => {
    try {
      assertCompletionSession(ctx.sessionManager);
      beginCompletionTurn(ctx.sessionManager);
      const completion = prepareRunCompletion({ type: "error", errorMessage, stopReason: "error" }, ctx.sessionManager);
      if (completion) {
        currentCompletion = { completion, intent: { type: "done", payload: {}, keepOpen: false }, attempts: 0 };
        pending.push(currentCompletion);
        retryPending(ctx);
      }
    } catch (error) {
      notice(ctx, `Bootstrap completion pending/detached: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  registerSubagentAssignment(pi);
  registerLiveContinuation(pi);
  registerRecoveryIdentity(pi);
  registerInterruptControl(pi);
  registerCloseControl(pi);

  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  // Keeping a child open opts the session into collaboration, not just one turn.
  const keepOpenSlot = globalStateSlot<boolean>(`pi-subagents/keep-open/${process.env.PI_SUBAGENT_ID ?? "legacy"}`);
  let keepOpenSession = keepOpenSlot.value ?? (!autoExit || !getBehaviorConfig().closeOnDone);
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let latestAgentMessages: any[] | undefined;
  let completionStaged = false;
  type Intent = { type: "done" | "ping"; payload: object; keepOpen: boolean; batch?: number; failures?: string[] };
  let intent: Intent | undefined;
  let toolBatch = 0;
  let turnFailures: string[] = [];
  interface Pending { completion: PreparedRunCompletion; intent: Intent; attempts: number }
  const pending = globalStateSlot<Pending[]>(
    `pi-subagents/pending-completion/v1/${process.env.PI_SUBAGENT_ID ?? "legacy"}/${process.env.PI_SUBAGENT_SESSION ?? ""}`,
  ).value ??= [];
  let currentCompletion: Pending | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retryDelays = [100, 500, 1000];
  const stopRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined; };
  const notice = (ctx: ExtensionContext, message: string) => {
    ctx.ui?.setStatus?.("subagent-completion", message);
    ctx.ui?.notify?.(message, "warning");
    if (!ctx.hasUI) console.error(`[subagent completion] ${message}`);
  };
  const retryPending = (ctx: ExtensionContext) => {
    stopRetry();
    // Do not make a closeable result visible while a subsequent turn is busy.
    // before_agent_start cancels timers; agent_settled resumes this queue.
    if (!pending.length || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    for (const item of pending.slice()) {
      if (item.attempts > retryDelays.length) continue;
      try {
        item.attempts++;
        publishRunCompletion(item.completion, ctx.sessionManager);
        pending.splice(pending.indexOf(item), 1);
        if (item === currentCompletion) {
          if (item.intent.type === "ping") recorder.callerPing();
          else recorder.agentEndDone(item.intent.keepOpen);
          if (!item.intent.keepOpen) ctx.shutdown();
        }
        ctx.ui?.setStatus?.("subagent-completion", pending.length ? "Completion pending" : undefined);
      } catch (error) {
        const paused = error instanceof CompletionSessionMismatch;
        if (paused) item.attempts = retryDelays.length + 1;
        const exhausted = item.attempts > retryDelays.length;
        notice(ctx, `Completion pending: ${error instanceof Error ? error.message : String(error)}. ${exhausted
          ? "Automatic retry paused; use /subagent_retry_completion in the supervised session."
          : `Retry ${item.attempts}/${retryDelays.length} scheduled.`}`);
      }
    }
    const next = pending.find(item => item.attempts <= retryDelays.length);
    if (next) {
      retryTimer = setTimeout(() => { retryTimer = undefined; retryPending(ctx); }, retryDelays[Math.max(0, next.attempts - 1)]);
      retryTimer.unref?.();
    }
  };

  pi.registerCommand("subagent_retry_completion", {
    description: "Retry pending settled results without starting a model turn",
    handler: async (_args, ctx) => {
      for (const item of pending) item.attempts = 0;
      retryPending(ctx);
    },
  });

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    if (process.env.PI_SUBAGENT_SESSION) {
      try { assertCompletionSession(ctx.sessionManager); retryPending(ctx); }
      catch (error) { notice(ctx, `Supervision detached: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", (_event, ctx) => {
    beginCompletionTurn(ctx.sessionManager);
    stopRetry();
    completionStaged = false;
    currentCompletion = undefined;
    intent = undefined;
    turnFailures = [];
    latestAgentMessages = undefined;
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    // agent_end is not terminal: Pi may compact and automatically retry after
    // this event. Keep the latest result, but do not publish completion or
    // shut down until agent_settled confirms no continuation will run.
    latestAgentMessages = (event as any).messages as any[] | undefined;
    recorder.agentEndWaiting();
  });

  pi.on("agent_settled", (event, ctx) => {
    // Cancellation may drain a trailing turn_start after agent_end. Only this
    // final boundary can overwrite it with an authoritative non-active snapshot.
    if (ctx.isIdle()) recorder.agentEndWaiting();
    const natural = !event.aborted && shouldAutoExitOnAgentEnd(userTookOver, latestAgentMessages);
    if (!completionStaged && (intent || natural)) {
      // Ping wins over done in any mixed batch, independent of execution order.
      // Done wins over auto completion. Resolve final text only here, after all
      // siblings, retries, queued messages and boundary continuations finished.
      const requested = intent ?? { type: "done" as const, payload: buildCompletionSidecar(latestAgentMessages), keepOpen: keepOpenSession };
      // Escape and session replacement abort outgoing work. Preserve the child:
      // even a previously staged close/ping cannot close the replacement session.
      const selected = event.aborted ? { ...requested, type: "done" as const, keepOpen: true } : requested;
      if (selected.type === "done" && !event.aborted) {
        keepOpenSession = selected.keepOpen;
        keepOpenSlot.value = keepOpenSession;
      }
      const providerError = findLatestAssistantError(latestAgentMessages)?.errorMessage;
      const failure = [event.aborted ? "Supervised turn aborted before settlement." : "", ...(intent?.failures ?? turnFailures), providerError].filter(Boolean).join("\n");
      let payload: object = selected.payload;
      if (failure) {
        payload = selected.type === "ping"
          ? { ...payload, message: `${(payload as { message: string }).message}\nSettlement warning: ${failure}` }
          : { ...payload, type: "error", errorMessage: failure, stopReason: event.aborted ? "aborted" : "error" };
      }
      try {
        const completion = prepareRunCompletion({ ...payload, ...(selected.keepOpen ? { keepOpen: true } : {}) }, ctx.sessionManager);
        if (completion) {
          currentCompletion = { completion, intent: selected, attempts: 0 };
          pending.push(currentCompletion);
        }
        completionStaged = true;
      } catch (error) {
        notice(ctx, `Completion not published: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    retryPending(ctx);
    if (autoExit) userTookOver = false;
  });

  pi.on("turn_start", (event) => {
    toolBatch++;
    turnFailures = []; // A successfully recovered earlier tool error is not terminal failure.
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    if (event.isError && !event.parentToolCallId) {
      const text = (event.result as any)?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      const failure = `Tool ${event.toolName} failed: ${text || "unknown tool error"}`;
      turnFailures.push(failure);
      if (intent?.batch === toolBatch) intent.failures!.push(failure);
    }
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    stopRetry();
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Stage a help request to the parent and close after the agent settles and publication succeeds. " +
      "The parent can resume this session with a response. Use when stuck or needing a decision. " +
      "Prefer calling alone: non-terminating siblings require another model request. " +
      "In a mixed caller_ping/subagent_done batch, ping takes precedence; sibling failures are reported at settlement.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      assertCompletionSession(ctx.sessionManager);
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      if (intent?.type !== "ping") intent = { type: "ping", payload: exitData, keepOpen: false, batch: toolBatch, failures: [...turnFailures] };
      return {
        content: [{ type: "text", text: "Ping staged. The parent is notified and shutdown requested only after settlement and successful publication." }],
        terminate: true,
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    prepareArguments: prepareCompletionArguments,
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It stages this turn's results for the immediate parent at agent settlement, then optionally closes after publication succeeds. " +
      "Optionally provide a structured result (worker proposals only, never acceptance). Otherwise your last assistant text from the current supervised task and active branch becomes the summary (explicitly reports no text if this task emitted none).",
    parameters: Type.Object({
      result: Type.Optional(StructuredResultSchema),
      close: Type.Optional(Type.Boolean({
        description: "False leaves this session and its pane open for follow-up. True closes it. Omitting it uses behavior.closeOnDone.",
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertCompletionSession(ctx.sessionManager);
      const keepOpen = params.close === undefined ? keepOpenSession : !params.close;
      if (!intent) {
        intent = { type: "done", payload: { type: "done", ...normalizeStructuredResult(params.result) }, keepOpen, batch: toolBatch, failures: [...turnFailures] };
      }
      return {
        content: [{ type: "text", text: keepOpen
          ? "Result staged for settlement. This session remains supervised for follow-up after publication."
          : "Result staged. Shutdown is requested only after settlement and successful publication." }],
        terminate: true,
        details: normalizeStructuredResult(params.result),
      };
    },
  });
}
