import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { extractPaneSummary } from "../pane-summary.ts";
import { resolveRoleInstructions } from "../../role-instructions.ts";
import { shellComment } from "../../shell.ts";

export class GrokHarnessDriver implements HarnessDriver {
  readonly id = "grok";
  readonly name = "Grok";
  readonly hasActivitySnapshots = false;
  readonly supportsTurnInterrupt = false;
  readonly supportedSessionModes = ["standalone"] as const;
  readonly supportsNativeResume = false;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.modelId;
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      effectiveModel,
      effectiveCwd,
      surface,
      shellQuote,
      inheritsConversationContext,
      modeHint,
      summaryInstruction,
    } = context;

    const fullTask = inheritsConversationContext
      ? params.task
      : `${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;

    const cmdParts: string[] = ["grok"];

    if (effectiveModel) {
      cmdParts.push("--model", shellQuote(effectiveModel));
    }

    const sp = context.identity ?? resolveRoleInstructions(agentDefs?.body, params.systemPrompt);
    if (sp) {
      cmdParts.push("--system-prompt", shellQuote(sp));
    }

    cmdParts.push(shellQuote(fullTask));

    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_${params.id}_'$?'__'`;

    return {
      command,
      cli: "grok",
      launchScriptPreamble: [
        `Grok subagent launch script for ${params.name}`,
        `Generated: ${new Date().toISOString()}`,
        `Surface: ${surface}`,
      ].map(shellComment),
    };
  }

  async extractResult(context: SubagentResultContext): Promise<HarnessResult | null> {
    return { summary: extractPaneSummary(context, this.name) };
  }
}
