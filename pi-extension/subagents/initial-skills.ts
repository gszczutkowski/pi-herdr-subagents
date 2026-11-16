import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertCompletionSession, beginCompletionTurn, CompletionSessionMismatch, writeRunCompletion } from "./run-artifacts.ts";

export const INITIAL_SKILLS_ENV = "PI_SUBAGENT_INITIAL_SKILLS";

/** Expand in the child's resource scope, into the task's input, never a startup turn. */
export function registerInitialSkills(pi: ExtensionAPI, onFailure?: (errorMessage: string, ctx: ExtensionContext) => void): void {
  const names = [...new Set((process.env[INITIAL_SKILLS_ENV] ?? "")
    .split(",").map((name) => name.trim()).filter(Boolean))];
  let consumed = false;
  const fail = (errorMessage: string, ctx: ExtensionContext) => {
    try {
      if (onFailure) onFailure(errorMessage, ctx);
      else {
        assertCompletionSession(ctx.sessionManager);
        beginCompletionTurn(ctx.sessionManager);
        writeRunCompletion({ type: "error", errorMessage, stopReason: "error" }, ctx.sessionManager);
        ctx.shutdown();
      }
    } catch {
      // A failing notification/publication must never turn handled input into
      // unqualified model work. Retrying the input after storage recovery is safe.
      try { ctx.ui?.notify?.("Required startup skills blocked: session/storage validation failed. Fix storage, then retry the input.", "warning"); } catch { /* Best effort diagnostic. */ }
    }
  };
  pi.on("input", (event, ctx) => {
    if (consumed || names.length === 0) return;
    // Startup requirements belong to the supervised session, not every future
    // session in this process after /new, /resume or /fork.
    if (process.env.PI_SUBAGENT_SESSION) {
      try { assertCompletionSession(ctx.sessionManager); }
      catch (error) {
        if (error instanceof CompletionSessionMismatch) { consumed = true; return; }
        fail(`Required startup skills blocked by session validation: ${error instanceof Error ? error.message : String(error)}`, ctx);
        return { action: "handled" as const }; // Not consumed: explicit input retry can revalidate after recovery.
      }
    }
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
      fail(errorMessage, ctx);
      return { action: "handled" as const };
    }
  });
}
