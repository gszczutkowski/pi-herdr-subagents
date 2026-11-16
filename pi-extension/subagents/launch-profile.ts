import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SubagentLaunchContext } from "./harness/types.ts";
import { canonicalSessionPath } from "./ownership.ts";
import { atomicRuntimeWrite } from "./runtime-store.ts";
import { isPlanTaskBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import { contractTask, isAssignmentContract, type AssignmentContract } from "./contracts.ts";
import type { ResolvedRuntimePlan } from "./runtime-routing.ts";
import { isLineage, type Lineage } from "./lineage.ts";
import type { DefinitionSource } from "./project-trust.ts";

/** Resolved, noncredential launch inputs only; never snapshot process.env or auth/config contents. */
export interface LaunchProfile {
  version: 1;
  planTask?: PlanTaskBinding;
  assignmentContract?: AssignmentContract;
  harness: string;
  sessionFile: string;
  role: string | null;
  definitionSource?: DefinitionSource;
  /** A denial remains a launch restriction, never an implicit --approve. */
  projectTrust?: false;
  identity: string | null;
  cwd: string;
  agentDir: string;
  tools: string | null;
  denyTools: string[];
  skills: string | null;
  systemPromptMode: string | null;
  identityInSystemPrompt: boolean;
  taskDelivery: "direct" | "artifact";
  runtimePlan: ResolvedRuntimePlan;
  autoExit: boolean;
  interactive: boolean;
  lineage?: Lineage;
}

export const launchProfilePath = (sessionFile: string): string => `${sessionFile}.launch-profile.json`;

export function resolveLaunchProfile(context: SubagentLaunchContext, harness: string, tools: string | null): LaunchProfile {
  const plan = context.runtimePlan;
  return {
    ...(context.params.assignmentContract ? { assignmentContract: context.params.assignmentContract } : {}),
    version: 1, harness, sessionFile: canonicalSessionPath(context.subagentSessionFile),
    ...(context.lineage ? { lineage: context.lineage } : {}),
    role: context.params.agent ?? context.agentDefs?.name ?? null,
    ...(context.agentDefs?.source && context.agentDefs.sourcePath && context.agentDefs.sourceHash
      ? { definitionSource: { source: context.agentDefs.source, sourcePath: context.agentDefs.sourcePath, sourceHash: context.agentDefs.sourceHash,
        ...(context.agentDefs.sourceCwd ? { sourceCwd: context.agentDefs.sourceCwd } : {}) } } : {}),
    identity: context.identity ?? null, cwd: resolve(context.effectiveCwd),
    agentDir: resolve(context.localAgentDir && existsSync(context.localAgentDir)
      ? context.localAgentDir : process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")),
    tools, denyTools: context.denySet?.size ? [...context.denySet]
      : (process.env.PI_DENY_TOOLS ?? "").split(",").map((tool) => tool.trim()).filter(Boolean),
    skills: context.params.skills ?? context.agentDefs?.skills ?? null,
    systemPromptMode: context.systemPromptMode ?? null,
    identityInSystemPrompt: !!context.identityInSystemPrompt,
    taskDelivery: context.taskDelivery,
    runtimePlan: { provider: plan.provider, modelId: plan.modelId, model: plan.model, thinking: plan.thinking,
      modelSource: plan.modelSource, thinkingSource: plan.thinkingSource },
    autoExit: context.effectiveAutoExit, interactive: context.effectiveInteractive,
  };
}

export function persistLaunchProfile(profile: LaunchProfile): void {
  const path = launchProfilePath(profile.sessionFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(profile, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function readPiLaunchProfile(sessionFile: string): LaunchProfile {
  const guidance = "Start a new subagent with explicit restrictions instead; legacy sessions cannot be safely resumed.";
  let p: any;
  try { p = JSON.parse(readFileSync(launchProfilePath(sessionFile), "utf8")); }
  catch { throw new Error(`Missing or unreadable launch profile. ${guidance}`); }
  if (p?.harness && p.harness !== "pi") {
    throw new Error(`Closed-session resume for harness "${p.harness}" is unsupported. Use that harness's native resume or start a new subagent.`);
  }
  const nullableString = (value: unknown) => value === null || typeof value === "string";
  const plan = p?.runtimePlan;
  if ((p?.lineage !== undefined && (!isLineage(p.lineage) || p.lineage.child.sessionFile !== p.sessionFile)) || p?.version !== 1 || p.harness !== "pi" || p.sessionFile !== canonicalSessionPath(sessionFile) ||
    (p.planTask !== undefined && !isPlanTaskBinding(p.planTask)) ||
    (p.assignmentContract !== undefined && !isAssignmentContract(p.assignmentContract)) ||
    (p.projectTrust !== undefined && p.projectTrust !== false) ||
    (p.definitionSource !== undefined && (!p.definitionSource ||
      !["package", "global", "project"].includes(p.definitionSource.source) ||
      typeof p.definitionSource.sourcePath !== "string" || !isAbsolute(p.definitionSource.sourcePath) ||
      typeof p.definitionSource.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(p.definitionSource.sourceHash) ||
      (p.definitionSource.source === "project" && (typeof p.definitionSource.sourceCwd !== "string" || !isAbsolute(p.definitionSource.sourceCwd))))) ||
    typeof p.cwd !== "string" || !isAbsolute(p.cwd) ||
    typeof p.agentDir !== "string" || !isAbsolute(p.agentDir) ||
    ![p.role, p.identity, p.tools, p.skills].every(nullableString) ||
    ![null, "append", "replace"].includes(p.systemPromptMode) ||
    !Array.isArray(p.denyTools) || !p.denyTools.every((tool: unknown) => typeof tool === "string") ||
    typeof p.identityInSystemPrompt !== "boolean" || typeof p.autoExit !== "boolean" || typeof p.interactive !== "boolean" ||
    !["direct", "artifact"].includes(p.taskDelivery) ||
    !plan || ![plan.provider, plan.modelId, plan.model, plan.modelSource, plan.thinkingSource].every((v) => typeof v === "string" && v.length > 0) ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(plan.thinking)) {
    throw new Error(`Invalid or unsupported launch profile. ${guidance}`);
  }
  return p;
}

/** Persist an optional first binding; an existing original authority is immutable. */
export function persistProfileBinding(sessionFile: string, binding: PlanTaskBinding, assignmentContract?: AssignmentContract): void {
  const profile = readPiLaunchProfile(sessionFile);
  if (profile.planTask && JSON.stringify(profile.planTask) !== JSON.stringify(binding)) throw new Error("Launch profile task binding conflict");
  if (assignmentContract && !isAssignmentContract(assignmentContract)) throw new Error("Invalid assignment contract");
  if (!profile.planTask || assignmentContract) atomicRuntimeWrite(launchProfilePath(sessionFile), { ...profile, planTask: binding, ...(assignmentContract ? { assignmentContract } : {}) });
}

/** Reconstruct exclusively from the saved profile, never current role defaults or parent runtime. */
export function resumeLaunchContext(profile: LaunchProfile, run: {
  id: string; name: string; message?: string; surface: string; artifactDir: string;
  subagentsDir: string; shellQuote: (value: string) => string;
}): SubagentLaunchContext {
  return {
    params: { id: run.id, name: run.name, task: contractTask(run.message ?? "", profile.assignmentContract), assignmentContract: profile.assignmentContract, agent: profile.role ?? undefined,
      tools: profile.tools ?? undefined, skills: profile.skills ?? undefined },
    runtimePlan: profile.runtimePlan, effectiveModel: profile.runtimePlan.model,
    effectiveThinking: profile.runtimePlan.thinking, parentThinking: profile.runtimePlan.thinking,
    surface: run.surface, artifactDir: run.artifactDir, sessionDir: dirname(profile.sessionFile),
    subagentSessionFile: profile.sessionFile, effectiveCwd: profile.cwd,
    localAgentDir: profile.agentDir, effectiveAutoExit: profile.autoExit,
    effectiveInteractive: profile.interactive, inheritsConversationContext: true,
    taskDelivery: profile.taskDelivery, denySet: new Set(profile.denyTools), identity: profile.identity,
    identityInSystemPrompt: profile.identityInSystemPrompt, systemPromptMode: profile.systemPromptMode ?? undefined,
    subagentsDir: run.subagentsDir, shellQuote: run.shellQuote, resume: true,
    launchProfile: profile, lineage: profile.lineage,
  };
}
