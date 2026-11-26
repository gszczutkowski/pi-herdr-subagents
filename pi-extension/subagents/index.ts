import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { ACTIVE_ACCENT, OPEN_ACCENT, borderLine, borderTop, borderBottom, framedMessage } from "./frame.ts";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { resolveSubagentCwd } from "./paths.ts";
import { resolveRoleInstructions } from "./role-instructions.ts";
import { shellComment } from "./shell.ts";
import { launchProfilePath, persistLaunchProfile, persistProfileBinding, readPiLaunchProfile, resolveLaunchProfile, resumeLaunchContext } from "./launch-profile.ts";
import { continueLiveChild, hasAcceptedContinuation } from "./live-continuation.ts";
import { assertQueueActiveResume, captureQueueChildFence, captureQueueResumeTarget, denyQueueTransport, hasQueueAllocation, inspectPersistedQueueProfile, isQueueMarkedSession } from "./queue-child-allocation.ts";
import { auditSession, assertSessionWriters } from "./session-audit.ts";
import { readChildIdentity } from "./recovery-identity.ts";
import { closeOwnedChild, type CloseResult } from "./close-control.ts";
import { interruptOwnedChild, type InterruptResult } from "./interrupt-control.ts";
import { probeProcess, sameProcess, type ProcessIdentity } from "./process-identity.ts";
import { prepareLaunchRun, registerLaunchedRun } from "./launch-registration.ts";
import { createLineage, type Lineage } from "./lineage.ts";
import { recordHistory, registerPlanHistory } from "./history.ts";
import { registerHistoryView } from "./history-view.ts";
import { RuntimeStore, dispatchFailureEventId, hasAfterIntentMarker, readRuntimeManifest, resumeIntentBinding, runtimeRenameAttempts, verifyResumeImages, type DurableRun, type RuntimeManifest, type RuntimeParent } from "./runtime-store.ts";
import { reconcileRuntime, releaseRecoveredSession, type RecoveryDispatchDisposition, type RecoverySupervisor } from "./runtime-recovery.ts";
import { dispatchReport, notifyRecoveryOnStartup, recoveryHistory, registerRecoveryReport, type RecoveryView } from "./recovery-report.ts";
import type { SubagentLaunchContext } from "./harness/types.ts";
import { fileURLToPath } from "node:url";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import {
  isTerminalAvailable,
  terminalSetupHint,
  createSubagentSurface,
  resolveSubagentLayout,
  runScriptInPane,
  closePane,
  shellQuote,
  readPane,
  readPaneAsync,
  inspectPane,
  setPaneTask,
} from "./terminal.ts";
import { waitForCompletion, RetainedCompletionIndex } from "./completion.ts";
import { canonicalSessionPath, reserveSession, releaseSession, sessionOwners, type SessionOwner } from "./ownership.ts";
import {
  buildAuthenticatedModelCatalog,
  resolveRuntimePlan,
  wrapPiModelRegistry,
  THINKING_LEVELS,
  type ResolvedRuntimePlan,
  type ThinkingLevel,
} from "./runtime-routing.ts";
import {
  getHarnessDriver,
  validateHarnessLaunch,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
} from "./harness/index.ts";
import { resolveModelDefault } from "./model-config.ts";
import { getSubagentConfig } from "./config.ts";
import { boundSubagentMessage } from "./result-budget.ts";
import { registerContextGuard } from "./context-guard.ts";
import { registerPayloadDiagnostics } from "./payload-diagnostics.ts";
import { registerCheckpointContext, registerContextCheckpoint } from "./context-checkpoint.ts";
import { registerPlanContext } from "./plan-context.ts";
import { getAgentConfigDir, loadAgentDefaults, discoverAgentDefinitions, buildAvailableAgentCatalog, type AgentDefaults, type SubagentSessionMode } from "./discovery.ts";
import { DELEGATION_PAUSED, DELEGATION_WAIT_QUERY, type DelegationPause, type DelegationWaitQuery } from "./delegation-wait.ts";
import { approveProjectAgentDirectory, assertProjectApprovalPermitted, authorizedDiscovery, sourceAuthorized, assertAgentDirectoryAuthorized, assertDefinitionAuthorized, type TrustContext } from "./project-trust.ts";

import {
  findLastAssistantMessage,
  findObservedSessionRuntime,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type SubagentStatusState,
  formatElapsedDuration,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { registerSubagentAssignmentRenderer } from "./assignment.ts";
import { globalStateSlot } from "./global-state.ts";
import { registerPlanTools } from "./plan-tools.ts";
import type { PlanPersistence } from "./plan-persistence.ts";
import { AssignmentContractSchema, resolveAssignmentContract, contractTask, normalizeStructuredResult, type StructuredResult } from "./contracts.ts";
import { PlanTaskParams, assertLegacyBoundTransport, bindPlanRun, DispatchEvidenceWriteError, importPlanEnvelope, recordDispatchFailure, resolveResumeContract, samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import { captureDispatchEvidence, dispatchIncidents, dispatchReason, noRetry, operationCode, readDispatchEvidence, reconcileDispatchEvidence, verifiedUnsentRunIds, type DispatchEvidence, type DispatchIncident, type DispatchOperation } from "./dispatch-recovery.ts";
import { registerPlanCommand } from "./plan-preflight.ts";
import { createDeliveryState, deliveryDiagnostics, enqueueDelivery, flushDeliveries, pauseDeliveries, reconcileUnsentDeliveries, restoreDurableDeliveries, type DeliveryState } from "./delivery.ts";
import {
  createLifecycle,
  markCompleted,
  markCompletionDetected,
  markDelivery,
  markFailed,
  markInterruptRequested,
  markProcessRunning,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
  type LifecycleProjection,
  type SubagentLifecycle,
  type PaneInspection,
} from "./lifecycle.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
type IntervalSlot = ReturnType<typeof setInterval> | null;
const widgetIntervalSlot = globalStateSlot<IntervalSlot>("pi-subagents/widget-interval");
const statusIntervalSlot = globalStateSlot<IntervalSlot>("pi-subagents/status-interval");
const closedProcessReceipts = globalStateSlot<Map<string, { id: string; name: string; result: CloseResult }>>(
  "pi-subagents/closed-process-receipts/v1",
).value ??= new Map();

for (const slot of [widgetIntervalSlot, statusIntervalSlot]) {
  const interval = slot.value;
  if (interval) {
    clearInterval(interval);
    slot.value = null;
  }
}

const subagentRoutingGuidelines = [
  "Choose the named agent whose description most closely matches the task; do not use one agent as a generic default.",
  "Omit model and thinking when invoking a named agent so its configured defaults apply. Passing either field is an explicit one-off override and takes precedence over agent frontmatter.",
  "For a bare spawn, omit model and thinking to inherit the parent runtime.",
  "When an intentional runtime override is necessary, prefer changing thinking before changing models: minimal/low for bounded mechanical work, medium for ordinary implementation or review, and high+ for architecture, concurrency, security, or hard diagnosis.",
  "When overriding a subagent model, use an exact authenticated provider/model-id from the live catalog below. Do not invent aliases or fuzzy names.",
];

const ThinkingLevelSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  {
    description:
      "Pi thinking level. Omit to use a named agent's thinking default, then the parent level. Passing a value explicitly overrides agent frontmatter for this spawn.",
  },
);

const SubagentParams = Type.Object({
  assignmentContract: Type.Optional(AssignmentContractSchema),
  planTask: Type.Optional(PlanTaskParams),
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from the available named subagent catalog. Agent frontmatter can provide model, thinking, tools, skills, and role instructions.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Additional role instructions, appended after the named agent's body (never replaces it). Pi uses the agent's system-prompt append/replace mode; without that mode, delivered with the task in every session mode." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Exact authenticated provider/model-id. Omit to use a named agent's model default, then the configured or parent model. Passing a value explicitly overrides agent frontmatter for this spawn.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevelSchema),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force full-context fork mode (Pi-backed agents only). Inherit the current conversation, overriding agent frontmatter session-mode; unsupported harnesses reject before launch.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. Observed stalled/recovered transitions are panel-only for all agents; results, help requests and errors still wake the parent.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
  "subagent_close",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
  ctx: TrustContext,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : ctx.cwd;
  const effectiveCwd = resolveSubagentCwd(rawCwd, cwdBase);
  const localAgentDir = join(effectiveCwd ?? ctx.cwd, ".pi", "agent");
  const effectiveAgentDir = localAgentDir && existsSync(localAgentDir) &&
    sourceAuthorized(ctx, getAgentConfigDir(), localAgentDir, "agentDirectories", effectiveCwd ?? ctx.cwd)
    ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer). Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork).
 *      This metadata no longer controls wakeups; observations are panel-only.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveAutoExit(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  // Named agents preserve their declared behavior. Bare tool calls are
  // autonomous by default, including full-context forks: `fork` controls
  // context inheritance, not whether the child should remain open. Interactive
  // flows such as /iterate opt out explicitly with `interactive: true`.
  if (agentDefs) return agentDefs.autoExit ?? false;
  return params.interactive !== true;
}

function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !resolveEffectiveAutoExit(params, agentDefs);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require herdr. ${terminalSetupHint()}`,
      },
    ],
    details: { error: "herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const config = getSubagentConfig();

function keepOpenGuidance(runId: string): string {
  return `Child was left open at settlement. If it is still open and idle, no follow-up is needed, and you are authorized to close it, call subagent_close(${JSON.stringify({ id: runId })}). For planned follow-up, use subagent_resume with a message in the existing session.`;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage" | "keepOpen"
  >,
  name: string,
  runId: string,
): string {
  const followUp = result.keepOpen === true ? `${keepOpenGuidance(runId)}\n\n` : "";
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}${result.keepOpen === true ? "" : `\nResume: pi --session ${result.sessionFile}`}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `${followUp}Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${followUp}${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${followUp}${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  structuredResult?: StructuredResult;
  resultDiagnostic?: string;
  eventId?: string;
  supervisionEnded?: boolean;
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  keepOpen?: boolean;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  planTask?: PlanTaskBinding;
  lineage?: Lineage;
  durableStore?: RuntimeStore;
  terminalActionsAllowed?: boolean;
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  completionRunId?: string;
  hasTurnResult?: boolean;
  /** A locally published follow-up, independent of the historical keepOpen result. */
  delegatedContinuation?: { requestId: string; owner: SessionOwner };
  completionIndex?: RetainedCompletionIndex;
  observationError?: string;
  retryObservation?: () => void;
  /**
   * Optional legacy status snapshot retained only for hydrating pre-lifecycle
   * runtime entries after /reload. Live observation uses `lifecycle` only.
   */
  statusState?: SubagentStatusState;
  lifecycle: SubagentLifecycle;
  /** Last projected kind used to detect stalled/recovered transitions. */
  lastProjectedKind?: LifecycleProjection["kind"];
  /**
   * Interactive metadata; all status transitions are panel-only. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Parent-resolved model/thinking selection and provenance. */
  runtimePlan: ResolvedRuntimePlan | undefined;
}

interface SubagentRuntime {
  plans?: PlanPersistence;
  planImportErrors?: Map<string, string>;
  store?: RuntimeStore;
  stopRecovery?: RecoverySupervisor;
  recoveryInFlight?: { ctx: ExtensionContext; pi?: ExtensionAPI; store?: RuntimeStore; operation: Promise<string | undefined> };
  recoveryError?: string;
  recoveryIOError?: boolean;
  dispatchEvidence?: Map<string, DispatchEvidence>;
  dispatchRepair?: { store: RuntimeStore; incidents: DispatchIncident[]; storeError?: string;
    requiresExplicitReconcile?: true; journalReadFault?: true }; // journalReadFault can survive reload from older code
  /** Settlements observed while no session-bound context is available. */
  suspendedCompletions?: Map<string, { running: RunningSubagent; result: SubagentResult }>;
  runningSubagents: Map<string, RunningSubagent>;
  pi?: ExtensionAPI;
  latestCtx?: ExtensionContext;
  treeSuspension?: { timer: ReturnType<typeof setInterval> };
  modelCatalog?: string;
  agentCatalog?: string;
  delivery?: DeliveryState;
}

function createSubagentRuntime(): SubagentRuntime {
  return { runningSubagents: new Map<string, RunningSubagent>() };
}

/** Runtime state preserved across /reload. */
const runtime = globalStateSlot<SubagentRuntime>("pi-subagents/runtime").value ??= createSubagentRuntime();
const runningSubagents = runtime.runningSubagents;

/** Lazily establish branch custody before any child dispatch. */
function durableStoreFor(ctx: Pick<ExtensionContext, "sessionManager">): RuntimeStore | undefined {
  // Legacy host/test adapters cannot claim durable recovery support.
  if (typeof ctx.sessionManager.getHeader !== "function" || typeof ctx.sessionManager.getBranch !== "function") return undefined;
  assertStorageAvailable();
  if (runtime.store) {
    runtime.store.assertCustody();
    return runtime.store;
  }
  const sessionFile = ctx.sessionManager.getSessionFile();
  const header = ctx.sessionManager.getHeader();
  if (!sessionFile || !header?.id) throw new Error("Durable supervision requires a saved parent session");
  let checkpoint: ReturnType<typeof ctx.sessionManager.getBranch>[number] | undefined;
  if (!checkpoint) {
    const branchToken = randomUUID();
    runtime.pi?.appendEntry("subagent-custody", { branchToken });
    checkpoint = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "subagent-custody");
  }
  if (checkpoint?.type !== "custom" || typeof (checkpoint.data as any)?.branchToken !== "string") {
    throw new Error("Could not persist branch custody checkpoint");
  }
  const store = new RuntimeStore(join(getArtifactDir(ctx.sessionManager.getSessionDir(), header.id), "subagent-runtime"), {
    sessionFile: canonicalSessionPath(sessionFile), headerId: header.id,
    branchToken: (checkpoint.data as any).branchToken, checkpoint: checkpoint.id,
  });
  const storeParent = store.snapshot().parent;
  store.isCurrent = () => ownsActiveBranch(runtime.latestCtx, storeParent);
  runtime.store = store;
  delivery.store = store;
  return store;
}

function ownsActiveBranch(ctx: ExtensionContext | undefined, parent: RuntimeParent): boolean {
  try {
    return !!ctx && canonicalSessionPath(ctx.sessionManager.getSessionFile()!) === parent.sessionFile &&
      ctx.sessionManager.getHeader()?.id === parent.headerId &&
      ctx.sessionManager.getBranch().some((entry) => entry.id === parent.checkpoint && entry.type === "custom" &&
        entry.customType === "subagent-custody" && (entry.data as any)?.branchToken === parent.branchToken);
  } catch { return false; }
}

function recoveryIOError(error: unknown): boolean {
  return ["EPERM", "EBUSY", "EIO", "ENOSPC", "EACCES", "EROFS", "EMFILE", "ENFILE"].includes(operationCode(error) ?? "");
}

function activeDispatchRepair() {
  const repair = runtime.dispatchRepair;
  if (!repair || repair.store !== runtime.store) return;
  if (repair.journalReadFault) repair.requiresExplicitReconcile = true;
  return repair;
}

function dispatchStoragePause(code: string): Error {
  return Object.assign(new Error(`Dispatch metadata write paused (${code}). Use subagents_reconcile, or type /subagents-reconcile in the original Pi session.`), { code });
}

type DispatchRepair = NonNullable<SubagentRuntime["dispatchRepair"]>;

function dispatchStorageError(explicitFence?: DispatchRepair): string | undefined {
  const repair = activeDispatchRepair();
  return repair !== explicitFence ? repair?.storeError : undefined;
}

function assertStorageAvailable(explicitFence?: DispatchRepair): void {
  if (runtime.recoveryError) throw new Error(runtime.recoveryError);
  const code = dispatchStorageError(explicitFence);
  if (code) throw dispatchStoragePause(code);
}

function pauseRecoveredSupervision(): void {
  runtime.stopRecovery?.();
  runtime.stopRecovery = undefined;
  pauseDeliveries(delivery);
}

function latchDispatchStorageFault(store: RuntimeStore, code: string, incidents?: DispatchIncident[]): void {
  if (runtime.store !== store) return;
  const repair = activeDispatchRepair();
  // Incidental reads cannot clear or replace an observed fence. A failed
  // reconciliation owns the latest repair diagnostics but leaves it latched.
  runtime.dispatchRepair = { store, incidents: incidents ?? repair?.incidents ?? [],
    storeError: incidents !== undefined ? code : repair?.storeError ?? code, requiresExplicitReconcile: true };
  pauseRecoveredSupervision();
}

function applyDispatchRepair(repair: DispatchRepair): void {
  if (repair.storeError) latchDispatchStorageFault(repair.store, repair.storeError, repair.incidents);
  else if (runtime.store === repair.store) runtime.dispatchRepair = repair;
}

function evidenceMemory(): Map<string, DispatchEvidence> { return runtime.dispatchEvidence ??= new Map(); }

function readParentDispatchEvidence(directory: string, manifest: Pick<RuntimeManifest, "parent" | "retainedDispatchEvidence">,
  store?: RuntimeStore) {
  const evidence = readDispatchEvidence(directory, manifest, evidenceMemory());
  if (evidence.storeError && store) latchDispatchStorageFault(store, evidence.storeError);
  return evidence;
}

function canProjectPlan(explicitFence?: DispatchRepair): boolean {
  const repair = activeDispatchRepair();
  return !repair?.requiresExplicitReconcile || repair === explicitFence;
}

function dispatchPlanProjection(store: RuntimeStore, explicitFence?: DispatchRepair) {
  return { store, memory: evidenceMemory(), incidents: activeDispatchRepair()?.incidents,
    canImport: () => runtime.store === store && canProjectPlan(explicitFence),
    readEvidence: (manifest: RuntimeManifest) => {
      const evidence = readParentDispatchEvidence(store.directory, manifest, store);
      const storeError = runtime.store === store ? dispatchStorageError(explicitFence) : undefined;
      return storeError ? { ...evidence, storeError } : evidence;
    },
    onCustodyError: (error: unknown) => {
      const code = operationCode(error);
      if (code) latchDispatchStorageFault(store, code);
    } };
}

function assertFreshDispatchStorage(store: RuntimeStore | undefined): void {
  assertStorageAvailable();
  if (!store) return;
  if (runtime.store !== store) throw new Error("Fresh dispatch lost current runtime custody");
  const custody = store.dispatchCustody();
  if (custody.custodyPaused !== undefined) throw new Error("Fresh dispatch requires current branch custody");
  // Only journal readability/schema is global. This gate doesn't classify or
  // import individual claims and doesn't have to clone historical runs/outbox.
  readParentDispatchEvidence(store.directory, custody, store);
  assertStorageAvailable();
}

function reconcileDispatchMetadata(ctx: ExtensionContext, store: RuntimeStore) {
  store.assertCustody();
  const manifest = store.snapshot();
  if (manifest.custodyPaused || !ownsActiveBranch(ctx, manifest.parent)) throw new Error("Dispatch repair requires current branch custody");
  const plan = runtime.plans?.read(ctx.sessionManager);
  const evidence = readParentDispatchEvidence(store.directory, manifest, store);
  return { store, ...reconcileDispatchEvidence(store, evidence, plan?.writable ? plan.snapshot : undefined, evidenceMemory()) };
}

function readDispatchDisposition(ctx: ExtensionContext, store: RuntimeStore): RecoveryDispatchDisposition {
  const manifest = store.snapshot();
  const evidence = readParentDispatchEvidence(store.directory, manifest, store);
  if (evidence.storeError) throw dispatchStoragePause(evidence.storeError);
  const view = runtime.plans?.read(ctx.sessionManager);
  const incidents = dispatchIncidents(manifest, view?.writable ? view.snapshot : undefined,
    store.directory, evidence, activeDispatchRepair()?.incidents);
  return {
    unsent: verifiedUnsentRunIds(incidents),
    conflicts: new Set(incidents.filter(item => item.status === "still-blocked" && item.code === "EVIDENCE_CONFLICT").map(item => item.runId)),
  };
}

function handleLaunchFailure(ctx: ExtensionContext, store: RuntimeStore | undefined, binding: PlanTaskBinding | undefined,
  unprepared: { id: string; sessionFile: string; name: string; task: string; startTime: number }, error: unknown, dispatched: boolean, operation: DispatchOperation): void {
  const saved = store?.getRun(unprepared.id);
  const run = saved ? { ...unprepared, sessionFile: saved.sessionFile } : unprepared;
  const afterIntent = operation === verifyResumeImages ? resumeIntentBinding({ ...run, planTask: binding }) : undefined;
  try { recordDispatchFailure(runtime.plans!, ctx, binding, run.id, error, store, run, dispatched, afterIntent,
    store ? dispatchPlanProjection(store) : undefined); }
  catch (failure) {
    if (!(failure instanceof DispatchEvidenceWriteError) || !store) {
      (runtime.planImportErrors ??= new Map()).set(run.id, `Dispatch ${run.id}: task import pending (${operationCode(failure) ?? "IMPORT_REFUSED"})`);
      return;
    }
    const { record, retained } = captureDispatchEvidence(evidenceMemory(), store, {
      runId: run.id, sessionFile: run.sessionFile, startedAt: run.startTime, binding, dispatched, operation,
    }, error, failure.writeError);
    const last = activeDispatchRepair();
    // A failed durable write isn't cleared by a successful read or timer pass.
    // Never apply a captured context's failure to a replacement branch/store.
    if (runtime.store === store) runtime.dispatchRepair = { store, storeError: record.writeCode, requiresExplicitReconcile: last?.requiresExplicitReconcile,
      incidents: [...(last?.incidents ?? []).filter(item => item.runId !== run.id), {
        runId: run.id, status: "still-blocked", phase: record.phase, code: record.writeCode, reason: dispatchReason(record), recordedAt: record.recordedAt,
        ...(retained !== "none" ? { evidence: retained } : {}),
        next: `${dispatched ? `${noRetry} ` : ""}Use subagents_reconcile, or type /subagents-reconcile in the original Pi session.`, attempts: runtimeRenameAttempts(failure.writeError) ?? 1,
      }] };
    if (error instanceof Error) error.message += `; dispatch ${run.id} ${record.phase}, failure evidence ${retained === "none" ? "not retained" : retained} (${record.writeCode}). Use subagents_reconcile or type /subagents-reconcile in the original Pi session.`;
  }
}

/** Read only this parent's manifest, never acquire custody or scan other sessions. */
function readRecoveryView(ctx: ExtensionContext, explicitFence?: DispatchRepair): RecoveryView {
  try {
    if (typeof ctx.sessionManager.getHeader !== "function" || typeof ctx.sessionManager.getBranch !== "function") {
      return { error: "Host lacks branch/header APIs; durable recovery unavailable" };
    }
    const header = ctx.sessionManager.getHeader();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!header?.id || !sessionFile) return { error: "Saved parent session unavailable" };
    const current = runtime.store;
    const directory = current?.directory ?? join(getArtifactDir(ctx.sessionManager.getSessionDir(), header.id), "subagent-runtime");
    const manifest = current?.snapshot() ?? readRuntimeManifest(directory);
    if (manifest && !ownsActiveBranch(ctx, manifest.parent)) return { error: "Parent session/active branch mismatch; no recovery access" };
    if (manifest && runtime.recoveryError && !runtime.recoveryIOError) return { error: runtime.recoveryError };
    let storageError = manifest ? runtime.recoveryError ?? dispatchStorageError(explicitFence) : undefined;
    try { current?.assertCustody(); } catch (error) {
      if (!recoveryIOError(error)) return { error: String(error) };
      if (current) latchDispatchStorageFault(current, operationCode(error)!);
      storageError = String(error);
    }
    const plan = runtime.plans?.read(ctx.sessionManager);
    const savedPlan = plan?.writable ? plan.snapshot : undefined;
    const evidence = manifest ? readParentDispatchEvidence(directory, manifest, current)
      : { records: new Map(), conflicts: new Set<string>(), diagnostics: [], verifiedFiles: new Set<string>() };
    if ("storeError" in evidence) storageError ??= evidence.storeError;
    const dispatch = dispatchIncidents(manifest, savedPlan, directory, evidence, [...(activeDispatchRepair()?.incidents ?? [])]);
    const missing = new Set(dispatch.filter(item => item.status === "dispatch-unknown" && item.code === "NO_DURABLE_RUN").map(item => item.runId));
    const importErrors: string[] = [];
    const history: NonNullable<RecoveryView["history"]> = [];
    if (manifest) for (const [id, message] of runtime.planImportErrors ?? []) {
      // Pre-journal runtimes preserved this string and run ID across /reload,
      // but could not retain evidence to import. Keep it as history only for
      // the exact unknown run; real pending imports still block reconciliation.
      if (missing.has(id) && message.startsWith("Dispatch failed/uncertain; task import pending: Error: Failure evidence NOT persisted;")) {
        history.push({ runId: id, message });
      } else importErrors.push(message);
    }
    return { manifest, paused: manifest?.custodyPaused, storageError, dispatch, history,
      planNoticeScope: !manifest && savedPlan ? [canonicalSessionPath(sessionFile), header.id, savedPlan.planId, savedPlan.authority.branchInstanceId] : undefined,
      diagnostics: [...evidence.diagnostics, ...importErrors, ...deliveryDiagnostics(delivery),
        ...(runtime.stopRecovery?.status?.().errors.map(failure => `Supervision paused${failure.runId ? ` (${failure.runId})` : ""}: ${failure.error}`) ?? []),
        ...[...runningSubagents.values()].flatMap(child => child.observationError ? [`${child.name}: ${child.observationError}`] : [])] };
  } catch (error) { return { error: String(error) }; }
}

function pendingParentRecovery(ctx: ExtensionContext): Promise<string | undefined> | undefined {
  const { recoveryInFlight, latestCtx, pi, store } = runtime;
  if (recoveryInFlight && latestCtx?.sessionManager === ctx.sessionManager && recoveryInFlight.ctx === latestCtx &&
      recoveryInFlight.pi === pi && recoveryInFlight.store === store) return recoveryInFlight.operation;
}

function recoverParentRuntime(ctx: ExtensionContext, repair = true, explicitFence?: DispatchRepair): Promise<string | undefined> {
  const pending = pendingParentRecovery(ctx);
  if (pending) return pending;
  const { latestCtx, pi } = runtime;
  const restore = restoreParentRuntime(ctx, repair, explicitFence);
  if (!latestCtx || latestCtx.sessionManager !== ctx.sessionManager || runtime.latestCtx !== latestCtx || runtime.pi !== pi) return restore;
  // Restoration may acquire a store synchronously before awaiting its first
  // child probe. Match the acquired store, and do not join across navigation.
  const flight = { ctx: latestCtx, pi, store: runtime.store, operation: restore.finally(() => {
    if (runtime.recoveryInFlight === flight) runtime.recoveryInFlight = undefined;
  }) };
  runtime.recoveryInFlight = flight;
  return flight.operation;
}

async function restoreParentRuntime(ctx: ExtensionContext, repair: boolean, explicitFence?: DispatchRepair): Promise<string | undefined> {
  if (typeof ctx.sessionManager.getHeader !== "function") return;
  // Pi gives the caller a fresh context object. Capture the active lifecycle
  // context separately so navigation/reload still invalidates this attempt.
  const { latestCtx, pi } = runtime;
  let expectedStore = runtime.store;
  let parent: RuntimeParent | undefined;
  let startupRepair: SubagentRuntime["dispatchRepair"];
  const isCurrent = () => latestCtx?.sessionManager === ctx.sessionManager && runtime.latestCtx === latestCtx &&
    runtime.pi === pi && runtime.store === expectedStore && (!parent || ownsActiveBranch(latestCtx, parent));
  try {
    if (!isCurrent()) throw new Error("Recovery requires the current parent session");
    const header = ctx.sessionManager.getHeader();
    if (!header?.id) return;
    const directory = runtime.store?.directory ?? join(getArtifactDir(ctx.sessionManager.getSessionDir(), header.id), "subagent-runtime");
    const previous = runtime.store?.snapshot() ?? readRuntimeManifest(directory);
    if (!previous) return;
    if (previous.custodyPaused) throw new Error(`Recovery requires an explicit branch decision: ${previous.custodyPaused}`);
    if (!ownsActiveBranch(ctx, previous.parent)) throw new Error("Recovery parent session/active branch mismatch; no custody inherited");
    parent = previous.parent;
    const store = expectedStore ?? new RuntimeStore(directory, parent, candidate => {
      candidate.isCurrent = () => ownsActiveBranch(runtime.latestCtx, previous.parent);
      startupRepair = reconcileDispatchMetadata(ctx, candidate);
      if (startupRepair.storeError) {
        // Do not rotate custody after a journal read/validation or storage
        // failure. Readable run-local conflicts don't block rotation.
        throw Object.assign(new Error(`Dispatch evidence write blocked (${startupRepair.storeError})`), { code: startupRepair.storeError });
      }
    });
    runtime.store = expectedStore = store;
    delivery.store = store;
    store.isCurrent = () => ownsActiveBranch(runtime.latestCtx, previous.parent);
    if (startupRepair) runtime.dispatchRepair = startupRepair;
    else if (repair && !activeDispatchRepair()?.requiresExplicitReconcile) applyDispatchRepair(reconcileDispatchMetadata(ctx, store));
    if (dispatchStorageError(explicitFence)) {
      // A reload/tree restore changes the supervisor's captured context. Do
      // not leave the expired supervisor installed while storage is fenced.
      pauseRecoveredSupervision();
      return;
    }
    const disposition = readDispatchDisposition(ctx, store);
    const manifest = store.snapshot();
    const eventIds = new Set(ctx.sessionManager.getBranch().flatMap((entry) => {
      const message = entry.type === "custom_message" ? entry : entry.type === "message" ? entry.message : undefined;
      const id = (message as any)?.details?.eventId;
      const expected = typeof id === "string" ? manifest.outbox[id]?.envelope.message : undefined;
      return expected && (message as any)?.customType === expected.customType &&
        JSON.stringify((message as any)?.content) === JSON.stringify(expected.content) ? [id] : [];
    }));
    store.assertCustody();
    pauseDeliveries(delivery);
    restoreDurableDeliveries(delivery, store, eventIds);
    for (const [key, settlement] of runtime.suspendedCompletions ?? []) {
      if (settlement.running.durableStore !== store) continue;
      enqueueSubagentCompletion(settlement.running, settlement.result);
      runtime.suspendedCompletions!.delete(key);
      // The suspended observer stopped before re-reading retained evidence.
      // Resume only after the branch-verified enqueue committed its cursor.
      if (settlement.result.keepOpen && settlement.running.abortController &&
          !settlement.running.abortController.signal.aborted) {
        void observeSubagentCompletion(settlement.running,
          watchSubagent(settlement.running, settlement.running.abortController.signal));
      }
    }
    runtime.stopRecovery?.();
    // Only this restoration may work behind the old fence. A new fault replaces
    // its identity and immediately stops the pass; timers never bypass it.
    let restoring = true;
    const stopRecovery = await reconcileRuntime(store, (run, evidence) => {
      // Recovery may commit this event before the preserved live watcher polls.
      const live = runningSubagents.get(run.id);
      if (live?.durableStore === store) live.delegatedContinuation = undefined;
      const running: RunningSubagent = { ...run, durableStore: store, surface: "", interactive: false,
        lifecycle: createLifecycle(run.startTime), runtimePlan: undefined, terminalActionsAllowed: false };
      enqueueSubagentCompletion(running, { ...evidence, name: run.name, task: run.task,
        summary: evidence.summary ?? evidence.errorMessage ?? "Recovered run-bound completion (no immutable summary)",
        sessionFile: run.sessionFile, elapsed: Math.floor((Date.now() - run.startTime) / 1000) });
    }, () => isCurrent() && !dispatchStorageError(restoring ? explicitFence : undefined), {
      maxEventsPerPass: 100, disposition,
      onError: failure => {
        if (!isCurrent()) return;
        const message = `Subagent supervision paused${failure.runId ? ` (${failure.runId})` : ""}: ${failure.error}. Use /subagents-reconcile after fixing storage.`;
        reportDelegationPause(store, message);
        if (latestCtx?.hasUI) latestCtx.ui.notify(message, "warning");
      },
    });
    restoring = false;
    try {
      if (!isCurrent()) throw new Error("Recovery lost current parent session/branch custody");
      const fault = dispatchStorageError(explicitFence);
      if (fault) throw dispatchStoragePause(fault);
      store.assertCustody();
      if (explicitFence) {
        const { errors } = stopRecovery.status();
        if (errors.length) throw new Error(errors[0].error);
      }
    } catch (error) { stopRecovery(); throw error; }
    runtime.stopRecovery = stopRecovery;
    runtime.recoveryError = undefined;
    runtime.recoveryIOError = undefined;
  } catch (error) {
    const message = `Subagent recovery paused: ${String(error)}`;
    if (isCurrent()) {
      if (explicitFence && activeDispatchRepair() === explicitFence && recoveryIOError(error)) {
        latchDispatchStorageFault(explicitFence.store, operationCode(error)!, explicitFence.incidents);
      }
      runtime.recoveryError = message;
      runtime.recoveryIOError = !!startupRepair?.storeError || !!activeDispatchRepair()?.requiresExplicitReconcile || recoveryIOError(error);
      pauseDeliveries(delivery);
      if (latestCtx?.hasUI) latestCtx.ui.notify(message, "warning");
    }
    return message;
  }
}

function detachRuntimeWatchers(): void {
  runtime.stopRecovery?.();
  runtime.stopRecovery = undefined;
  for (const running of runningSubagents.values()) {
    running.terminalActionsAllowed = false;
    const owner = sessionOwners.get(canonicalSessionPath(running.sessionFile));
    if (owner?.runId === running.id) owner.surface = undefined;
  }
}

const delivery = runtime.delivery ??= createDeliveryState();
delivery.handedOff ??= new Set();

function reportDelegationPause(store: RuntimeStore | undefined, reason: string): void {
  if (process.env.PI_SUBAGENT_COMPLETION_MODE !== "explicit" || !store || runtime.store !== store) return;
  const ctx = runtime.latestCtx;
  try {
    if (ctx && ownsActiveBranch(ctx, store.snapshot().parent)) {
      runtime.pi?.events?.emit(DELEGATION_PAUSED, { sessionManager: ctx.sessionManager, reason } satisfies DelegationPause);
    }
  } catch { /* Reporting cannot interrupt the original supervision path. */ }
}

function hasSupervisedContinuation(child: RunningSubagent): boolean {
  const followUp = child.delegatedContinuation;
  if (!followUp) return false;
  const { owner, requestId } = followUp;
  try {
    // A reservation/claim is not acceptance. Read the same run-bound receipt
    // as reconciliation, including late acknowledgements, without clearing a fence.
    return owner.dispatched && owner.runId === child.id && owner.surface === child.surface && !owner.closeRequestId &&
      sessionOwners.get(canonicalSessionPath(child.sessionFile)) === owner && hasAcceptedContinuation(child, requestId);
  } catch { return false; }
}

function enqueueCompletion(running: RunningSubagent, message: Parameters<ExtensionAPI["sendMessage"]>[0], result?: SubagentResult) {
  // Independent event lifecycles preserve failed handoffs across later turns.
  const owner = result?.eventId
    ? { id: running.id, lifecycle: { ...running.lifecycle, delivery: "pending" as const }, source: running }
    : running;
  const bounded = boundSubagentMessage(message, {
    artifactDir: running.durableStore?.directory ?? join(dirname(running.sessionFile), "artifacts", running.id),
    runId: running.id, eventId: result?.eventId ?? "terminal",
    maxReportBytes: config.contextProtection.maxReportBytes, sessionFile: running.sessionFile,
  });
  enqueueDelivery(delivery, owner, bounded, () => {
    if (!result?.keepOpen) runningSubagents.delete(running.id);
    updateWidget();
  }, result?.eventId);
}

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
  return reason === "reload";
}

export function cleanupSubagentsForShutdown(
  reason: unknown,
  agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
  if (shouldPreserveSubagentsOnShutdown(reason)) return;

  for (const agent of agents.values()) {
    if (agent.lifecycle) {
      agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
    }
    agent.abortController?.abort();
  }
  agents.clear();
}

export function shouldDeliverSubagentCompletion(
  running: Pick<RunningSubagent, "lifecycle">,
): boolean {
  // Authoritative gate: only pending deliveries may be sent.
  // Missing lifecycle (pre-migration fixtures) defaults to pending/true.
  return (running.lifecycle?.delivery ?? "pending") === "pending";
}

/** Shared by spawn and resume; transport failures stay inside the outbox. */
export function enqueueSubagentCompletion(running: RunningSubagent, result: SubagentResult): void {
  if (!shouldDeliverSubagentCompletion(running)) return;
  if (running.durableStore && !runtime.latestCtx) {
    // Reload is not custody loss. Preserve the original settlement until a
    // fresh session context proves the branch; never publish through a stale API.
    const key = `${running.id}:${result.eventId ?? "terminal"}`;
    const suspended = runtime.suspendedCompletions ??= new Map();
    if (!suspended.has(key)) suspended.set(key, { running, result: structuredClone(result) });
    return;
  }
  recordHistory(running.lineage, running.id, result.ping ? "ping" : result.errorMessage ? "failure" : "result",
    result.ping?.message ?? result.errorMessage ?? result.summary ?? "Result available",
    result.eventId ?? `${result.sessionFile}:${result.elapsed}`, result.sessionFile ? [result.sessionFile] : []);
  if (result.ping) {
    const followUp = result.keepOpen
      ? "Still supervising delegated work. Use subagent_resume with a response in the existing session; do not launch another writer."
      : `Resume: pi --session ${result.sessionFile}`;
    const sessionRef = `\n\nSession: ${result.sessionFile}\n${followUp}`;
    enqueueCompletion(running, {
      customType: "subagent_ping",
      content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
      display: true,
      details: {
        name: result.ping.name, message: result.ping.message,
        ...(result.keepOpen ? { keepOpen: true } : {}),
        agent: running.agent, sessionFile: result.sessionFile, lineage: running.lineage,
      },
    }, result);
    return;
  }
  const normalized = normalizeStructuredResult(result.structuredResult);
  const resultDiagnostic = normalized.resultDiagnostic ?? result.resultDiagnostic
    ?? (!normalized.structuredResult ? "Unstructured result (optional structure absent or invalid): requires parent review, not acceptance." : undefined);
  const base = resolveResultPresentation(result, running.name, running.id)
    + (normalized.structuredResult ? `\n\nStructured result (proposal, requires parent review):\n${JSON.stringify(normalized.structuredResult, null, 2)}` : "")
    + (resultDiagnostic ? `\n\n${resultDiagnostic}` : "");
  enqueueCompletion(running, {
    customType: "subagent_result",
    content: running.runtimePlan?.runtimeMismatch
      ? `${base}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}` : base,
    display: true,
    details: {
      name: running.name, recipient: "Parent", task: running.task,
      response: result.errorMessage ? `Error: ${result.errorMessage}` : result.summary,
      ...normalized,
      ...(resultDiagnostic ? { resultDiagnostic } : {}),
      keepOpen: result.keepOpen, ...(result.keepOpen === true ? { runId: running.id } : {}),
      agent: running.agent, exitCode: result.exitCode,
      elapsed: result.elapsed, sessionFile: result.sessionFile, lineage: running.lineage,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
      ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
    },
  }, result);
}

export function enqueueSubagentError(running: RunningSubagent, err: unknown, resumed = false): void {
  if (!shouldDeliverSubagentCompletion(running)) return;
  const error = err instanceof Error ? err.message : String(err);
  recordHistory(running.lineage, running.id, "failure", error, "watcher-error", [running.sessionFile]);
  enqueueCompletion(running, {
    customType: "subagent_result",
    content: resumed ? `Resume error: ${error}` : `Sub-agent "${running.name}" error: ${error}`,
    display: true,
    details: {
      name: running.name, recipient: "Parent", task: running.task,
      agent: running.agent, sessionFile: running.sessionFile, lineage: running.lineage, error, response: error,
    },
  });
}

/** Attach the same settlement/dispatch path to spawn and resume watchers. */
export function observeSubagentCompletion(
  running: RunningSubagent,
  completion: Promise<SubagentResult>,
  resume?: { sessionPath: string; entryCountBefore: number },
): Promise<void> {
  const reportError = (error: unknown) => {
    try { enqueueSubagentError(running, error, !!resume); }
    catch (failure) {
      delivery.persistenceError = String(failure);
      reportDelegationPause(running.durableStore, `Subagent result publication paused: ${String(failure)}`);
    }
  };
  return completion.then(
    (result) => {
      if (!shouldDeliverSubagentCompletion(running)) return;
      if (result.supervisionEnded) {
        runningSubagents.delete(running.id);
        updateWidget();
        return;
      }
      try {
        if (resume && !result.eventId) {
          const summary = result.ping ? result.summary
            : findLastAssistantMessage(getNewEntries(resume.sessionPath, resume.entryCountBefore)) ??
              (result.errorMessage ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0 ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
          result = { ...result, summary, sessionFile: resume.sessionPath };
        }
        enqueueSubagentCompletion(running, result);
        // A retained event has not been committed while reload suspends custody.
        // Reattaching now would immediately read it again and starve the loop.
        if (runtime.suspendedCompletions?.has(`${running.id}:${result.eventId ?? "terminal"}`)) return;
        if (result.keepOpen && running.abortController && !running.abortController.signal.aborted) {
          return observeSubagentCompletion(running, watchSubagent(running, running.abortController.signal));
        }
      } catch (err) {
        reportError(err);
      }
    },
    reportError,
  );
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
  const seconds = Math.floor((endTime - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatLifecycleWidgetLabel(
  projection: ReturnType<typeof projectLifecycle>,
  now: number,
): string {
  const duration = projection.stateDurationSince == null
    ? ""
    : ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
  if (projection.kind === "active") return projection.label
    ? ` active · ${projection.label}${duration} `
    : ` active${duration} `;
  if (projection.kind === "blocked") return ` blocked${duration} `;
  if (projection.kind === "running") return " running… ";
  if (projection.kind === "waiting") return ` idle · waiting${duration} `;
  if (projection.kind === "interrupted") return ` interrupted${duration} `;
  if (projection.kind === "stalled") return ` stalled${duration} `;
  // completed/failed exist as lifecycle projections for delivery bookkeeping,
  // but the row is removed immediately after result delivery — so the only
  // visible terminal handoff label is finalizing.
  if (
    projection.kind === "finalizing" ||
    projection.kind === "completed" ||
    projection.kind === "failed"
  ) {
    return " finalizing… ";
  }
  return " starting… ";
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const now = Date.now();
  const rendered = agents.map((agent) => ({ agent, projection: projectLifecycle(ensureLifecycle(agent), now) }));
  const activeCount = rendered.filter(({ projection }) =>
    projection.kind === "active" ||
    projection.kind === "starting" ||
    projection.kind === "running" ||
    projection.kind === "blocked"
  ).length;
  const openCount = agents.length - activeCount;
  const info = activeCount > 0
    ? openCount > 0 ? `${activeCount} active · ${openCount} open` : `${activeCount} active`
    : `${openCount} open`;
  const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

  const lines: string[] = [borderTop("Subagents", info, width, accent)];

  for (const { agent, projection } of rendered) {
    const elapsed = formatElapsedMMSS(agent.startTime, projection.runtimeEndedAt ?? now);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const runtimeTag = agent.runtimePlan
      ? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
      : "";
    const right = config.status.enabled
      ? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
      : agent.cli && agent.cli !== "pi"
        ? ` ${runtimeTag}running… `
        : ` ${runtimeTag}starting… `;

    lines.push(borderLine(left, right, width, accent));
  }

  lines.push(borderBottom(width, accent));
  return lines;
}

function updateWidget() {
  const latestCtx = runtime.latestCtx;
  if (!latestCtx) return;
  try {
    if (!latestCtx.hasUI) return;
  } catch {
    // Ctx went stale (session replacement / reload) mid-flight. Drop it and
    // wait for the next session_start to install a fresh one.
    runtime.latestCtx = undefined;
    return;
  }

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      widgetIntervalSlot.value = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */


function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
  if (running.lifecycle) return running.lifecycle;
  let lifecycle = createLifecycle(running.startTime);
  const driver = getHarnessDriver(running.cli);
  if (!driver.hasActivitySnapshots) {
    lifecycle = markProcessRunning(lifecycle, running.startTime);
    running.lifecycle = lifecycle;
    return lifecycle;
  }
  const state = running.statusState;
  if (state?.activityLabel === "interrupted" && state.localOverrideAtMs != null) {
    lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
  } else if (state?.phase === "done") {
    // Legacy activity "done" means the turn ended, not that completion
    // evidence was recorded. Hydrate as Herdr-style waiting and let the
    // preserved watcher consume sidecar/sentinel evidence.
    const observedAt = state.lastActivityAtMs ?? running.startTime;
    lifecycle = observePaneInspection(
      lifecycle,
      { kind: "present", observedAt, agentStatus: "done" },
      observedAt,
    );
  } else if (state?.phase === "active" || state?.phase === "waiting" || state?.phase === "starting") {
    lifecycle = observeActivity(lifecycle, {
      ok: true,
      activity: {
        version: 1,
        runningChildId: running.id,
        createdAt: running.startTime,
        updatedAt: state.lastActivityAtMs ?? running.startTime,
        sequence: state.lastActivitySequence ?? 0,
        latestEvent: state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
        phase: state.phase,
        agentActive: state.phase === "active",
        turnActive: state.phase === "active",
        providerActive: false,
        toolActive: state.activeScope === "tool",
        ...(state.activeScope ? { activeScope: state.activeScope as any } : {}),
        ...(state.activeSinceMs != null ? { activeSince: state.activeSinceMs } : {}),
        ...(state.waitingSinceMs != null ? { waitingSince: state.waitingSinceMs } : {}),
        ...(state.activityLabel && state.activeScope === "tool" ? { toolName: state.activityLabel } : {}),
      },
    }, state.lastActivityAtMs ?? running.startTime);
  } else if (state?.hasActivitySnapshots === false || running.startTime) {
    // Pre-lifecycle Pi agents without a known phase still get a running process.
    lifecycle = markProcessRunning(lifecycle, running.startTime);
  }
  running.lifecycle = lifecycle;
  return lifecycle;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  ensureLifecycle(running);
  const driver = getHarnessDriver(running.cli);
  if (!driver.hasActivitySnapshots) return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) running.activity = read.activity;
  running.lifecycle = observeActivity(ensureLifecycle(running), read, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function interruptCustodyGuard(running: RunningSubagent, ctx: ExtensionContext | undefined, signal?: AbortSignal): () => void {
  const path = canonicalSessionPath(running.sessionFile);
  const owner = sessionOwners.get(path);
  if (!owner || owner.runId !== running.id) throw new Error("Interrupt requires a currently owned tracked Pi child");
  const runId = running.id, cli = running.cli;
  const store = running.durableStore, parentStore = runtime.store;
  const binding = JSON.stringify(running.planTask);
  const parentSession = ctx?.sessionManager.getSessionFile();
  const parentHeader = ctx?.sessionManager.getHeader?.()?.id;
  const parentCtx = runtime.latestCtx;
  const surface = running.surface, activityFile = running.activityFile;
  return () => {
    signal?.throwIfAborted();
    assertStorageAvailable();
    if (runtime.treeSuspension || running.terminalActionsAllowed === false ||
        running.id !== runId || running.cli !== cli || runningSubagents.get(runId) !== running ||
        sessionOwners.get(path) !== owner || owner.runId !== runId || !owner.dispatched ||
        running.durableStore !== store || runtime.store !== parentStore || JSON.stringify(running.planTask) !== binding ||
        running.surface !== surface || running.activityFile !== activityFile || canonicalSessionPath(running.sessionFile) !== path ||
        runtime.latestCtx !== parentCtx || ctx?.sessionManager.getSessionFile() !== parentSession ||
        ctx?.sessionManager.getHeader?.()?.id !== parentHeader) throw new Error("Interrupt custody/binding/branch changed or is detached/unverified");
    parentStore?.assertCustody();
    if (store !== parentStore) store?.assertCustody();
    if (running.planTask) {
      if (!store || !ctx || !runtime.plans) throw new Error("Task-bound interrupt requires current durable custody");
      const view = runtime.plans.read(ctx.sessionManager);
      const plan = view.snapshot;
      const task = plan?.tasks.find(t => t.taskId === running.planTask!.taskId);
      if (!view.writable || plan?.planId !== running.planTask.planId ||
          JSON.stringify(plan.authority) !== JSON.stringify(running.planTask.authority) ||
          !task?.attempts.some(a => a.attemptId === running.planTask!.attemptId && a.runIds.includes(running.id))) {
        throw new Error("Interrupt task binding is not on the current parent branch");
      }
    }
  };
}

async function requestSubagentInterrupt(
  running: RunningSubagent,
  request: typeof interruptOwnedChild = interruptOwnedChild,
  ctx = runtime.latestCtx,
  signal?: AbortSignal,
  guard?: () => void,
): Promise<InterruptResult | { error: string }> {
  try {
    const validate = guard ?? interruptCustodyGuard(running, ctx, signal);
    validate();
    const owner = sessionOwners.get(canonicalSessionPath(running.sessionFile))!;
    const result = await request(owner, running, { validate, signal });
    validate(); // Never report acknowledgement after losing custody across an await.
    return result;
  } catch (error: any) {
    return { error: `Failed guarded interrupt for subagent "${running.name}": ${error?.message ?? String(error)}` };
  }
}

async function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  request: typeof interruptOwnedChild = interruptOwnedChild,
  ctx = runtime.latestCtx,
  signal?: AbortSignal,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const driver = getHarnessDriver(running.cli);
  if (!driver.supportsTurnInterrupt) {
    return {
      content: [{
        type: "text" as const,
        text:
          `Guarded turn interrupt is currently supported only for Pi-backed subagents. ${driver.name}-backed semantics have not been verified yet.`,
      }],
      details: {
        error: `${running.cli ?? "external"} interrupt unsupported`,
        id: running.id,
        name: running.name,
      },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  let interruption: Awaited<ReturnType<typeof requestSubagentInterrupt>>;
  try {
    const validate = interruptCustodyGuard(running, ctx, signal);
    interruption = await requestSubagentInterrupt(running, request, ctx, signal, validate);
    validate(); // The outer await is a separate custody boundary before status mutation/reporting.
  } catch (error: any) {
    interruption = { error: `Failed guarded interrupt for subagent "${running.name}": ${error?.message ?? String(error)}` };
  }
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  if (interruption.status !== "requested") {
    return {
      content: [{ type: "text" as const, text: interruption.reason ?? `Interrupt ${interruption.status}; no aborted settlement confirmed.` }],
      details: { id: running.id, name: running.name, ...interruption },
    };
  }
  // This remains a LOCAL request marker, not evidence of aborted settlement.
  // Once interrupt is requested this follow-up is no longer a promised wakeup.
  running.delegatedContinuation = undefined;
  running.lifecycle = markInterruptRequested(ensureLifecycle(running), Date.now());
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}". ` +
      (interruption.settlement === "aborted" ? "Child confirmed correlated aborted settlement." : "Aborted settlement is not yet confirmed.") }],
    details: { id: running.id, name: running.name, ...interruption, status: "interrupt_requested" },
  };
}

export function refreshSubagentStatus(now = Date.now()): void {
  for (const running of runningSubagents.values()) {
    // Observation updates lifecycle/panel only. Inactivity is not an explicit blocker.
    observeRunningSubagent(running, now);
    running.lastProjectedKind = projectLifecycle(ensureLifecycle(running), now).kind;
  }
  updateWidget();
}

function startStatusRefresh(_pi: ExtensionAPI) {
  if (!config.status.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (!runtime.latestCtx || runtime.treeSuspension || runtime.recoveryError) return;
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        statusIntervalSlot.value = null;
      }
      return;
    }

    refreshSubagentStatus();

  }, 1000);

  statusIntervalSlot.value = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  buildAvailableAgentCatalog,
  resolveEffectiveSessionMode,
  resolveSubagentPaths,
  resolveLaunchBehavior,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  observeRunningSubagent,
  resolveDenyTools,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  launchSubagent,
  runningSubagents,
  formatElapsed,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  widgetIntervalSlot.value = widgetInterval;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: ExtensionContext["sessionManager"];
    cwd: string;
    isProjectTrusted?: () => boolean;
    model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, modelId: string): any;
      getAvailable?: () => any[];
      getAll?: () => any[];
      hasConfiguredAuth?: (model: any) => boolean;
    };
  },
  parentThinking: ThinkingLevel,
  options?: { surface?: string; signal?: AbortSignal; assertExecution?: () => void },
): Promise<RunningSubagent> {
  options?.signal?.throwIfAborted();
  options?.assertExecution?.();
  const startTime = Date.now();
  const id = randomUUID();

  const agentDefs = params.agent ? loadAgentDefaults(params.agent, authorizedDiscovery(ctx, getAgentConfigDir())) : null;
  if (params.agent && !agentDefs) throw new Error(`Agent '${params.agent}' is unavailable or its project source is not explicitly authorized.`);
  const validateSources = () => {
    if (!params.agent) return;
    const current = loadAgentDefaults(params.agent, authorizedDiscovery(ctx, getAgentConfigDir()));
    if (!current || current.sourcePath !== agentDefs?.sourcePath || current.sourceHash !== agentDefs?.sourceHash) {
      throw new Error("Agent definition/source authorization changed during launch; rediscover before retrying.");
    }
    assertDefinitionAuthorized(ctx, getAgentConfigDir(), current);
  };
  if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
  const runtimePlan = resolveRuntimePlan(
    { model: params.model, thinking: params.thinking },
    {
      model: resolveModelDefault(params.agent, agentDefs?.model, config.models),
      // Frontmatter is free text; resolveRuntimePlan rejects invalid levels.
      thinking: agentDefs?.thinking as ThinkingLevel | undefined,
    },
    { provider: ctx.model.provider, modelId: ctx.model.id, thinking: parentThinking },
    wrapPiModelRegistry(ctx.modelRegistry),
  );
  const effectiveThinking = runtimePlan.thinking;
  const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const driver = getHarnessDriver(agentDefs?.cli ?? "pi");
  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  validateHarnessLaunch(driver, launchBehavior.sessionMode, params.resumeSessionId);
  if (agentDefs?.completionMode === "explicit" && driver.id !== "pi") {
    throw new Error("completion-mode: explicit requires a Pi-backed subagent.");
  }
  driver.validateRuntimePlan?.(runtimePlan, parentThinking);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs, ctx);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const selectedPlan = params.planTask ? runtime.plans!.read(ctx.sessionManager).snapshot : undefined;
  if (selectedPlan) assertLegacyBoundTransport(selectedPlan);
  const store = durableStoreFor(ctx);
  assertFreshDispatchStorage(store);
  const owner = reserveSession(subagentSessionFile, id);
  let planTask: PlanTaskBinding | undefined;
  let operation: DispatchOperation = "prepare-launch";
  try {
  if (params.planTask && !store) throw new Error("Task-bound runs require durable runtime custody");
  const boundTask = selectedPlan?.tasks.find(t => t.taskId === params.planTask!.taskId);
  const assignmentContract = resolveAssignmentContract(params.assignmentContract, boundTask);
  planTask = bindPlanRun(runtime.plans!, ctx as ExtensionContext, id, params.planTask);
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSubagentSurface(params.name, resolveSubagentLayout());
  owner.surface = surface;
  if (params.task) {
    setPaneTask(surface, params.task);
  }
  if (!surfacePreCreated) {
    await delay(getShellReadyDelayMs(), undefined, { signal: options?.signal });
  }
  options?.signal?.throwIfAborted();

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
      parentBranch: ctx.sessionManager.getBranch(),
    });
  }

  const lineage = driver.id === "pi" ? createLineage(ctx.sessionManager, subagentSessionFile,
    targetCwdForSession, artifactDir, store?.snapshot().parent, (type, data) => runtime.pi?.appendEntry(type, data)) : undefined;
  const activityFile = getSubagentActivityFile(artifactDir, id);
  if (driver.hasActivitySnapshots) {
    mkdirSync(dirname(activityFile), { recursive: true });
  }
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = effectiveAutoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = effectiveAutoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = resolveRoleInstructions(agentDefs?.body, params.systemPrompt);
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const effectiveModel = driver.formatModel(runtimePlan);

  const launchContext: SubagentLaunchContext = {
    lineage,
    params: { ...params, id, assignmentContract, task: contractTask(params.task, assignmentContract) },
    agentDefs,
    runtimePlan,
    effectiveModel,
    effectiveThinking,
    parentThinking,
    surface,
    artifactDir,
    sessionDir,
    subagentSessionFile,
    effectiveCwd: targetCwdForSession,
    localAgentDir: effectiveAgentDir,
    effectiveAutoExit,
    effectiveInteractive,
    inheritsConversationContext,
    taskDelivery: launchBehavior.taskDelivery,
    denySet,
    identity,
    identityInSystemPrompt: Boolean(identityInSystemPrompt),
    systemPromptMode,
    roleBlock,
    modeHint,
    summaryInstruction,
    subagentsDir: SUBAGENTS_DIR,
    shellQuote,
  };
  launchContext.launchProfile = resolveLaunchProfile(launchContext, driver.id,
    buildSubagentToolAllowlist(params.tools ?? agentDefs?.tools));
  if (ctx.isProjectTrusted?.() !== true) launchContext.launchProfile.projectTrust = false;
  if (planTask) launchContext.launchProfile.planTask = planTask;
  persistLaunchProfile(launchContext.launchProfile);
  const built = driver.buildCommand(launchContext);

  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

  operation = "persist-prepared";
  const preparedRun = prepareLaunchRun(store, { id, planTask, name: params.name, task: params.task, startTime,
    sessionFile: built.sessionFile ?? subagentSessionFile,
    surface, cli: built.cli, activityFile, sentinelFile: built.sentinelFile,
    launchScriptFile, profile: launchContext.launchProfile, lineage });
  operation = "prepare-transport";
  runScriptInPane(surface, built.command, {
    onDispatch: () => {
      operation = "validate-dispatch";
      options?.signal?.throwIfAborted();
      validateSources();
      assertAgentDirectoryAuthorized(ctx, getAgentConfigDir(), effectiveAgentDir, targetCwdForSession);
      if (planTask) bindPlanRun(runtime.plans!, ctx as ExtensionContext, id, undefined, planTask);
      options?.assertExecution?.();
      assertFreshDispatchStorage(store);
      operation = "persist-intent";
      store?.commitFreshDispatch(id, canonicalSessionPath(preparedRun.sessionFile), planTask); owner.dispatched = true;
      operation = "send-to-terminal";
    },
    scriptPath: launchScriptFile,
    scriptPreamble: (built.launchScriptPreamble ?? [
      `Subagent launch script for ${params.name}`,
      `Generated: ${new Date().toISOString()}`,
      `Surface: ${surface}`,
    ].map(shellComment)).join("\n"),
  });

  operation = "persist-supervised";
  store?.phase(id, "supervised");
  operation = "register-supervision";
  recordHistory(lineage, id, "assignment", params.task, id, [subagentSessionFile, launchScriptFile]);
  const running = registerLaunchedRun(runningSubagents, store, preparedRun, {
    agent: params.agent, hasActivitySnapshots: driver.hasActivitySnapshots === true, runtimePlan,
  });
  return running;
  } catch (error) {
    if (operation !== "prepare-launch" || planTask) handleLaunchFailure(ctx as ExtensionContext, store, planTask,
      { id, sessionFile: subagentSessionFile, name: params.name, task: params.task, startTime }, error, owner.dispatched, operation);
    if (!owner.dispatched) {
      releaseSession(subagentSessionFile, id);
      if (owner.surface && !options?.surface) {
        try { closePane(owner.surface); } catch { /* best-effort cleanup */ }
      }
    }
    throw error;
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, and cleans up the surface.
 * The outbox removes the registry entry only after synchronous handoff.
 */
async function waitForObservedCompletion(running: RunningSubagent, signal: AbortSignal,
  options: Parameters<typeof waitForCompletion>[1]): ReturnType<typeof waitForCompletion> {
  for (;;) {
    try {
      running.observationError = undefined;
      const result = await waitForCompletion(signal, options);
      running.observationError = undefined;
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      running.observationError = `Completion observation paused/uncertain: ${String(error)}. Use /subagents-reconcile after fixing storage.`;
      reportDelegationPause(running.durableStore, running.observationError);
      try { if (runtime.latestCtx?.hasUI) runtime.latestCtx.ui.notify(`${running.name}: ${running.observationError}`, "warning"); } catch { /* Diagnostic observers cannot end supervision. */ }
      // Preserve the child, ownership and exact retained evidence. A failed read
      // is neither child completion nor permission to close its terminal.
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { signal.removeEventListener("abort", aborted); running.retryObservation = undefined; };
        const aborted = () => { cleanup(); reject(signal.reason ?? new Error("Supervision aborted")); };
        running.retryObservation = () => { cleanup(); resolve(); };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;
  const safeClose = () => {
    if (runtime.treeSuspension || running.terminalActionsAllowed === false) return;
    try { running.durableStore?.assertCustody(); } catch { return; }
    closePane(surface);
  };

  try {
    const result = await waitForObservedCompletion(running, signal, {
      intervalMs: 1000,
      sessionFile,
      runId: running.completionRunId,
      retainedEventIds: running.durableStore
        ? () => running.durableStore!.committedEventIds(running.id) : undefined,
      retainedEventIndex: running.completionIndex ??= new RetainedCompletionIndex(),
      sentinelFile: running.sentinelFile,
      readTerminalTail: () => readPaneAsync(surface, 5),
      inspectPane: async () => inspectPane(surface),
      onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
        ensureLifecycle(running);
        running.lifecycle = observePaneInspection(running.lifecycle, inspection, observedAt);
        updateWidget();
      },
      onTick() {
        observeRunningSubagent(running);
      },
    });

    const supervisionEnded = running.hasTurnResult && !result.eventId &&
      (result.reason === "sentinel" || running.lifecycle.pane.kind === "missing");
    const followUpEndedWithoutResult = supervisionEnded && hasSupervisedContinuation(running);
    // Retire on observation, before handoff or acknowledgement. A fast result
    // must not leave a stale wake source when the receipt is read later.
    running.delegatedContinuation = undefined;
    // Only a shell trailer proves process exit; completion delivery alone does not.
    if ((result.reason === "sentinel" && !running.sentinelFile) || running.lifecycle.pane.kind === "missing") {
      releaseSession(sessionFile, running.id);
    }
    if (followUpEndedWithoutResult) {
      reportDelegationPause(running.durableStore, `Subagent "${name}" exited without a retained continuation result.`);
    }
    if (result.keepOpen) running.hasTurnResult = true;
    const detectedAt = Date.now();
    if (!result.keepOpen) running.lifecycle = markCompletionDetected(running.lifecycle, result, detectedAt);
    updateWidget();
    const elapsed = Math.floor((detectedAt - startTime) / 1000);

    const driver = getHarnessDriver(running.cli);
    if (driver.extractResult) {
      const extracted = await driver.extractResult({
        running,
        completionResult: result,
        surface,
        readPane,
        closePane: safeClose,
        artifactDir: dirname(running.launchScriptFile ?? running.sessionFile),
      });

      if (extracted) {
        if (result.keepOpen !== true) safeClose();
        running.lifecycle = result.exitCode === 0
          ? markCompleted(running.lifecycle, Date.now())
          : markFailed(running.lifecycle, result.errorMessage ?? extracted.summary, Date.now(), result.exitCode);

        return {
          name,
          task,
          summary: result.summary ?? extracted.summary,
          structuredResult: result.structuredResult, resultDiagnostic: result.resultDiagnostic,
          eventId: result.eventId, sessionFile,
          exitCode: result.exitCode,
          elapsed,
          ...(extracted.sessionId ? { claudeSessionId: extracted.sessionId } : {}),
          ...extracted.details,
          keepOpen: result.keepOpen,
        };
      }
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      const observed = findObservedSessionRuntime(allEntries);
      if (running.runtimePlan && observed.provider && observed.modelId) {
        const observedModel = `${observed.provider}/${observed.modelId}`;
        const observedThinking =
          observed.thinking === "off" ||
          observed.thinking === "minimal" ||
          observed.thinking === "low" ||
          observed.thinking === "medium" ||
          observed.thinking === "high" ||
          observed.thinking === "xhigh" ||
          observed.thinking === "max"
            ? observed.thinking
            : undefined;
        const mismatch = observedModel !== running.runtimePlan.model
          ? `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`
          : undefined;
        running.runtimePlan = {
          ...running.runtimePlan,
          ...(observedThinking ? { thinking: observedThinking } : {}),
          observed: {
            model: observedModel,
            ...(observedThinking ? { thinking: observedThinking } : {}),
          },
          ...(mismatch ? { runtimeMismatch: mismatch } : {}),
        };
      }
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    if (result.keepOpen !== true) safeClose();
    running.lifecycle = result.keepOpen
      ? { ...markProcessRunning(running.lifecycle, Date.now()), hasWorked: true, turn: { kind: "waiting", startedAt: Date.now() }, activityDetail: null }
      : result.exitCode === 0
        ? markCompleted(running.lifecycle, Date.now())
        : markFailed(running.lifecycle, result.errorMessage ?? summary, Date.now(), result.exitCode);

    return {
      name,
      task,
      summary: result.summary ?? summary,
      structuredResult: result.structuredResult,
      resultDiagnostic: result.resultDiagnostic,
      eventId: result.eventId,
      supervisionEnded,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      keepOpen: result.keepOpen,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    running.delegatedContinuation = undefined;
    try {
      safeClose();
    } catch {}
    running.lifecycle = markFailed(
      running.lifecycle,
      signal.aborted ? "Subagent cancelled." : err?.message ?? String(err),
      Date.now(),
      1,
    );
    updateWidget();

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const explicitCompletion = process.env.PI_SUBAGENT_COMPLETION_MODE === "explicit";
  delivery.onPark = explicitCompletion ? reportDelegationPause : undefined;
  const stopDelegationWaitQuery = explicitCompletion
    ? pi.events?.on(DELEGATION_WAIT_QUERY, (data) => {
      const query = data as DelegationWaitQuery;
      const ctx = runtime.latestCtx;
      const store = runtime.store;
      if (!ctx || query?.sessionManager !== ctx.sessionManager || runtime.pi !== pi || delivery.api !== pi ||
          !store || runtime.recoveryError || activeDispatchRepair()?.storeError || runtime.treeSuspension) return;
      try { store.assertCustody(); } catch { return; }
      // A parked or already delivered result is not a future wakeup. An idle
      // keepOpen process only qualifies for a freshly accepted continuation.
      const pending = [...delivery.pending.values()].some(entry => entry.store === store && !entry.parked &&
        entry.envelope.options.triggerTurn && entry.owner.lifecycle.delivery === "pending" &&
        entry.owner.source?.lifecycle.delivery !== "suppressed");
      const supervised = [...runningSubagents.values()].some(child => child.durableStore === store &&
        child.abortController && !child.abortController.signal.aborted && !child.observationError &&
        child.terminalActionsAllowed !== false && child.lifecycle.delivery === "pending" &&
        (child.lifecycle.process.kind === "starting" || child.lifecycle.process.kind === "running") &&
        (child.hasTurnResult ? hasSupervisedContinuation(child) : child.lifecycle.turn.kind !== "interrupted"));
      if (pending || supervised) query.confirm();
    }) : undefined;
  registerSubagentAssignmentRenderer(pi);
  runtime.plans = registerPlanTools(pi, { publish: false });
  const checkpoints = registerContextCheckpoint(pi, runtime.plans, { publish: false });
  registerContextGuard(pi, config.contextProtection, checkpoints.capture);
  registerPayloadDiagnostics(pi, config.contextProtection);
  const stopPlanHistory = registerPlanHistory(runtime.plans);
  runtime.planImportErrors ??= new Map();
  const pendingImports = new Map<string, { runId: string; envelope: Parameters<NonNullable<DeliveryState["onEnvelope"]>>[1] }>();
  const imported = new Set<string>();
  let importStore: RuntimeStore | undefined;
  let importOffset = 0;
  const importEnvelope = (runId: string, envelope: Parameters<NonNullable<DeliveryState["onEnvelope"]>>[1], explicitFence?: DispatchRepair) => {
    const eventId = String((envelope.message.details as any)?.eventId ?? runId);
    if (imported.has(eventId)) return;
    pendingImports.set(eventId, { runId, envelope });
    if (!canProjectPlan(explicitFence)) return;
    try {
      const store = runtime.store;
      const ctx = runtime.latestCtx;
      const marker = hasAfterIntentMarker(envelope);
      const failureEvent = eventId === dispatchFailureEventId(runId);
      const binding = store?.runBinding(runId) ?? (marker ? undefined : runningSubagents.get(runId)?.planTask);
      if (marker || binding || (failureEvent && store)) {
        if (!ctx) {
          if (marker || (failureEvent && store)) return;
          throw new Error("Parent context unavailable during reload");
        }
        // Consult the current durable cursor even if a stale callback omitted
        // a marker, or if an ordinary result shares a quarantined cursor.
        if (!importPlanEnvelope(runtime.plans!, ctx, binding, runId, envelope,
          store ? dispatchPlanProjection(store, explicitFence) : undefined)) return;
      }
      pendingImports.delete(eventId);
      imported.add(eventId);
      runtime.planImportErrors!.delete(eventId);
      if (eventId.includes(":dispatch-failure:")) runtime.planImportErrors!.delete(runId);
    } catch (error) {
      if (explicitFence && recoveryIOError(error)) latchDispatchStorageFault(explicitFence.store, operationCode(error)!);
      runtime.planImportErrors!.set(eventId, `Task import pending: ${String(error)}`);
    }
  };
  delivery.onEnvelope = importEnvelope;
  const retryPlanImports = (explicitFence?: DispatchRepair) => {
    const store = runtime.store;
    if (store !== importStore) { importStore = store; importOffset = 0; imported.clear(); }
    if (store) {
      // Full ID restoration occurs once per store. Later phases request only the
      // append-only tail, never clone or re-import the historical outbox.
      const ids = store.outboxIdsSince(importOffset);
      importOffset += ids.length;
      for (const id of ids) {
        if (imported.has(id)) continue;
        const event = store.getEvent(id);
        if (event) pendingImports.set(id, { runId: event.runId, envelope: event.envelope });
      }
    }
    for (const { runId, envelope } of pendingImports.values()) importEnvelope(runId, envelope, explicitFence);
  };
  pi.registerCommand("subagents-approve", {
    description: "Approve this project's .pi/agents directory for local subagent definitions",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /subagents-approve");
      const agentDir = getAgentConfigDir();
      assertProjectApprovalPermitted(ctx, agentDir);
      const approval = approveProjectAgentDirectory(agentDir, ctx.cwd);
      if (ctx.hasUI) {
        ctx.ui.notify(
          approval.added
            ? `Approved local subagent definitions: ${approval.path}.`
            : `Local subagent definitions are already approved: ${approval.path}.`,
          "info",
        );
      }
    },
  });
  const reconcile = async (ctx: ExtensionContext) => {
    const latestCtx = runtime.latestCtx;
    const isCurrent = () => !runtime.treeSuspension && latestCtx?.sessionManager === ctx.sessionManager &&
      runtime.latestCtx === latestCtx && runtime.pi === pi;
    let error: string | undefined;
    let view: RecoveryView | undefined;
    let explicitFence: DispatchRepair | undefined;
    try {
      if (!isCurrent()) throw new Error("Reconciliation requires the current parent session");
      const store = runtime.store;
      if (store && (!ownsActiveBranch(ctx, store.snapshot().parent) || store.snapshot().custodyPaused)) throw new Error("Reconciliation requires current branch custody");
      const pending = pendingParentRecovery(ctx);
      if (!pending && store) {
        const fence = activeDispatchRepair();
        const repair = reconcileDispatchMetadata(ctx, store);
        if (fence?.requiresExplicitReconcile && !repair.storeError) {
          // Fresh disposition for this pass, but no public thaw until restoration
          // and the final synchronous checks succeed on this same writer.
          explicitFence = runtime.dispatchRepair = { ...fence, incidents: repair.incidents };
        } else applyDispatchRepair(repair);
      }
      if (pending || !dispatchStorageError(explicitFence)) {
        const supervisor = runtime.stopRecovery;
        const disposition = !pending && !explicitFence && store ? readDispatchDisposition(ctx, store) : undefined;
        const untracked = !pending && !explicitFence && store?.listRuns().some(run => !runningSubagents.has(run.id) && !disposition?.unsent.has(run.id) &&
          !(supervisor && (supervisor.tracks?.(run.id) ?? true)));
        if (pending || !store || explicitFence || runtime.recoveryError || untracked) {
          const failure = await (pending ?? recoverParentRuntime(ctx, !store, explicitFence));
          if (failure) throw new Error(failure);
          const recoveredStore = runtime.store;
          if (!isCurrent() || (store && recoveredStore !== store) ||
              (recoveredStore && !ownsActiveBranch(ctx, recoveredStore.snapshot().parent))) {
            throw new Error("Reconciliation lost current parent session/branch custody");
          }
        } else supervisor?.reconcile(disposition);
      }
      assertStorageAvailable(explicitFence);
      for (const child of runningSubagents.values()) {
        if (!child.retryObservation || child.terminalActionsAllowed === false) continue;
        child.durableStore?.assertCustody();
        child.retryObservation();
      }
      reconcileUnsentDeliveries(delivery);
      retryPlanImports(explicitFence);
      assertStorageAvailable(explicitFence); // Plan proof can itself observe a storage fault.
      if (explicitFence) {
        view = readRecoveryView(ctx, explicitFence);
        assertStorageAvailable(explicitFence);
        const refused = view.error ?? view.storageError ?? view.paused;
        if (refused) throw new Error(refused);
        runtime.dispatchRepair = { store: explicitFence.store, incidents: explicitFence.incidents };
      }
      delivery.api = pi;
      flushDeliveries(delivery);
      if (view) view.diagnostics = [...new Set([...(view.diagnostics ?? []), ...deliveryDiagnostics(delivery)])];
    } catch (failure) {
      if (explicitFence && isCurrent() && activeDispatchRepair() === explicitFence) {
        if (recoveryIOError(failure)) latchDispatchStorageFault(explicitFence.store, operationCode(failure)!, explicitFence.incidents);
        else pauseRecoveredSupervision();
      }
      error = `${operationCode(failure) ?? "RECONCILE_REFUSED"}: ${String(failure)}`;
    }
    view ??= isCurrent() ? readRecoveryView(ctx) : {};
    const blocked = error ?? view.error ?? view.storageError ?? view.paused;
    const allIncidents = view.dispatch ?? [];
    const incidents = allIncidents.slice(0, 10);
    const status = blocked || view.diagnostics?.length || allIncidents.some(item => item.status === "still-blocked") ? "still-blocked"
      : allIncidents.some(item => item.status === "dispatch-unknown") ? "dispatch-unknown" : "resolved";
    const text = [`Reconciliation ${status}; no child was relaunched or sent a command.`,
      ...(blocked ? [`Storage/custody: ${blocked}. See the read-only recovery report before retrying metadata.`] : []),
      ...dispatchReport(view), ...(view.diagnostics ?? []).slice(0, 3), ...recoveryHistory(view)].join("\n");
    return { status, text, incidents };
  };
  pi.registerCommand("subagents-reconcile", {
    description: "Reconcile saved subagent metadata; never relaunches or replays ambiguous dispatch",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /subagents-reconcile");
      const result = await reconcile(ctx);
      if (ctx.hasUI) ctx.ui.notify(result.text, result.status === "resolved" ? "info" : "warning");
    },
  });
  // Reconciliation precedes every publication/restoration phase. Importing an
  // immutable outbox event is idempotent and never re-delivers or wakes a model.
  pi.on("before_agent_start", () => { retryPlanImports(); });
  pi.on("turn_end", () => { retryPlanImports(); });
  pi.on("context", (event) => {
    // Ordinary requests must remain read-only after their actionable boundary.
    // Only emergency post-compaction restoration still needs a context-phase
    // retry, immediately before the read-only fallback is constructed.
    if (event.messages.some(message => message.role === "compactionSummary")) retryPlanImports();
  });
  registerPlanContext(pi, runtime.plans);
  registerCheckpointContext(pi, checkpoints);
  registerRecoveryReport(pi, readRecoveryView);
  registerHistoryView(pi, ctx => join(getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()), "subagent-history"));
  // A factory API is not bound yet. Never fall back to a captured pre-reload API.
  runtime.pi = undefined; // Also invalidate the legacy global runtime field.
  pauseDeliveries(delivery);

  // Capture the UI context for widget updates and restore presentation for
  // subagents whose watchers survived a reload.
  pi.on("session_start", async (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.pi = pi;
    const recoveryFailure = typeof ctx.sessionManager?.getHeader === "function" ? await recoverParentRuntime(ctx) : undefined;
    if (runtime.latestCtx !== ctx) return;
    retryPlanImports();
    notifyRecoveryOnStartup(ctx, readRecoveryView(ctx));
    if (!recoveryFailure && !runtime.recoveryError && !activeDispatchRepair()?.storeError) {
      delivery.api = pi;
      flushDeliveries(delivery);
    }
    runtime.modelCatalog = buildAuthenticatedModelCatalog(
      wrapPiModelRegistry(ctx.modelRegistry),
      24,
      ctx.scopedModels.map(({ model }) => model),
    );
    runtime.agentCatalog = buildAvailableAgentCatalog(
      discoverAgentDefinitions(authorizedDiscovery(ctx, getAgentConfigDir())).filter((agent) => !agent.disableModelInvocation),
    );
    if (runningSubagents.size > 0) {
      startWidgetRefresh();
      startStatusRefresh(pi);
      updateWidget();
    }
  });

  const finishTreeNavigation = async (ctx: ExtensionContext) => {
    if (runtime.treeSuspension) clearInterval(runtime.treeSuspension.timer);
    runtime.treeSuspension = undefined;
    runtime.latestCtx = ctx;
    if (runtime.store && !ownsActiveBranch(ctx, runtime.store.snapshot().parent)) {
      // Only a confirmed lineage change is irreversible. Cancellation, summary
      // abort and summary errors leave the original branch's custody intact.
      runtime.recoveryError = "Subagent custody paused: changed active lineage requires an explicit branch decision";
      runtime.recoveryIOError = false;
      detachRuntimeWatchers();
      cleanupSubagentsForShutdown("tree", runningSubagents);
      try {
        runtime.store.pauseCustody("/tree changed active lineage; explicit reconciliation required");
      } finally {
        runtime.store.close();
        runtime.store = undefined;
        runtime.dispatchRepair = undefined;
        runtime.planImportErrors?.clear();
        delivery.store = undefined;
        delivery.pending.clear();
        delivery.handedOff.clear();
        runtime.suspendedCompletions?.clear();
      }
      return;
    }
    const recoveryFailure = await recoverParentRuntime(ctx);
    if (runtime.latestCtx !== ctx) return;
    if (!recoveryFailure && !runtime.recoveryError && !activeDispatchRepair()?.storeError) { delivery.api = pi; flushDeliveries(delivery); }
  };
  pi.on("session_before_tree", (_event, ctx) => {
    if (runtime.treeSuspension) clearInterval(runtime.treeSuspension.timer);
    pauseDeliveries(delivery);
    // Pi's navigateTree holds its branch-summary controller throughout the
    // operation (including extension handlers), and clears it in finally.
    // ctx.isIdle() includes that controller. There is no tree-failed event:
    // poll the real idle boundary to recover cancellations/errors safely.
    runtime.latestCtx = undefined;
    const suspension = { timer: setInterval(() => {
      if (runtime.treeSuspension !== suspension || !ctx.isIdle()) return;
      void finishTreeNavigation(ctx).catch((error) => {
        runtime.recoveryError = `Subagent tree recovery paused: ${String(error)}`;
        runtime.recoveryIOError = recoveryIOError(error);
        pauseDeliveries(delivery);
      });
    }, 25) };
    runtime.treeSuspension = suspension;
    suspension.timer.unref?.();
  });
  pi.on("session_tree", async (_event, ctx) => {
    await finishTreeNavigation(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.agentCatalog = buildAvailableAgentCatalog(discoverAgentDefinitions(authorizedDiscovery(ctx, getAgentConfigDir()))
      .filter(agent => !agent.disableModelInvocation));
    const guidelines = event.systemPromptOptions.toolGuidelines.subagent ??= [];
    for (const catalog of [runtime.agentCatalog, runtime.modelCatalog]) {
      if (catalog && !guidelines.includes(catalog)) guidelines.push(catalog);
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (event, _ctx) => {
    stopDelegationWaitQuery?.();
    if (explicitCompletion) delivery.onPark = undefined;
    stopPlanHistory();
    // Invalidate session-bound API immediately, including the shutdown/factory gap.
    pauseDeliveries(delivery);
    if (runtime.treeSuspension) clearInterval(runtime.treeSuspension.timer);
    runtime.treeSuspension = undefined;
    runtime.pi = undefined;
    runtime.latestCtx = undefined;
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      widgetIntervalSlot.value = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      statusIntervalSlot.value = null;
    }

    if (!shouldPreserveSubagentsOnShutdown((event as any).reason)) detachRuntimeWatchers();
    cleanupSubagentsForShutdown((event as any).reason, runningSubagents);
    if (!shouldPreserveSubagentsOnShutdown((event as any).reason) && runtime.store) {
      runtime.store.close();
      runtime.store = undefined;
      delivery.store = undefined;
    }
    if (!shouldPreserveSubagentsOnShutdown((event as any).reason)) {
      for (const entry of delivery.pending.values()) {
        entry.owner.lifecycle = markDelivery(entry.owner.lifecycle, "suppressed");
      }
      delivery.pending.clear();
      delivery.handedOff.clear();
      runtime.suspendedCompletions?.clear();
      runtime.modelCatalog = undefined;
      runtime.agentCatalog = undefined;
      runtime.recoveryError = undefined;
      runtime.recoveryIOError = undefined;
      runtime.dispatchRepair = undefined;
      runtime.planImportErrors?.clear();
    }
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_SUBAGENT_ID ? process.env.PI_DENY_TOOLS ?? "" : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);
  const delegatedPath = process.env.PI_SUBAGENT_SESSION;
  const delegatedSession = !!(process.env.PI_SUBAGENT_ID || delegatedPath);
  const requireUnallocatedChild = captureQueueChildFence();

  function assertChildSessionHeader(path: string, sessionId: string): string {
    // Open only after branch + manifest authorization. Inspect at most 64 KiB
    // and parse only the physical first line, never falling through to entries.
    // Nonblocking + regular-file check prevents a replacement FIFO stalling Pi.
    try {
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try {
        if (fstatSync(fd).isFile()) {
          const bytes = Buffer.alloc(64 * 1024);
          let length = 0;
          while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (!count) break;
            const end = bytes.subarray(length, length + count).indexOf(0x0a);
            if (end >= 0) {
              const header = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length + end)));
              if (header?.type === "session" && header.id === sessionId &&
                  Number.isSafeInteger(header.version) && header.version > 0 &&
                  typeof header.cwd === "string" && header.cwd && typeof header.timestamp === "string" && header.timestamp) return header.cwd;
              break;
            }
            length += count;
          }
        }
      } finally { closeSync(fd); }
    } catch { /* A missing, unreadable or malformed header cannot prove identity. */ }
    throw new Error("Owned child Pi session header is missing, invalid, or does not match the recorded session ID.");
  }

  function authorizeChildSession(path: string, ctx: ExtensionContext, selected?: RunningSubagent) {
    if (!delegatedSession) return;
    const store = runtime.store;
    const denied = () => new Error("This tool requires a direct Pi child recorded on the current session branch.");
    if (!store) throw denied();
    const manifest = store.snapshot();
    const validateCustody = () => {
      if (runtime.pi !== pi || runtime.latestCtx?.sessionManager !== ctx.sessionManager || runtime.store !== store ||
          runtime.treeSuspension || manifest.custodyPaused || !delegatedPath ||
          canonicalSessionPath(delegatedPath) !== manifest.parent.sessionFile || !ownsActiveBranch(ctx, manifest.parent) ||
          path === manifest.parent.sessionFile || canonicalSessionPath(path) !== path) throw denied();
      store.assertCustody();
    };
    validateCustody();
    // The caller's manifest and exact immediate-parent lineage are the proof.
    // Neither an arbitrary launch profile nor a root-wide lineage edge is enough.
    // Compare the recorded canonical string without resolving it again: a moved
    // or retargeted link must not transfer authority to a different session.
    const isDirect = (run?: DurableRun) => run?.cli === "pi" && run.phase !== "prepared" && run.sessionFile === path &&
      run.lineage?.child.sessionFile === path && run.lineage.parent.sessionFile === manifest.parent.sessionFile &&
      run.lineage.parent.sessionId === manifest.parent.headerId;
    const owner = sessionOwners.get(path);
    const live = owner && runningSubagents.get(owner.runId);
    if ((selected && selected !== live) || (live && live.durableStore !== store)) throw denied();
    const run = owner ? manifest.runs[owner.runId] : Object.values(manifest.runs).find(isDirect);
    if (!run?.lineage || !isDirect(run)) throw denied();
    const { lineage } = run;
    assertChildSessionHeader(path, lineage.child.sessionId);
    return { lineage, validate: () => {
      validateCustody();
      assertChildSessionHeader(path, lineage.child.sessionId);
    } };
  }

  // A nested coordinator is also a parent of its own children. Custody is
  // determined by the current session/branch, never by ancestor launch markers.
  if (shouldRegister("subagents_reconcile"))
    pi.registerTool({
      name: "subagents_reconcile", label: "Subagent reconciliation",
      description: "Parent-only bounded metadata repair for the current branch. Never launches or sends commands to children. Use subagents_recovery for a read-only report.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const { status, text, incidents } = await reconcile(ctx);
        return { content: [{ type: "text", text }], details: { status, incidents }, isError: status === "still-blocked" };
      },
    });

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptGuidelines: subagentRoutingGuidelines,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        _signal?.throwIfAborted();
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const parentThinking = pi.getThinkingLevel();
        if (
          parentThinking !== "off" &&
          parentThinking !== "minimal" &&
          parentThinking !== "low" &&
          parentThinking !== "medium" &&
          parentThinking !== "high" &&
          parentThinking !== "xhigh" &&
          parentThinking !== "max"
        ) {
          throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
        }
        const running = await launchSubagent(params, ctx, parentThinking, { signal: _signal,
          assertExecution: () => requireUnallocatedChild(ctx.sessionManager) });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        void observeSubagentCompletion(running, watchSubagent(running, watcherAbort.signal));

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            lineage: running.lineage,
            launchScriptFile: running.launchScriptFile,
            model: running.runtimePlan?.model,
            thinking: running.runtimePlan?.thinking,
            runtimePlan: running.runtimePlan,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          const runtime = details?.model
            ? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
            : " — started";
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", runtime),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0] as { text?: unknown } | undefined;
        const text = typeof first?.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Request a guarded abort of the active turn of an owned Pi-backed subagent via its child-issued capability. " +
        "The child process, session and watcher remain alive. interrupt_requested acknowledges the child API request, " +
        "not aborted settlement; settlement reports correlated confirmation separately. No terminal/signal fallback or automatic retry.",
      promptSnippet:
        "Request guarded active-turn cancellation from an owned Pi child; acknowledgement is not aborted settlement. " +
        "No terminal/signal fallback or automatic retry; process, watcher and ownership are preserved.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return handleSubagentInterrupt(params, interruptOwnedChild, ctx, signal);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const first = result.content[0] as { text?: unknown } | undefined;
        const text = typeof first?.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List bundled/global agents and explicitly authorized project-local .pi/agents/. " +
        "Authorized project agents override global ones with the same name.",
      promptSnippet: "Discover named roles from bundled, global and explicitly authorized project sources (not running-child status).",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const list = discoverAgentDefinitions(authorizedDiscovery(ctx, getAgentConfigDir())).filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  if (shouldRegister("subagent_close")) pi.registerTool({
    name: "subagent_close", label: "Close Owned Subagent",
    description: "Explicitly request graceful shutdown of one tracked, owned, idle Pi child (id or exact name). No force kill, cancellation, terminal typing, or legacy/untracked cleanup. Closed means original PID+birth is OS-verified gone, NOT session-wide closure. Pending/uncertain retains ownership; recheck the same id.",
    promptSnippet: "Gracefully close an owned idle Pi subagent when no concrete follow-up remains",
    promptGuidelines: [
      "After receiving a subagent result and before reporting done, review the current plan and concrete remaining actions for each owned idle child. Use subagent_close when no pending review, fixes, retry or other follow-up needs that child. An unrelated unfinished task or hypothetical future question is not a reason to keep it open.",
      "Before using subagent_close, preserve the child's result. Retain a child only for a concrete pending action or an explicit user request, and record that reason in the plan or final handoff. A missing plan or task binding alone does not authorize closure; explicitly user-managed interactive sessions require user authorization to close.",
      "Use subagent_close only for tracked owned idle Pi children, respecting busy state, unsent drafts, pending input, ownership and branch/custody guards. Never bypass these protections with force-kill, terminal typing or interruption of active work for cleanup. If subagent_close is unavailable, rejected, pending or uncertain, report the unresolved status rather than claiming closure; any explicit recheck must use the same id, not a polling loop.",
    ],
    parameters: Type.Object({ id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.id && params.name) throw new Error("Supply owned id OR exact name, not both");
      if (runtime.recoveryError) throw new Error(runtime.recoveryError);
      runtime.store?.assertCustody();
      const receipt = params.id ? closedProcessReceipts.get(params.id) : undefined;
      if (receipt) return { content: [{ type: "text", text: JSON.stringify(receipt.result) }],
        details: { id: receipt.id, name: receipt.name, ...receipt.result } };
      const resolved = resolveInterruptTarget(params);
      if ("error" in resolved) throw new Error(resolved.error);
      const child = resolved.running;
      const path = canonicalSessionPath(child.sessionFile);
      const owner = sessionOwners.get(path);
      if (!owner || owner.runId !== child.id) throw new Error("Only currently owned tracked Pi children can be closed; use manual cleanup for legacy/untracked writers.");
      const store = child.durableStore;
      const binding = JSON.stringify(child.planTask);
      const parentSession = ctx.sessionManager.getSessionFile();
      const validateBinding = () => {
        if (runtime.treeSuspension || child.terminalActionsAllowed === false ||
            child.durableStore !== store || JSON.stringify(child.planTask) !== binding ||
            ctx.sessionManager.getSessionFile() !== parentSession) throw new Error("Close custody/binding/branch changed; ownership retained and no further request dispatched.");
        store?.assertCustody();
        if (child.planTask) {
          const view = runtime.plans!.read(ctx.sessionManager);
          const plan = view.snapshot;
          const task = plan?.tasks.find(t => t.taskId === child.planTask!.taskId);
          if (!view.writable || plan?.planId !== child.planTask.planId ||
              JSON.stringify(plan.authority) !== JSON.stringify(child.planTask.authority) ||
              !task?.attempts.some(a => a.attemptId === child.planTask!.attemptId && a.runIds.includes(child.id))) throw new Error("Close task binding is not on the current parent branch.");
        }
      };
      const validate = () => {
        validateBinding();
        if (runningSubagents.get(child.id) !== child || sessionOwners.get(path) !== owner) {
          throw new Error("Close live ownership changed; no further request dispatched.");
        }
      };
      const validateClosed = (original: ProcessIdentity) => {
        validateBinding();
        const current = probeProcess(original.pid);
        if (current.kind === "unverified" || (current.kind === "present" && sameProcess(current.identity, original))) {
          throw new Error("Close cleanup requires verified original process death.");
        }
        // Absence is normal watcher cleanup, not permission to adopt/evict a
        // different owner (including a replacement using the same run id).
        const live = runningSubagents.get(child.id), reserved = sessionOwners.get(path);
        if ((live && live !== child) || (reserved && reserved !== owner)) {
          throw new Error("Close replacement ownership changed; replacement retained.");
        }
      };
      const result: CloseResult = await closeOwnedChild(owner, child, { validate, validateClosed,
        continuationSettled: (requestId) => { validate(); store?.settleContinuation(child.id, requestId); } });
      if (result.status === "closed") {
        // Give the existing supervisor a bounded chance to retire this run.
        // OS death is already proven; map cleanup is not itself exit evidence.
        // Recheck every fence across these awaits and never touch replacements.
        const deadline = Date.now() + 1500;
        while (runningSubagents.get(child.id) === child && Date.now() < deadline) {
          validateClosed(result.process);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        validateClosed(result.process);
      } else validate();
      if (result.status === "closed") {
        closedProcessReceipts.set(child.id, { id: child.id, name: child.name, result });
        // Bound read-only history across extension reload; no live ownership is evicted.
        if (closedProcessReceipts.size > 128) closedProcessReceipts.delete(closedProcessReceipts.keys().next().value!);
        if (sessionOwners.get(path) === owner) releaseSession(path, child.id);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { id: child.id, name: child.name, ...result } };
    },
  });

  if (shouldRegister("subagent_audit")) pi.registerTool({
    name: "subagent_audit", label: "Audit Subagent Session",
    description: "Read-only OS audit of Pi CLI processes explicitly selecting one canonical session. Supply sessionPath OR owned id/name. In a delegated session, only direct Pi children on the current branch may be audited. Returns at most 32 PID/birth identities, never command lines. Uncertain is not safe; no automatic cleanup.",
    parameters: Type.Object({ sessionPath: Type.Optional(Type.String()), id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) {
      if ((params.sessionPath && (params.id || params.name)) || (params.id && params.name)) throw new Error("Supply sessionPath OR owned id/name (one selector)");
      let path = params.sessionPath;
      let selected: RunningSubagent | undefined;
      if (!path) {
        const target = resolveInterruptTarget(params);
        if ("error" in target) throw new Error(target.error);
        selected = target.running;
        path = selected.sessionFile;
      }
      path = canonicalSessionPath(path, ctx.cwd);
      authorizeChildSession(path, ctx, selected);
      const audit = auditSession(path);
      return { content: [{ type: "text", text: JSON.stringify(audit) }], details: audit };
    },
  });

  function assertResumeWriters(path: string): void {
    const owner = sessionOwners.get(path);
    const child = owner && runningSubagents.get(owner.runId);
    const identity = child && child.cli === "pi" && child.lifecycle.process.kind === "running"
      ? readChildIdentity(path, child.id)?.process : undefined;
    assertSessionWriters(auditSession(path), identity);
  }

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Continue a settled interrupted or keepOpen idle live Pi child in its existing pane, or resume a closed session in a new pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work. In a delegated session, only direct Pi children on the current branch may be resumed.",
      promptSnippet:
        "Continue a settled interrupted or keepOpen idle live Pi child in its existing pane, or resume a closed session in a new pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work. In a delegated session, only direct Pi children on the current branch may be resumed.",
      parameters: Type.Object({
        planTask: Type.Optional(PlanTaskParams),
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Exact follow-up message. Required and nonempty for live interrupted or keepOpen continuation; optional for closed-session resume.",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Must match the saved launch profile if specified. Omit to preserve the original autoExit/interactivity behavior.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content[0] as { text?: unknown } | undefined;
        const text = typeof first?.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        _signal?.throwIfAborted();
        const requestedPath = params.sessionPath;
        params = { ...params, sessionPath: canonicalSessionPath(requestedPath, ctx.cwd) };
        const scope = authorizeChildSession(params.sessionPath, ctx);
        requireUnallocatedChild(ctx.sessionManager);
        const name = params.name ?? "Resume";
        // Fail closed before reading the profile or history of an out-of-scope session.
        const profilePath = launchProfilePath(params.sessionPath);
        const validateProfilePath = () => {
          if (canonicalSessionPath(requestedPath, ctx.cwd) !== params.sessionPath) throw new Error("Resume target path changed during preparation");
          if (scope && canonicalSessionPath(profilePath) !== profilePath) throw new Error("Owned child launch profile path has changed.");
        };
        validateProfilePath();
        const target = captureQueueResumeTarget(params.sessionPath);
        const profile = readPiLaunchProfile(params.sessionPath, { exactPath: true });
        target.verifyIdentity();
        const validateQueueTarget = (expectedProfile = profile, rereadProfile = true) => {
          validateProfilePath();
          target.verifyIdentity();
          requireUnallocatedChild(ctx.sessionManager);
          const current = rereadProfile ? inspectPersistedQueueProfile(params.sessionPath) : undefined;
          if (current) {
            if (hasQueueAllocation(current.value)) denyQueueTransport();
            if (!isDeepStrictEqual(current.value, expectedProfile)) throw new Error("Resume launch profile changed during preparation");
          }
          // Scan last against the original session pin; a same-inode append
          // during earlier reads must be visible. Recheck both observed images.
          const assignment = profile.queueAllocation ? undefined : target.scanAssignment();
          if (!profile.queueAllocation && (assignment?.value || isQueueMarkedSession(params.sessionPath))) denyQueueTransport();
          const verifyAssignment = () => {
            validateProfilePath();
            if (!profile.queueAllocation && isQueueMarkedSession(params.sessionPath)) denyQueueTransport();
            assignment?.verifyImage();
          };
          const verifyImages = () => {
            current?.verifyImage();
            verifyAssignment();
          };
          verifyImages();
          return { verifyAssignment, verifyImages };
        };
        if (scope && !isDeepStrictEqual(profile.lineage, scope.lineage)) throw new Error("Saved launch profile does not match the direct child's recorded lineage.");
        const validateProfileSources = () => {
          validateProfilePath();
          assertAgentDirectoryAuthorized(ctx, getAgentConfigDir(), profile.agentDir, profile.cwd);
          if (profile.role && !profile.definitionSource) throw new Error("Legacy named-agent profile lacks source provenance; start a new subagent with explicit restrictions.");
          assertDefinitionAuthorized(ctx, getAgentConfigDir(), profile.definitionSource ?? {});
        };
        if (params.autoExit !== undefined && params.autoExit !== profile.autoExit) {
          throw new Error("Resume must preserve the saved autoExit/interactivity profile. Start a new subagent to change it.");
        }
        validateProfileSources();
        validateQueueTarget(profile, false); // The initial profile was just read with the verified path.
        if (profile.queueAllocation) {
          // Only the original root's current in-process runtime can attest to
          // the selected branch and the plan/storage fault state. The checks
          // are deliberately independent of the legacy binding/dispatch path.
          const owner = sessionOwners.get(params.sessionPath);
          const child = owner && runningSubagents.get(owner.runId);
          if (!child || !owner) denyQueueTransport(); // No closed queue resume.
          assertStorageAvailable();
          const store = runtime.store;
          const manifest = store?.dispatchCustody();
          const run = store?.getRun(child.id);
          const view = runtime.plans!.read(ctx.sessionManager);
          if (!store || !manifest || manifest.custodyPaused !== undefined || runtime.pi !== pi || runtime.treeSuspension ||
              runtime.latestCtx?.sessionManager !== ctx.sessionManager || pendingParentRecovery(ctx) ||
              !ownsActiveBranch(ctx, manifest.parent) || child.terminalActionsAllowed === false ||
              child.lifecycle.process.kind !== "running" || child.durableStore !== store ||
              child.id !== profile.queueAllocation.rootRunId || !owner.dispatched || owner.surface !== child.surface ||
              owner.closeRequestId || owner.continuationRequestId || run?.continuationRequestId ||
              run?.phase !== "supervised" || run.cli !== "pi" || run.sessionFile !== params.sessionPath ||
              !samePlanBinding(run.planTask, profile.queueAllocation.binding) || !samePlanBinding(child.planTask, run.planTask) ||
              !isDeepStrictEqual(run.profile, profile) || !isDeepStrictEqual(run.lineage, profile.lineage) ||
              !view.writable || !view.snapshot || !profile.lineage ||
              profile.lineage.parent.sessionFile !== manifest.parent.sessionFile ||
              profile.lineage.rootCheckpoint !== manifest.parent.checkpoint || profile.lineage.rootBranchToken !== manifest.parent.branchToken) {
            throw new Error("Active queue resume requires current trusted runtime and the original Pi launch profile");
          }
          assertQueueActiveResume(view.snapshot, profile, assertChildSessionHeader(params.sessionPath, profile.lineage.child.sessionId));
          // The checks above do not issue a permit; do not route through the
          // legacy continuation or publish a request until v2 is wired.
          denyQueueTransport();
        }
        const original = profile.planTask ?? params.planTask;
        const assertResumeDispatchKnown = (savedBinding = profile.planTask) => {
          assertStorageAvailable();
          const store = runtime.store;
          // The active plan may be the only record of an earlier dispatch.
          // Check it before acquiring a store or attaching a replacement run.
          if (!store && typeof ctx.sessionManager.getBranch !== "function") return;
          const header = store ? undefined : ctx.sessionManager.getHeader?.();
          const directory = store?.directory ?? (header?.id ? join(getArtifactDir(ctx.sessionManager.getSessionDir(), header.id), "subagent-runtime") : undefined);
          if (!directory) return;
          store?.assertCustody();
          const manifest = store?.snapshot() ?? readRuntimeManifest(directory);
          if (manifest && (manifest.custodyPaused || !ownsActiveBranch(ctx, manifest.parent))) throw new Error("Resume requires current branch custody");
          const view = runtime.plans!.read(ctx.sessionManager);
          const plan = view.writable ? view.snapshot : undefined;
          // Omitting planTask or using a sidecar without it must not drop a
          // selected queue claim. Use exact target paths and plan-side run IDs.
          const selectedPlan = view.snapshot;
          if (manifest && selectedPlan?.queue) {
            for (const task of selectedPlan.tasks) {
              for (const attempt of task.attempts) {
                const id = attempt.reservation?.runId;
                if (id && manifest.runs[id]?.sessionFile === params.sessionPath) assertLegacyBoundTransport(selectedPlan);
              }
            }
          }
          const evidence = manifest ? readParentDispatchEvidence(directory, manifest, store)
            : { records: new Map<string, DispatchEvidence>(), conflicts: new Set<string>(), diagnostics: [], verifiedFiles: new Set<string>() };
          if (evidence.storeError) throw new Error(`Dispatch evidence unavailable (${evidence.storeError}). Use subagents_reconcile.`);
          const incidents = dispatchIncidents(manifest, plan, directory, evidence);
          // The legacy CAS can bind a closed resume before its first profile
          // write fails. Initial adoption requires an explicit retry of that
          // task and canonical before-send disposition of the old binding.
          const selection = params.planTask;
          const owner = sessionOwners.get(params.sessionPath);
          const retryTask = !profile.planTask && (!owner || !runningSubagents.has(owner.runId)) &&
            plan?.schemaVersion === 1 && selection?.planId === plan.planId
            ? plan.tasks.find(task => task.taskId === selection.taskId && task.status === "in_progress" &&
                task.attempts.at(-1)?.attemptId === selection.attemptId &&
                task.statusHistory.findLast(change => change.status === "in_progress")?.reason === "Parent requested retry") : undefined;
          // Once adopted, the saved binding alone cannot bypass a predecessor.
          // Require a clean, supervised run of the exact current retry in this
          // session. This is historical dispatch proof, not live writer custody.
          const adopted = profile.planTask;
          const adoptedTask = adopted && samePlanBinding(adopted, savedBinding) && manifest && plan?.schemaVersion === 1
            ? plan.tasks.find(task => {
                const attempt = task.attempts.at(-1);
                if (!attempt || !["in_progress", "blocked", "in_review"].includes(task.status) ||
                    task.statusHistory.findLast(change => change.status === "in_progress")?.reason !== "Parent requested retry" ||
                    !samePlanBinding(adopted, { planId: plan.planId, taskId: task.taskId, attemptId: attempt.attemptId, authority: plan.authority })) return false;
                return attempt.runIds.some(id => {
                  const successor = manifest.runs[id];
                  return successor?.phase === "supervised" && successor.sessionFile === params.sessionPath &&
                    samePlanBinding(successor.planTask, adopted) && !incidents.some(item => item.runId === id);
                });
              }) : undefined;
          const currentRetry = retryTask ?? adoptedTask;
          for (const run of Object.values(manifest?.runs ?? {})) {
            if (run.sessionFile !== params.sessionPath) continue;
            if (hasQueueAllocation(run.profile)) denyQueueTransport();
            const binding = run.planTask;
            if (!binding || samePlanBinding(binding, savedBinding)) continue;
            const predecessor = currentRetry?.attempts.slice(0, -1).find(attempt =>
              attempt.attemptId === binding.attemptId && attempt.runIds.includes(run.id));
            if (plan && currentRetry && predecessor && samePlanBinding(binding, { planId: plan.planId, taskId: currentRetry.taskId,
                attemptId: predecessor.attemptId, authority: plan.authority }) && run.profile === undefined &&
                run.continuationRequestId === undefined && !runningSubagents.has(run.id) && run.eventCursor.length === 1 &&
                incidents.some(item => item.runId === run.id && item.status === "resolved" && item.phase === "before-send" && item.evidence === "outbox")) continue;
            throw new Error("Resume requires the original task binding in the saved launch profile. Use subagents_recovery for evidence.");
          }
          const savedAuthority = profile.planTask?.authority;
          const related = original && plan?.planId === original.planId && (!savedAuthority ||
            (plan.authority.sessionId === savedAuthority.sessionId && plan.authority.branchInstanceId === savedAuthority.branchInstanceId))
            ? plan.tasks.find(task => task.taskId === original.taskId)?.attempts.flatMap(attempt => [...attempt.runIds]) : undefined;
          const incident = incidents.find(item => {
            const run = manifest?.runs[item.runId];
            const record = evidence.records.get(item.runId);
            // An after-intent claim cannot bind a second session when the
            // committed run already owns the binding. Ownerless claims and
            // other possible-send evidence keep their conservative fence.
            const journalTarget = (record?.operation === verifyResumeImages ? !run : item.phase !== "before-send") &&
              record?.sessionFile === params.sessionPath;
            return item.status !== "resolved" && (journalTarget || run?.sessionFile === params.sessionPath || related?.includes(item.runId));
          });
          if (incident) throw new Error(`Run ${incident.runId}: ${incident.status}. ${noRetry} Use subagents_recovery for evidence.`);
          return verifiedUnsentRunIds(incidents);
        };
        assertResumeDispatchKnown();
        assertResumeWriters(params.sessionPath);
        const previousOwner = sessionOwners.get(params.sessionPath);
        if (previousOwner?.surface) {
          const inspection = await inspectPane(previousOwner.surface);
          scope?.validate();
          validateQueueTarget();
          assertResumeDispatchKnown();
          // Inspection yielded: never release a replacement owner's reservation.
          if (inspection.kind === "missing" && sessionOwners.get(params.sessionPath) === previousOwner) {
            releaseSession(params.sessionPath, previousOwner.runId);
          }
        } else if (previousOwner && runtime.store && !runningSubagents.has(previousOwner.runId)) {
          releaseRecoveredSession(runtime.store, params.sessionPath, assertResumeDispatchKnown());
        }
        if (scope) authorizeChildSession(params.sessionPath, ctx);
        assertResumeWriters(params.sessionPath);
        const liveOwner = sessionOwners.get(params.sessionPath);
        if (liveOwner && runningSubagents.has(liveOwner.runId)) {
          // Validate caller input before contractTask can turn an empty message
          // into metadata-only work. Closed-session resume remains optional.
          if (typeof params.message !== "string" || !params.message.trim()) {
            throw new Error("Live continuation requires a nonempty message.");
          }
          const child = runningSubagents.get(liveOwner.runId)!;
          if (runtime.treeSuspension || child.terminalActionsAllowed === false) throw new Error("Live continuation requires verified terminal custody");
          const continuationContract = resolveResumeContract(runtime.plans!, ctx, profile.assignmentContract,
            params.planTask, child.planTask ?? profile.planTask);
          const continuationParams = { ...params, message: contractTask(params.message, continuationContract) };
          const validateContinuationCustody = () => {
            scope?.validate();
            if (runtime.treeSuspension || child.terminalActionsAllowed === false || child.durableStore !== runtime.store ||
                sessionOwners.get(params.sessionPath) !== liveOwner || liveOwner.runId !== child.id ||
                liveOwner.surface !== child.surface || !liveOwner.dispatched) {
              throw new Error("Continuation custody changed");
            }
            child.durableStore?.assertCustody();
          };
          const result = await continueLiveChild(liveOwner, child, continuationParams, {
            inspect: inspectPane,
            settled: (requestId) => {
              validateContinuationCustody();
              child.durableStore?.settleContinuation(child.id, requestId);
            },
            beforeSend: (requestId) => {
              validateContinuationCustody();
              if (runningSubagents.get(child.id) !== child) throw new Error("Continuation child is no longer tracked");
              _signal?.throwIfAborted();
              validateProfileSources();
              assertResumeDispatchKnown();
              assertResumeWriters(params.sessionPath);
              resolveResumeContract(runtime.plans!, ctx, continuationContract, params.planTask, child.planTask ?? profile.planTask);
              let provenance = validateQueueTarget();
              child.planTask = bindPlanRun(runtime.plans!, ctx, child.id, params.planTask, child.planTask);
              if (child.planTask) {
                if (!child.durableStore) throw new Error("Task-bound continuation requires durable custody");
                child.durableStore.bindRun(child.id, child.planTask, continuationContract);
                persistProfileBinding(child.sessionFile, child.planTask, continuationContract);
              }
              scope?.validate();
              // A legacy v1 binding can deliberately rewrite its profile.
              if (child.planTask) {
                provenance.verifyAssignment();
                provenance = validateQueueTarget({ ...profile, planTask: child.planTask,
                  ...(continuationContract ? { assignmentContract: continuationContract } : {}) });
              } else provenance.verifyImages();
              child.durableStore?.continuation(child.id, requestId);
              // Recheck the images after intent persistence and request staging,
              // immediately before the rename that wakes the child watcher.
              return () => {
                requireUnallocatedChild(ctx.sessionManager);
                provenance.verifyImages();
                if (explicitCompletion && child.hasTurnResult) child.delegatedContinuation = { requestId, owner: liveOwner };
              };
            },
          });
          recordHistory(child.lineage, child.id, "continuation", `Parent continuation (${result.status}): ${params.message ?? ""}`,
            result.requestId, [child.sessionFile]);
          return {
            content: [{ type: "text", text: result.status === "accepted"
              ? `Session "${child.name}" continued in its existing process.`
              : `Continuation ${result.requestId} is pending/uncertain. Do not retry or launch a replacement; the existing watcher remains active.` }],
            details: { id: child.id, name: child.name, sessionPath: child.sessionFile,
              lineage: child.lineage, requestId: result.requestId, status: result.status === "accepted" ? "continued" : "pending" },
          };
        }
        const startTime = Date.now();
        const id = randomUUID();

        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        assertResumeDispatchKnown();
        // Read-only preflight before acquiring durable custody: a historical
        // plan must not leave a writer, manifest or checkpoint behind.
        const assignmentContract = resolveResumeContract(runtime.plans!, ctx, profile.assignmentContract, params.planTask, profile.planTask);
        const store = durableStoreFor(ctx);
        const owner = reserveSession(params.sessionPath, id);
        let planTask: PlanTaskBinding | undefined;
        let operation: DispatchOperation = "prepare-launch";
        try {
        if ((params.planTask || profile.planTask) && !store) throw new Error("Task-bound runs require durable runtime custody");
        planTask = bindPlanRun(runtime.plans!, ctx, id, params.planTask, profile.planTask);
        // Preserve the original binding, never infer authority from the selected branch.
        const resumeProfile = { ...profile, ...(planTask ? { planTask } : {}), ...(assignmentContract ? { assignmentContract } : {}) };
        validateProfilePath();
        if (planTask) persistProfileBinding(params.sessionPath, planTask, assignmentContract);
        scope?.validate();
        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const surface = createSubagentSurface(name, resolveSubagentLayout());
        owner.surface = surface;
        if (params.message) {
          setPaneTask(surface, params.message);
        }
        await delay(getShellReadyDelayMs(), undefined, { signal: _signal });
        _signal?.throwIfAborted();
        scope?.validate();
        validateProfilePath();
        target.verifyIdentity();
        store?.assertCustody();
        if (sessionOwners.get(params.sessionPath) !== owner) throw new Error("Session ownership changed during launch preparation");
        assertResumeWriters(params.sessionPath);

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });
        const resumeContext = resumeLaunchContext(resumeProfile, {
          id, name, message: params.message, surface, artifactDir,
          subagentsDir: SUBAGENTS_DIR, shellQuote,
        });
        resumeContext.denyProjectConfig = ctx.isProjectTrusted?.() !== true;
        const built = getHarnessDriver("pi").buildCommand(resumeContext);
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${id}.sh`,
        );
        operation = "persist-prepared";
        const preparedRun = prepareLaunchRun(store, { id, planTask, name, task: params.message ?? "resumed session", startTime,
          sessionFile: params.sessionPath, surface, cli: "pi", activityFile,
          launchScriptFile, profile: resumeProfile, lineage: resumeProfile.lineage, entryCountBefore });
        operation = "prepare-transport";
        runScriptInPane(surface, built.command, {
          onDispatch: () => {
            operation = "validate-dispatch";
            _signal?.throwIfAborted();
            scope?.validate();
            validateProfileSources();
            assertResumeDispatchKnown(planTask ?? profile.planTask);
            assertResumeWriters(params.sessionPath);
            resolveResumeContract(runtime.plans!, ctx, assignmentContract, undefined, planTask);
            if (planTask) bindPlanRun(runtime.plans!, ctx, id, undefined, planTask);
            scope?.validate();
            const provenance = validateQueueTarget(resumeProfile);
            operation = "persist-intent";
            store?.commitFreshDispatch(id, params.sessionPath, planTask);
            // Only this final, synchronous check runs after intent but before
            // marking the transport possibly sent. Preserve that distinction.
            if (store) operation = verifyResumeImages;
            provenance.verifyImages();
            owner.dispatched = true;
            operation = "send-to-terminal";
          },
          scriptPath: launchScriptFile,
          scriptPreamble: built.launchScriptPreamble?.join("\n"),
        });

        // Register as a running subagent for widget tracking
        operation = "persist-supervised";
        store?.phase(id, "supervised");
        operation = "register-supervision";
        recordHistory(profile.lineage, id, "continuation", `Parent closed-session resume: ${params.message ?? ""}`,
          id, [params.sessionPath, launchScriptFile]);
        const running: RunningSubagent = registerLaunchedRun(runningSubagents, store, preparedRun, {
          agent: profile.role ?? undefined, hasActivitySnapshots: true,
        });
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        void observeSubagentCompletion(running, watchSubagent(running, watcherAbort.signal), {
          sessionPath: params.sessionPath, entryCountBefore,
        });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            lineage: profile.lineage,
            launchScriptFile,
            status: "started",
          },
        };
        } catch (error) {
          if (operation !== "prepare-launch" || planTask) handleLaunchFailure(ctx, store, planTask,
            { id, sessionFile: params.sessionPath, name, task: params.message ?? "resumed session", startTime }, error, owner.dispatched, operation);
          if (!owner.dispatched) {
            // Release the exact reservation, not whatever a changed path now resolves to.
            if (sessionOwners.get(params.sessionPath) === owner) sessionOwners.delete(params.sessionPath);
            if (owner.surface) {
              try { closePane(owner.surface); } catch { /* best-effort cleanup */ }
            }
          }
          throw error;
        }
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName, authorizedDiscovery(ctx, getAgentConfigDir()));
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details?.name ?? "subagent";
        const exitCode = details?.exitCode ?? 0;
        const errorMessage = typeof details?.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage || details?.error != null;
        const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : details?.error != null
            ? "failed"
            : failed
              ? `failed (exit ${exitCode})`
              : "completed";
        const sender = `${name}${details?.agent ? ` (${details.agent})` : ""}`;
        const agentTag = details?.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Older persisted messages have no structured response; retain their content.
        const response = typeof details?.response === "string" ? details.response : summary;
        const contentLines = [
          header,
          `${theme.bold("From:")} ${name}${agentTag}`,
          `${theme.bold("To:")} ${details?.recipient ?? "Parent"}`,
          "",
          theme.bold("Task:"),
          typeof details?.task === "string" ? details.task : "(not recorded)",
          "",
          theme.bold("Response:"),
          response || "(no response)",
        ];
        if (options.expanded) {
          const proposal = normalizeStructuredResult(details?.structuredResult).structuredResult;
          if (proposal) {
            const preview = truncateHead(JSON.stringify(proposal, null, 2), { maxBytes: 4096, maxLines: 60 });
            contentLines.push("", theme.bold("Structured proposal (not acceptance):"), preview.content);
            if (preview.truncated) contentLines.push(theme.fg("dim", "Proposal preview truncated; inspect the recorded result for full details."));
          }
          if (typeof details?.resultDiagnostic === "string") {
            contentLines.push("", theme.fg("warning", details.resultDiagnostic.slice(0, 1024)));
          }
        }
        if (details?.keepOpen === true) {
          const guidance = typeof details.runId === "string" ? keepOpenGuidance(details.runId) : "Pane stayed open for follow-up conversation.";
          contentLines.push("", theme.fg("dim", guidance));
        }
        if (details?.runtimePlan?.runtimeMismatch && typeof details?.response === "string") {
          contentLines.push("", theme.fg("warning", `Runtime warning: ${details.runtimePlan.runtimeMismatch}`));
        }
        if (options.expanded && details?.sessionFile) {
          contentLines.push("", theme.fg("dim", `Session: ${details.sessionFile}`));
          if (details.keepOpen !== true) contentLines.push(theme.fg("dim", `Resume: pi --session ${details.sessionFile}`));
        }

        return ["", ...framedMessage(`Message from ${sender}`, contentLines.join("\n"), bgFn).render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  registerPlanCommand(pi, {
    skillPath: join(SUBAGENTS_DIR, "plan-skill.md"),
    discoverRoles: ctx => discoverAgentDefinitions(authorizedDiscovery(ctx, getAgentConfigDir())),
    terminalAvailable: isTerminalAvailable,
    terminalHint: terminalSetupHint,
  });
}
