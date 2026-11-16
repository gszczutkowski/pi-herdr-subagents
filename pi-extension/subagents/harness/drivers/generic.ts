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

export class GenericHarnessDriver implements HarnessDriver {
  readonly id: string;
  readonly name: string;
  readonly hasActivitySnapshots = false;
  readonly supportsTurnInterrupt = false;
  readonly supportedSessionModes = ["standalone"] as const;
  readonly supportsNativeResume = false;

  constructor(cliId = "generic", displayName?: string) {
    this.id = cliId;
    this.name = displayName ?? cliId;
  }

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

    const sp = context.identity ?? resolveRoleInstructions(agentDefs?.body, params.systemPrompt);
    const template = agentDefs?.commandTemplate;
    // Templates have no standard system-prompt flag; carry the role in the task.
    const fullTask = inheritsConversationContext
      ? params.task
      : `${template && sp ? `${sp}\n\n` : ""}${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;
    let commandBody: string;

    if (template) {
      // The template is executable configuration; its values are quoted data.
      // One scan of the original template prevents placeholders inside inserted
      // values from being expanded again. A callback also keeps $$/$& literal.
      const values: Record<string, string> = {
        model: effectiveModel ? shellQuote(effectiveModel) : "",
        task: shellQuote(fullTask),
        prompt: shellQuote(fullTask),
        cwd: effectiveCwd ? shellQuote(effectiveCwd) : ".",
        name: shellQuote(params.name),
        id: shellQuote(params.id),
      };
      commandBody = template.replace(/\{(model|task|prompt|cwd|name|id)\}/g, (_match, key: string) => values[key]);
    } else {
      const binary = this.id === "generic" ? (agentDefs?.cli ?? "subagent") : this.id;
      const cmdParts: string[] = [binary];

      if (effectiveModel) {
        cmdParts.push("--model", shellQuote(effectiveModel));
      }

      if (sp) {
        cmdParts.push("--system-prompt", shellQuote(sp));
      }

      cmdParts.push(shellQuote(fullTask));
      commandBody = cmdParts.join(" ");
    }

    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${commandBody}; echo '__SUBAGENT_DONE_${params.id}_'$?'__'`;

    return {
      command,
      cli: this.id,
      launchScriptPreamble: [
        `${this.name} subagent launch script for ${params.name}`,
        `Generated: ${new Date().toISOString()}`,
        `Surface: ${surface}`,
      ].map(shellComment),
    };
  }

  async extractResult(context: SubagentResultContext): Promise<HarnessResult | null> {
    return { summary: extractPaneSummary(context, this.name) };
  }
}
