import { mkdirSync, writeFileSync } from "node:fs";
import { resolveLaunchProfile } from "../../launch-profile.ts";
import { dirname, join } from "node:path";
import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { ASSIGNMENT_ENV, type SubagentAssignment } from "../../assignment.ts";
import { getSubagentActivityFile } from "../../activity.ts";
import { INITIAL_SKILLS_ENV } from "../../initial-skills.ts";
import { shellComment } from "../../shell.ts";

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  // Skills expand inside the child input hook, in the same task input. CLI
  // positional messages are separate turns and must never carry startup skills.
  // The driver supplies a controlled @artifact, even for direct/fork delivery:
  // Pi parses @file after -- too, so raw task text is not a safe CLI argument.
  return [params.taskArg];
}

export class PiHarnessDriver implements HarnessDriver {
  readonly id = "pi";
  readonly name = "Pi";
  readonly hasActivitySnapshots = true;
  readonly supportsTurnInterrupt = true;
  readonly supportsTrackedKeepOpen = true;
  readonly supportedSessionModes = ["standalone", "lineage-only", "fork"] as const;
  // Pi resume uses the separate session-file resume tool, not resumeSessionId.
  readonly supportsNativeResume = false;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.model;
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      runtimePlan,
      effectiveModel,
      effectiveThinking,
      surface,
      artifactDir,
      subagentSessionFile,
      effectiveCwd,
      effectiveAutoExit,
      taskDelivery,
      identity,
      identityInSystemPrompt,
      systemPromptMode,
      roleBlock,
      modeHint,
      summaryInstruction,
      subagentsDir,
      shellQuote,
    } = context;

    const profile = context.launchProfile ?? resolveLaunchProfile(context, "pi",
      buildSubagentToolAllowlist(params.tools ?? agentDefs?.tools));
    const parts: string[] = ["pi"];
    if (profile.projectTrust === false || context.denyProjectConfig) parts.push("--no-approve");
    parts.push("--session", shellQuote(subagentSessionFile));

    const subagentDonePath = join(subagentsDir, "subagent-done.ts");
    parts.push("-e", shellQuote(subagentDonePath));
    // The coordinator must be able to delegate even if its parent loaded this
    // worktree explicitly instead of enabling the installed package.
    if (profile.completionMode === "explicit") parts.push("-e", shellQuote(join(subagentsDir, "index.ts")));

    if (effectiveModel) {
      parts.push("--model", shellQuote(effectiveModel));
    }
    if (effectiveThinking) {
      parts.push("--thinking", shellQuote(effectiveThinking));
    }

    if (identityInSystemPrompt && identity) {
      const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
      const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const spSafeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}-${params.id}.md`);
      mkdirSync(dirname(syspromptPath), { recursive: true });
      writeFileSync(syspromptPath, identity, "utf8");
      parts.push(flag, shellQuote(syspromptPath));
    }

    const toolAllowlist = profile.tools;
    if (toolAllowlist) {
      parts.push("--tools", shellQuote(toolAllowlist));
    }

    const envParts: string[] = [];
    // Explicit values prevent the parent's current restrictions/config from replacing the saved ones.
    envParts.push(`PI_CODING_AGENT_DIR=${shellQuote(profile.agentDir)}`);
    envParts.push(`PI_DENY_TOOLS=${shellQuote(profile.denyTools.join(","))}`);
    envParts.push(`PI_SUBAGENT_NAME=${shellQuote(params.name)}`);
    envParts.push(`PI_SUBAGENT_AGENT=${shellQuote(profile.role ?? "")}`);
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=${effectiveAutoExit ? "1" : "0"}`);
    // Explicit default prevents a nested worker inheriting the coordinator's mode.
    envParts.push(`PI_SUBAGENT_COMPLETION_MODE=${profile.completionMode ?? "automatic"}`);
    envParts.push(`PI_SUBAGENT_SESSION=${shellQuote(subagentSessionFile)}`);
    envParts.push(`PI_SUBAGENT_ID=${shellQuote(params.id)}`);
    const activityFile = getSubagentActivityFile(artifactDir, params.id);
    envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`);
    envParts.push(`PI_SUBAGENT_SURFACE=${shellQuote(surface)}`);

    const correlation = profile.planTask
      ? `\n\nCorrelation (report only; do not mutate the parent plan): planId=${profile.planTask.planId}, taskId=${profile.planTask.taskId}, attemptId=${profile.planTask.attemptId}, runId=${params.id}` : "";
    const fullTask = (context.resume
      ? params.task
      : taskDelivery === "direct"
        ? `${roleBlock ? `${roleBlock}\n\n` : ""}${params.task}`
        : `${roleBlock ?? ""}\n\n${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`) + correlation;

    // taskDelivery controls the prompt's shape, not CLI interpretation. Always
    // attach one controlled file, whose contents Pi reads once without treating
    // leading --approve/--no-session/@file as flags or recursive attachments.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const artifactName = `context/${safeName || "subagent"}-${timestamp}-${params.id}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, { encoding: "utf8", mode: 0o600 });
    const taskArg = `@${artifactPath}`;

    const effectiveSkills = params.skills ?? agentDefs?.skills;
    envParts.push(`${INITIAL_SKILLS_ENV}=${shellQuote(context.resume ? "" : effectiveSkills ?? "")}`);
    const assignment: SubagentAssignment = {
      version: 1,
      ...(profile.planTask ? { planTask: profile.planTask } : {}),
      ...(profile.assignmentContract ? { assignmentContract: profile.assignmentContract } : {}),
      childId: params.id,
      sessionFile: subagentSessionFile,
      sender: process.env.PI_SUBAGENT_NAME || "Parent agent",
      recipient: params.name,
      role: params.agent || agentDefs?.name || "Subagent",
      task: params.task,
      skills: (effectiveSkills ?? "").split(",").map((skill) => skill.trim()).filter(Boolean),
      ...(context.lineage ? { lineage: context.lineage } : {}),
    };
    const assignmentPath = join(artifactDir, `context/subagent-assignment-${params.id}.json`);
    mkdirSync(dirname(assignmentPath), { recursive: true });
    writeFileSync(assignmentPath, JSON.stringify(assignment), "utf8");
    envParts.push(`${ASSIGNMENT_ENV}=${shellQuote(assignmentPath)}`);

    const promptArgs = context.resume
      ? (params.task ? [taskArg] : [])
      : buildPiPromptArgs({ effectiveSkills, taskDelivery, taskArg });
    for (const promptArg of promptArgs) {
      parts.push(shellQuote(promptArg));
    }

    const envPrefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_${params.id}_'$?'__'`;

    return {
      command,
      sessionFile: subagentSessionFile,
      cli: "pi",
      launchScriptPreamble: [
        `Subagent launch script for ${params.name}`,
        `Generated: ${new Date().toISOString()}`,
        `Session: ${subagentSessionFile}`,
        `Surface: ${surface}`,
        `Runtime: ${runtimePlan.model} (thinking: ${runtimePlan.thinking})`,
      ].map(shellComment),
    };
  }
}
