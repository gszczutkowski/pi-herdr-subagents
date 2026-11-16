import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface Role { name: string; disableModelInvocation?: boolean; body?: string; skills?: string }
interface Dependencies {
  skillPath: string;
  discoverRoles: (ctx: ExtensionCommandContext) => Role[];
  terminalAvailable: () => boolean;
  terminalHint: () => string;
}

/** Check actual command-time capabilities, not documentation or startup guesses. */
export function planningPreflight(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: Dependencies): string {
  const active = new Set(pi.getActiveTools());
  const missing = ["plan_read", "plan_update", "subagent", "read", "bash", "write", "edit"].filter(name => !active.has(name));
  if (missing.length) throw new Error(`Missing active tools: ${missing.join(", ")}. Enable them in Pi's tool selection and reload the subagents package if plan tools are absent.`);
  const roles = deps.discoverRoles(ctx);
  const required = ["scout", "planner", "worker", "reviewer"].map(name => {
    const role = roles.find(role => role.name === name && !role.disableModelInvocation && role.body?.trim());
    if (!role) throw new Error(`Required role '${name}' is unavailable or disabled. Restore its agent definition or remove the disabling override, then retry /plan.`);
    return role;
  });
  const skills = ctx.getSystemPromptOptions().skills ?? [];
  for (const role of required) {
    for (const name of (role.skills ?? "").split(/[\s,]+/).filter(Boolean)) {
      const skill = skills.find(skill => skill.name === name);
      if (!skill) throw new Error(`Required skill '${name}' for role '${role.name}' is not loaded. Install/enable it for the role or remove that requirement; retry /plan.`);
      try { readFileSync(skill.filePath, "utf8"); }
      catch { throw new Error(`Required skill '${name}' cannot be read at ${skill.filePath}. Fix its path/permissions and reload.`); }
    }
  }
  if (!deps.terminalAvailable()) throw new Error(`Subagent terminal is unavailable. ${deps.terminalHint()}`);
  let content: string;
  try { content = readFileSync(deps.skillPath, "utf8").replace(/\r\n/g, "\n"); }
  catch { throw new Error(`Cannot read bundled planning instructions at ${deps.skillPath}. Restore/reinstall the package or fix permissions, then retry /plan.`); }
  content = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  if (!content) throw new Error(`Planning instructions are empty at ${deps.skillPath}. Restore/reinstall the package.`);
  return content;
}

export function registerPlanCommand(pi: ExtensionAPI, deps: Dependencies): void {
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) { ctx.ui.notify("Usage: /plan <what to build>", "warning"); return; }
      try {
        const content = planningPreflight(pi, ctx, deps);
        pi.sendUserMessage(`<skill name="plan" location="${deps.skillPath}">\n${content}\n</skill>\n\n${task}`);
      } catch (error) {
        ctx.ui.notify(`/plan preflight failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
