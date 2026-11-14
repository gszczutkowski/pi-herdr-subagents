import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { ACTIVE_ACCENT, OPEN_ACCENT, borderLine, borderTop, borderBottom, framedMessage } from "./frame.ts";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSubagentCwd } from "./paths.ts";
import { persistLaunchProfile, persistProfileBinding, readPiLaunchProfile, resolveLaunchProfile, resumeLaunchContext } from "./launch-profile.ts";
import { continueLiveChild } from "./live-continuation.ts";
import { createLineage, type Lineage } from "./lineage.ts";
import { recordHistory, registerPlanHistory } from "./history.ts";
import { registerHistoryView } from "./history-view.ts";
import { RuntimeStore, readRuntimeManifest, type RuntimeParent } from "./runtime-store.ts";
import { reconcileRuntime } from "./runtime-recovery.ts";
import type { SubagentLaunchContext } from "./harness/types.ts";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isTerminalAvailable,
  terminalSetupHint,
  createSubagentSurface,
  resolveSubagentLayout,
  runScriptInPane,
  runInPane,
  closePane,
  interruptPane,
  shellQuote,
  readPane,
  readPaneAsync,
  inspectPane,
  setPaneTask,
} from "./terminal.ts";
import { waitForCompletion } from "./completion.ts";
import { canonicalSessionPath, reserveSession, releaseSession, sessionOwners } from "./ownership.ts";
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
import { resolveModelDefault, type ModelConfig } from "./model-config.ts";
import { getSubagentConfig } from "./config.ts";

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
import { registerPlanTools } from "./plan-tools.ts";
import type { PlanPersistence } from "./plan-persistence.ts";
import { AssignmentContractSchema, resolveAssignmentContract, contractTask, normalizeStructuredResult, type StructuredResult } from "./contracts.ts";
import { PlanTaskParams, bindPlanRun, importPlanEnvelope, recordDispatchFailure, type PlanTaskBinding } from "./plan-runtime.ts";
import { registerPlanCommand } from "./plan-preflight.ts";
import { createDeliveryState, enqueueDelivery, flushDeliveries, pauseDeliveries, restoreDurableDeliveries, type DeliveryState } from "./delivery.ts";
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
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
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
    Type.String({ description: "Appended to system prompt (role instructions)" }),
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

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
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

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  // Git checkouts and Windows editors may use CRLF, including mixed line endings.
  content = content.replace(/\r\n/g, "\n");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    commandTemplate:
      getFrontmatterValue(frontmatter, "command") ??
      getFrontmatterValue(frontmatter, "command-template"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      try {
        const parsed = parseAgentDefinition(
          readFileSync(join(dir, file), "utf8"),
          file.replace(/\.md$/, ""),
        );
        if (!parsed) continue;
        agents.set(parsed.name, { ...parsed, source });
      } catch {
        // Skip unreadable or racy entries rather than aborting discovery
        // for every other agent definition.
      }
    }
  }

  return [...agents.values()];
}

function buildAvailableAgentCatalog(
  agents: ListedAgentDefinition[],
  limit = 24,
  modelConfig: ModelConfig = config.models,
): string {
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const visible = sorted.slice(0, limit);
  const lines = [
    "Available named subagents (choose by role; omit model/thinking to use agent defaults):",
  ];

  for (const agent of visible) {
    const effectiveModel = resolveModelDefault(agent.name, agent.model, modelConfig);
    const defaults = [
      effectiveModel ? `model ${effectiveModel}` : undefined,
      agent.thinking ? `thinking ${agent.thinking}` : undefined,
    ].filter(Boolean);
    const runtime = defaults.length > 0 ? `; defaults: ${defaults.join(", ")}` : "";
    const description = agent.description ? ` — ${agent.description}` : "";
    lines.push(`- ${agent.name} [${agent.source}${runtime}]${description}`);
  }

  if (visible.length === 0) lines.push("- none discovered; use a bare spawn");
  if (sorted.length > visible.length) {
    lines.push(`- … ${sorted.length - visible.length} more named subagents omitted`);
  }

  return lines.join("\n");
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = resolveSubagentCwd(rawCwd, cwdBase);
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
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

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  // Resolve through the same name-keyed map discoverAgentDefinitions() builds
  // for the tool-guidance catalog, so a name advertised there always resolves
  // to the same definition here — even when an agent's frontmatter `name`
  // differs from its filename.
  return discoverAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
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

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage" | "keepOpen"
  >,
  name: string,
): string {
  const followUp = result.keepOpen === true ? "\n\nThe child remains supervised for follow-up; subsequent results return here. Use subagent_resume with a message, or type in its pane. Close the child process to end supervision." : "";
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}${followUp}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}${followUp}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}${followUp}`;
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
  stopRecovery?: () => void;
  recoveryError?: string;
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
const runtime: SubagentRuntime =
  (globalThis as any)[RUNTIME_KEY] ??
  ((globalThis as any)[RUNTIME_KEY] = createSubagentRuntime());
const runningSubagents = runtime.runningSubagents;

/** Lazily establish branch custody before any child dispatch. */
function durableStoreFor(ctx: ExtensionContext): RuntimeStore | undefined {
  // Legacy host/test adapters cannot claim durable recovery support.
  if (typeof ctx.sessionManager.getHeader !== "function" || typeof ctx.sessionManager.getBranch !== "function") return undefined;
  if (runtime.recoveryError) throw new Error(runtime.recoveryError);
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
  store.isCurrent = () => ownsActiveBranch(runtime.latestCtx, store.snapshot().parent);
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

async function recoverParentRuntime(ctx: ExtensionContext): Promise<void> {
  if (typeof ctx.sessionManager.getHeader !== "function") return;
  try {
    const header = ctx.sessionManager.getHeader();
    if (!header?.id) return;
    const directory = join(getArtifactDir(ctx.sessionManager.getSessionDir(), header.id), "subagent-runtime");
    const manifest = runtime.store?.snapshot() ?? readRuntimeManifest(directory);
    if (!manifest) return;
    if (manifest.custodyPaused) throw new Error(`Recovery requires an explicit branch decision: ${manifest.custodyPaused}`);
    if (!ownsActiveBranch(ctx, manifest.parent)) throw new Error("Recovery parent session/active branch mismatch; no custody inherited");
    const store = runtime.store ?? new RuntimeStore(directory, manifest.parent);
    runtime.store = store;
    delivery.store = store;
    store.isCurrent = () => ownsActiveBranch(runtime.latestCtx, manifest.parent);
    const eventIds = new Set(ctx.sessionManager.getBranch().flatMap((entry) => {
      const message = entry.type === "custom_message" ? entry : entry.type === "message" ? entry.message : undefined;
      const id = (message as any)?.details?.eventId;
      const expected = typeof id === "string" ? manifest.outbox[id]?.envelope.message : undefined;
      return expected && (message as any)?.customType === expected.customType &&
        JSON.stringify((message as any)?.content) === JSON.stringify(expected.content) ? [id] : [];
    }));
    store.assertCustody();
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
    const stopRecovery = await reconcileRuntime(store, (run, evidence) => {
      const running: RunningSubagent = { ...run, durableStore: store, surface: "", interactive: false,
        lifecycle: createLifecycle(run.startTime), runtimePlan: undefined, terminalActionsAllowed: false };
      enqueueSubagentCompletion(running, { ...evidence, name: run.name, task: run.task,
        summary: evidence.summary ?? evidence.errorMessage ?? "Recovered run-bound completion (no immutable summary)",
        sessionFile: run.sessionFile, elapsed: Math.floor((Date.now() - run.startTime) / 1000) });
    }, () => runtime.store === store && ownsActiveBranch(runtime.latestCtx, manifest.parent));
    if (runtime.store !== store || !ownsActiveBranch(runtime.latestCtx, manifest.parent)) { stopRecovery(); return; }
    runtime.stopRecovery = stopRecovery;
    store.assertCustody();
  } catch (error) {
    if (runtime.latestCtx !== ctx) return;
    runtime.recoveryError = `Subagent recovery paused: ${String(error)}`;
    pauseDeliveries(delivery);
    if (ctx.hasUI) ctx.ui.notify(runtime.recoveryError, "warning");
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

function enqueueCompletion(running: RunningSubagent, message: Parameters<ExtensionAPI["sendMessage"]>[0], result?: SubagentResult) {
  // Independent event lifecycles preserve failed handoffs across later turns.
  const owner = result?.eventId
    ? { id: running.id, lifecycle: { ...running.lifecycle, delivery: "pending" as const }, source: running }
    : running;
  enqueueDelivery(delivery, owner, message, () => {
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
    result.eventId ?? `${result.sessionFile}:${result.elapsed}`, [result.sessionFile]);
  if (result.ping) {
    const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
    enqueueCompletion(running, {
      customType: "subagent_ping",
      content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
      display: true,
      details: {
        name: result.ping.name, message: result.ping.message,
        agent: running.agent, sessionFile: result.sessionFile, lineage: running.lineage,
      },
    }, result);
    return;
  }
  const normalized = normalizeStructuredResult(result.structuredResult);
  const resultDiagnostic = normalized.resultDiagnostic ?? result.resultDiagnostic
    ?? (!normalized.structuredResult ? "Unstructured result (optional structure absent or invalid): requires parent review, not acceptance." : undefined);
  const base = resolveResultPresentation(result, running.name)
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
      keepOpen: result.keepOpen, agent: running.agent, exitCode: result.exitCode,
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
    catch (failure) { delivery.persistenceError = String(failure); }
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
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
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

function requestSubagentInterrupt(
  running: RunningSubagent,
  interruptPaneKey: (surface: string) => void = interruptPane,
): { ok: true } | { error: string } {
  try {
    if (runtime.treeSuspension || running.terminalActionsAllowed === false) throw new Error("Terminal custody is detached/unverified");
    running.durableStore?.assertCustody();
    interruptPaneKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  interruptPaneKey: (surface: string) => void = interruptPane,
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
          `Turn-only Escape interrupt is currently supported only for Pi-backed subagents. ${driver.name}-backed semantics have not been verified yet.`,
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

  const interruption = requestSubagentInterrupt(running, interruptPaneKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
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
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    refreshSubagentStatus();

  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
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
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
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
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, modelId: string): any;
      getAvailable?: () => any[];
      getAll?: () => any[];
      hasConfiguredAuth?: (model: any) => boolean;
    };
  },
  parentThinking: ThinkingLevel,
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = randomUUID();

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
  const runtimePlan = resolveRuntimePlan(
    { model: params.model, thinking: params.thinking },
    {
      model: resolveModelDefault(params.agent, agentDefs?.model, config.models),
      thinking: agentDefs?.thinking,
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
  driver.validateRuntimePlan?.(runtimePlan, parentThinking);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
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

  const store = durableStoreFor(ctx);
  const owner = reserveSession(subagentSessionFile, id);
  let planTask: PlanTaskBinding | undefined;
  try {
  if (params.planTask && !store) throw new Error("Task-bound runs require durable runtime custody");
  const boundTask = params.planTask ? runtime.plans!.read((ctx as ExtensionContext).sessionManager).snapshot?.tasks.find(t => t.taskId === params.planTask!.taskId) : undefined;
  const assignmentContract = resolveAssignmentContract(params.assignmentContract, boundTask);
  planTask = bindPlanRun(runtime.plans!, ctx as ExtensionContext, id, params.planTask);
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSubagentSurface(params.name, resolveSubagentLayout());
  owner.surface = surface;
  if (params.task) {
    setPaneTask(surface, params.task);
  }
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
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
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
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

  store?.prepare({ id, planTask, name: params.name, task: params.task, startTime,
    sessionFile: canonicalSessionPath(built.sessionFile ?? subagentSessionFile),
    surface, cli: built.cli, activityFile, sentinelFile: built.sentinelFile,
    launchScriptFile, profile: launchContext.launchProfile, lineage });
  runScriptInPane(surface, built.command, {
    onDispatch: () => {
      if (planTask) bindPlanRun(runtime.plans!, ctx as ExtensionContext, id, undefined, planTask);
      store?.phase(id, "dispatch-intent"); owner.dispatched = true;
    },
    scriptPath: launchScriptFile,
    scriptPreamble: (built.launchScriptPreamble ?? [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Surface: ${surface}`,
    ]).join("\n"),
  });

  store?.phase(id, "supervised");
  recordHistory(lineage, id, "assignment", params.task, id, [subagentSessionFile, launchScriptFile]);
  const running: RunningSubagent = {
    planTask,
    durableStore: store,
    lineage,
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: built.sessionFile ?? subagentSessionFile,
    launchScriptFile,
    cli: built.cli,
    sentinelFile: built.sentinelFile,
    completionRunId: id,
    interactive: effectiveInteractive,
    runtimePlan,
    activityFile: driver.hasActivitySnapshots ? activityFile : undefined,
    lifecycle: !driver.hasActivitySnapshots
      ? markProcessRunning(createLifecycle(startTime), Date.now())
      : createLifecycle(startTime),
  };

  runningSubagents.set(id, running);
  return running;
  } catch (error) {
    try { recordDispatchFailure(runtime.plans!, runtime.latestCtx ?? ctx as ExtensionContext, planTask, id, error,
      store, { id, sessionFile: subagentSessionFile, name: params.name, task: params.task, startTime }, owner.dispatched); }
    catch (importError) {
      (runtime.planImportErrors ??= new Map()).set(id, `Dispatch failed/uncertain; task import pending: ${String(importError)}`);
      if (String(importError).includes("NOT persisted")) {
        runtime.recoveryError = String(importError);
        if (error instanceof Error) error.message += `; ${String(importError)}`;
      }
    }
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
    const result = await waitForCompletion(signal, {
      intervalMs: 1000,
      sessionFile,
      runId: running.completionRunId,
      retainedEventIds: running.durableStore
        ? () => running.durableStore!.snapshot().runs[running.id].eventCursor : undefined,
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

    // Only a shell trailer proves process exit; completion delivery alone does not.
    if ((result.reason === "sentinel" && !running.sentinelFile) || running.lifecycle.pane.kind === "missing") {
      releaseSession(sessionFile, running.id);
    }
    const supervisionEnded = running.hasTurnResult && !result.eventId &&
      (result.reason === "sentinel" || running.lifecycle.pane.kind === "missing");
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
          summary: result.structuredResult?.summary ?? result.summary ?? extracted.summary,
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
      summary: result.structuredResult?.summary ?? result.summary ?? summary,
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
  registerSubagentAssignmentRenderer(pi);
  runtime.plans = registerPlanTools(pi);
  const stopPlanHistory = registerPlanHistory(runtime.plans);
  runtime.planImportErrors ??= new Map();
  delivery.onEnvelope = (runId, envelope) => {
    const binding = runtime.store?.snapshot().runs[runId]?.planTask ?? runningSubagents.get(runId)?.planTask;
    if (!binding) return;
    const eventId = String((envelope.message.details as any)?.eventId ?? runId);
    try {
      if (!runtime.latestCtx) throw new Error("Parent context unavailable during reload");
      runtime.store?.assertCustody();
      importPlanEnvelope(runtime.plans!, runtime.latestCtx, binding, runId, envelope);
      runtime.planImportErrors!.delete(eventId);
    } catch (error) { runtime.planImportErrors!.set(eventId, `Task import pending: ${String(error)}`); }
  };
  const retryPlanImports = () => {
    for (const event of Object.values(runtime.store?.snapshot().outbox ?? {})) delivery.onEnvelope?.(event.runId, event.envelope);
  };
  pi.on("context", () => { retryPlanImports(); });
  registerHistoryView(pi, ctx => join(getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()), "subagent-history"));
  // A factory API is not bound yet. Never fall back to a captured pre-reload API.
  runtime.pi = undefined; // Also invalidate the legacy global runtime field.
  pauseDeliveries(delivery);

  // Capture the UI context for widget updates and restore presentation for
  // subagents whose watchers survived a reload.
  pi.on("session_start", async (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.pi = pi;
    if (typeof ctx.sessionManager?.getHeader === "function") await recoverParentRuntime(ctx);
    if (runtime.latestCtx !== ctx) return;
    retryPlanImports();
    if (!runtime.recoveryError) {
      delivery.api = pi;
      flushDeliveries(delivery);
    }
    runtime.modelCatalog = buildAuthenticatedModelCatalog(
      wrapPiModelRegistry(ctx.modelRegistry),
      24,
      ctx.scopedModels.map(({ model }) => model),
    );
    runtime.agentCatalog = buildAvailableAgentCatalog(
      discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation),
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
      detachRuntimeWatchers();
      cleanupSubagentsForShutdown("tree", runningSubagents);
      try {
        runtime.store.pauseCustody("/tree changed active lineage; explicit reconciliation required");
      } finally {
        runtime.store.close();
        runtime.store = undefined;
        delivery.store = undefined;
        delivery.pending.clear();
        delivery.handedOff.clear();
        runtime.suspendedCompletions?.clear();
      }
      return;
    }
    await recoverParentRuntime(ctx);
    if (runtime.latestCtx !== ctx) return;
    if (!runtime.recoveryError) { delivery.api = pi; flushDeliveries(delivery); }
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
        pauseDeliveries(delivery);
      });
    }, 25) };
    runtime.treeSuspension = suspension;
    suspension.timer.unref?.();
  });
  pi.on("session_tree", async (_event, ctx) => {
    await finishTreeNavigation(ctx);
  });

  pi.registerCommand("subagents-recovery", {
    description: "Show durable recovery/decision states (never relaunches or controls terminals)",
    handler: async (_args, ctx) => {
      const manifest = runtime.store?.snapshot();
      const runs = Object.values(manifest?.runs ?? {}).map((run) => `${run.id}: ${run.reconciliation ?? run.phase}`);
      const unknown = Object.entries(manifest?.outbox ?? {}).filter(([, event]) => event.status === "dispatching").map(([id]) => `${id}: UNKNOWN handoff; no automatic resend`);
      retryPlanImports();
      ctx.ui.notify([runtime.recoveryError, ...runs, ...unknown, ...runtime.planImportErrors!.values(), delivery.persistenceError].filter(Boolean).join("\n") || "No durable recovery state", "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    const guidelines = event.systemPromptOptions.toolGuidelines.subagent ??= [];
    for (const catalog of [runtime.agentCatalog, runtime.modelCatalog]) {
      if (catalog && !guidelines.includes(catalog)) guidelines.push(catalog);
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (event, _ctx) => {
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
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
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
        const running = await launchSubagent(params, ctx, parentThinking);

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
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
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

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

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
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Continue a settled interrupted or keepOpen idle live Pi child in its existing pane, or resume a closed session in a new pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
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
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        params.sessionPath = canonicalSessionPath(params.sessionPath, ctx.cwd);
        const name = params.name ?? "Resume";
        // Fail closed before reading history (in particular foreign harness transcripts).
        const profile = readPiLaunchProfile(params.sessionPath);
        if (params.autoExit !== undefined && params.autoExit !== profile.autoExit) {
          throw new Error("Resume must preserve the saved autoExit/interactivity profile. Start a new subagent to change it.");
        }
        if (runtime.recoveryError) throw new Error(runtime.recoveryError);
        runtime.store?.assertCustody();
        const previousOwner = sessionOwners.get(params.sessionPath);
        if (previousOwner?.surface) {
          const inspection = await inspectPane(previousOwner.surface);
          // Inspection yielded: never release a replacement owner's reservation.
          if (inspection.kind === "missing" && sessionOwners.get(params.sessionPath) === previousOwner) {
            releaseSession(params.sessionPath, previousOwner.runId);
          }
        }
        const liveOwner = sessionOwners.get(params.sessionPath);
        if (liveOwner && runningSubagents.has(liveOwner.runId)) {
          const child = runningSubagents.get(liveOwner.runId)!;
          if (runtime.treeSuspension || child.terminalActionsAllowed === false) throw new Error("Live continuation requires verified terminal custody");
          const continuationContract = params.planTask ? resolveAssignmentContract(undefined,
            runtime.plans!.read(ctx.sessionManager).snapshot?.tasks.find(t => t.taskId === params.planTask!.taskId)) : profile.assignmentContract;
          const continuationParams = { ...params, message: contractTask(params.message ?? "", continuationContract) };
          const result = await continueLiveChild(liveOwner, child, continuationParams, { inspect: inspectPane, beforeSend: () => {
            if (runtime.treeSuspension || child.terminalActionsAllowed === false) throw new Error("Terminal custody was detached during continuation");
            child.durableStore?.assertCustody();
            // Validate after async inspection, immediately before dispatch.
            child.planTask = bindPlanRun(runtime.plans!, ctx, child.id, params.planTask, child.planTask);
            if (child.planTask) {
              if (!child.durableStore) throw new Error("Task-bound continuation requires durable custody");
              child.durableStore.bindRun(child.id, child.planTask, continuationContract);
              persistProfileBinding(child.sessionFile, child.planTask, continuationContract);
            }
            if (liveOwner.continuationRequestId) child.durableStore?.continuation(child.id, liveOwner.continuationRequestId);
          }, send: (surface, command) => {
            // A live bridge rejection/uncertain send cannot certify that the
            // existing healthy process or its task attempt failed.
            runInPane(surface, command);
          } });
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
        const interactive = profile.interactive;
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

        const store = durableStoreFor(ctx);
        const owner = reserveSession(params.sessionPath, id);
        let planTask: PlanTaskBinding | undefined;
        try {
        if ((params.planTask || profile.planTask) && !store) throw new Error("Task-bound runs require durable runtime custody");
        planTask = bindPlanRun(runtime.plans!, ctx, id, params.planTask, profile.planTask);
        // Preserve the original binding, never infer authority from the selected branch.
        const assignmentContract = params.planTask ? resolveAssignmentContract(undefined,
          runtime.plans!.read(ctx.sessionManager).snapshot?.tasks.find(t => t.taskId === params.planTask!.taskId)) : profile.assignmentContract;
        const resumeProfile = { ...profile, ...(planTask ? { planTask } : {}), ...(assignmentContract ? { assignmentContract } : {}) };
        if (planTask) persistProfileBinding(params.sessionPath, planTask, assignmentContract);
        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const surface = createSubagentSurface(name, resolveSubagentLayout());
        owner.surface = surface;
        if (params.message) {
          setPaneTask(surface, params.message);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });
        const built = getHarnessDriver("pi").buildCommand(resumeLaunchContext(resumeProfile, {
          id, name, message: params.message, surface, artifactDir,
          subagentsDir: SUBAGENTS_DIR, shellQuote,
        }));
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
        store?.prepare({ id, planTask, name, task: params.message ?? "resumed session", startTime,
          sessionFile: params.sessionPath, surface, cli: "pi", activityFile,
          launchScriptFile, profile: resumeProfile, lineage: resumeProfile.lineage, entryCountBefore });
        runScriptInPane(surface, built.command, {
          onDispatch: () => {
            if (planTask) bindPlanRun(runtime.plans!, ctx, id, undefined, planTask);
            store?.phase(id, "dispatch-intent"); owner.dispatched = true;
          },
          scriptPath: launchScriptFile,
          scriptPreamble: built.launchScriptPreamble?.join("\n"),
        });

        // Register as a running subagent for widget tracking
        store?.phase(id, "supervised");
        recordHistory(profile.lineage, id, "continuation", `Parent closed-session resume: ${params.message ?? ""}`,
          id, [params.sessionPath, launchScriptFile]);
        const running: RunningSubagent = {
          planTask,
          durableStore: store,
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          agent: profile.role ?? undefined, lineage: profile.lineage,
          cli: "pi",
          runtimePlan: profile.runtimePlan,
          completionRunId: id,
          lifecycle: createLifecycle(startTime),
        };
        runningSubagents.set(id, running);
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
          try { recordDispatchFailure(runtime.plans!, ctx, planTask, id, error,
            store, { id, sessionFile: params.sessionPath, name, task: params.message ?? "resumed session", startTime }, owner.dispatched); }
          catch (importError) {
            runtime.planImportErrors!.set(id, `Dispatch failed/uncertain; task import pending: ${String(importError)}`);
            if (String(importError).includes("NOT persisted")) {
              runtime.recoveryError = String(importError);
              if (error instanceof Error) error.message += `; ${String(importError)}`;
            }
          }
          if (!owner.dispatched) {
            releaseSession(params.sessionPath, id);
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

      const defs = loadAgentDefaults(agentName);
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
        if (details?.keepOpen) {
          contentLines.push("", theme.fg("dim", "Pane stayed open for follow-up conversation."));
        }
        if (details?.runtimePlan?.runtimeMismatch && typeof details?.response === "string") {
          contentLines.push("", theme.fg("warning", `Runtime warning: ${details.runtimePlan.runtimeMismatch}`));
        }
        if (options.expanded && details?.sessionFile) {
          contentLines.push("");
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          contentLines.push(theme.fg("dim", `Resume: pi --session ${details.sessionFile}`));
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
    discoverRoles: discoverAgentDefinitions,
    terminalAvailable: isTerminalAvailable,
    terminalHint: terminalSetupHint,
  });
}
