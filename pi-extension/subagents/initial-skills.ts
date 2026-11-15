import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeRunCompletion } from "./run-artifacts.ts";

export const INITIAL_SKILLS_ENV = "PI_SUBAGENT_INITIAL_SKILLS";

/** Expand in the child's resource scope, into the task's input, never a startup turn. */
export function registerInitialSkills(pi: ExtensionAPI): void {
  const names = [...new Set((process.env[INITIAL_SKILLS_ENV] ?? "")
    .split(",").map((name) => name.trim()).filter(Boolean))];
  let consumed = false;
  pi.on("input", (event, ctx) => {
    if (consumed || names.length === 0) return;
    consumed = true;
    try {
      const commands = pi.getCommands();
      const blocks = names.map((name) => {
        const command = commands.find((command) => command.source === "skill" && command.name === `skill:${name}`);
        if (!command) throw new Error(`Required skill not found in child resources: ${name}`);
        const path = command.sourceInfo.path;
        const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
        return `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
      });
      return { action: "transform" as const, text: `${blocks.join("\n\n")}\n\n${event.text}` };
    } catch (error) {
      // Throwing from an input hook is fail-open in Pi. Handle the input instead:
      // no partial skill set or unqualified task may reach the model.
      const errorMessage = error instanceof Error ? error.message : String(error);
      try { writeRunCompletion({ type: "error", errorMessage, stopReason: "error" }); }
      catch { /* Input must remain handled even if completion storage fails. */ }
      ctx.shutdown();
      return { action: "handled" as const };
    }
  });
}
