import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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

/** Add exactly this checkout's existing .pi/agents directory to the user-owned
 * project-source allowlist. The caller must present this as an explicit approval. */
export function assertProjectApprovalPermitted(ctx: TrustContext, agentDir: string): void {
  if (ctx.isProjectTrusted?.() !== true) {
    throw new Error("Pi has not trusted this project; approve the project trust prompt before approving local subagents.");
  }
  if (new ProjectTrustStore(agentDir).get(ctx.cwd) === false) {
    throw new Error("Pi has denied this project; remove that denial before approving local subagents.");
  }
}

function acquirePolicyLock(agentDir: string): string {
  const lock = join(agentDir, "subagent-trust.lock");
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    // Never wait on the TUI thread or remove a lock another process may own.
    throw new Error(`Subagent trust policy is locked: ${lock}. Retry when the other update finishes. If an update was interrupted, stop all Pi processes using this profile before removing the lock file.`);
  }
  return lock;
}

export function approveProjectAgentDirectory(agentDir: string, cwd: string): { path: string; added: boolean } {
  const source = join(cwd, ".pi", "agents");
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`No project agent directory exists at: ${source}`);
  }

  const canonicalSource = canonicalSessionPath(source);
  mkdirSync(agentDir, { recursive: true });
  const lock = acquirePolicyLock(agentDir);
  try {
    const policy = readSubagentTrust(agentDir);
    if (policy.projectAgentDirectories.includes(canonicalSource)) {
      return { path: canonicalSource, added: false };
    }

    const updated: SubagentTrust = {
      projectAgentDirectories: [...policy.projectAgentDirectories, canonicalSource],
      agentDirectories: policy.agentDirectories,
    };
    const file = join(agentDir, "subagent-trust.json");
    const temporary = join(agentDir, `.subagent-trust-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
    return { path: canonicalSource, added: true };
  } finally {
    rmSync(lock, { force: true });
  }
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
