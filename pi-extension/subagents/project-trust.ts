import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { canonicalSessionPath } from "./ownership.ts";

/** User-owned file, never loaded from a target checkout. Entries approve exact
 * canonical source directories, not arbitrary descendants or another cwd. */
export interface SubagentTrust {
  projectAgentDirectories: string[];
  agentDirectories: string[];
}
export interface TrustContext {
  cwd: string;
  isProjectTrusted?: () => boolean;
}

export function readSubagentTrust(agentDir: string): SubagentTrust {
  const file = join(agentDir, "subagent-trust.json");
  if (!existsSync(file)) return { projectAgentDirectories: [], agentDirectories: [] };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "projectAgentDirectories" && key !== "agentDirectories")) {
    throw new Error(`Invalid subagent trust policy: ${file}`);
  }
  const paths = (key: keyof SubagentTrust): string[] => {
    const entries = value[key] ?? [];
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" || !isAbsolute(entry))) {
      throw new Error(`Invalid ${key} in ${file}: expected absolute source directory paths`);
    }
    return entries.map(entry => canonicalSessionPath(entry));
  };
  return { projectAgentDirectories: paths("projectAgentDirectories"), agentDirectories: paths("agentDirectories") };
}

/** Missing host trust APIs fail closed. In agents-only checkouts Pi may report
 * trusted without asking: the separate exact-source approval is still required.
 * A saved target denial also wins when launching into a different cwd. */
export function sourceAuthorized(ctx: TrustContext, agentDir: string, source: string,
  kind: keyof SubagentTrust, targetCwd = ctx.cwd): boolean {
  if (ctx.isProjectTrusted?.() !== true) return false;
  const policy = readSubagentTrust(agentDir);
  if (!policy[kind].includes(canonicalSessionPath(source))) return false;
  return new ProjectTrustStore(agentDir).get(targetCwd) !== false;
}

export function authorizedDiscovery(ctx: TrustContext, agentDir: string): { cwd?: string; projectAgents: boolean } {
  // Older/offline host adapters may lack cwd/trust. They cannot authorize project
  // sources, but bundled/user roles remain usable without touching a checkout.
  if (!ctx || typeof ctx.cwd !== "string" || ctx.isProjectTrusted?.() !== true) {
    return { cwd: ctx?.cwd, projectAgents: false };
  }
  return { cwd: ctx.cwd, projectAgents: sourceAuthorized(ctx, agentDir, join(ctx.cwd, ".pi", "agents"), "projectAgentDirectories") };
}

/** Resume must not treat a persisted path as fresh authorization. A non-base
 * user-level configuration is only supported at the target's exact .pi/agent. */
export function assertAgentDirectoryAuthorized(ctx: TrustContext, base: string, selected: string, cwd: string): void {
  if (canonicalSessionPath(base) === canonicalSessionPath(selected)) return;
  const local = join(resolve(cwd), ".pi", "agent");
  if (canonicalSessionPath(selected) !== canonicalSessionPath(local) ||
      !sourceAuthorized(ctx, base, local, "agentDirectories", cwd)) {
    throw new Error(`Subagent agentDir is not explicitly authorized: ${selected}. Use the parent agentDir or approve this exact source in ${join(base, "subagent-trust.json")}.`);
  }
}

/** Origin files used by a saved profile are rechecked against current policy. */
export interface DefinitionSource { source?: string; sourcePath?: string; sourceHash?: string; sourceCwd?: string }
export function assertDefinitionAuthorized(ctx: TrustContext, base: string, definition: DefinitionSource): void {
  if (definition.source === undefined && definition.sourcePath === undefined && definition.sourceHash === undefined) return;
  const source = definition.sourcePath;
  if (!["package", "global", "project"].includes(definition.source ?? "") || !source || !isAbsolute(source) ||
      typeof definition.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(definition.sourceHash)) {
    throw new Error("Invalid saved agent definition provenance; start a new subagent.");
  }
  if (canonicalSessionPath(source) !== source ||
      createHash("sha256").update(readFileSync(source, "utf8")).digest("hex") !== definition.sourceHash) {
    throw new Error("Agent definition source changed; start a new subagent with current instructions.");
  }
  if (definition.source === "project" &&
      (!definition.sourceCwd || !isAbsolute(definition.sourceCwd) ||
       !sourceAuthorized(ctx, base, dirname(source), "projectAgentDirectories", definition.sourceCwd))) {
    throw new Error("Project agent source is no longer authorized; refresh discovery before dispatch.");
  }
}
