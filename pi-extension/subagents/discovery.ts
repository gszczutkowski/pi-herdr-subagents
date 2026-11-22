import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalSessionPath } from "./ownership.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelDefault, type ModelConfig } from "./model-config.ts";
import { getSubagentConfig } from "./config.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  completionMode?: "explicit";
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  disableModelInvocation?: boolean;
  source?: AgentSource;
  sourcePath?: string;
  sourceHash?: string;
  sourceCwd?: string;
}

export type AgentSource = "package" | "global" | "project";
export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}
export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Resolve on each call: tests and callers may change the environment or cwd. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../agents");
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

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
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
    ...(getFrontmatterValue(frontmatter, "completion-mode") === "explicit" ? { completionMode: "explicit" as const } : {}),
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

export interface DiscoveryOptions { cwd?: string; projectAgents?: boolean }

/** Project sources require an explicitly authorized caller; default is user/package only. */
export function discoverAgentDefinitions(options: DiscoveryOptions = {}): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    ...(options.projectAgents && options.cwd
      ? [{ path: join(options.cwd, ".pi", "agents"), source: "project" as const }] : []),
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      try {
        const sourcePath = canonicalSessionPath(join(dir, file));
        const content = readFileSync(sourcePath, "utf8");
        const parsed = parseAgentDefinition(content, file.replace(/\.md$/, ""));
        if (!parsed) continue;
        const sourceHash = createHash("sha256").update(content).digest("hex");
        agents.set(parsed.name, { ...parsed, source, sourcePath, sourceHash,
          ...(source === "project" ? { sourceCwd: realpathSync(options.cwd!) } : {}) });
      } catch {
        // Skip unreadable or racy entries rather than aborting discovery
        // for every other agent definition.
      }
    }
  }

  return [...agents.values()];
}

export function buildAvailableAgentCatalog(
  agents: ListedAgentDefinition[],
  limit = 24,
  modelConfig: ModelConfig = getSubagentConfig().models,
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

export function loadAgentDefaults(agentName: string, options: DiscoveryOptions = {}): ListedAgentDefinition | null {
  // The advertised frontmatter name, not the filename, is the lookup key.
  return discoverAgentDefinitions(options).find((agent) => agent.name === agentName) ?? null;
}
