import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { bashPath, findBashExecutable } from "./hc.ts";
import { dirname, join } from "node:path";
import {
  closeHerdrSurface,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  usesHcBackend,
  getHerdrParentPaneId,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  reportHerdrPaneTask,
  sendHerdrCommand,
  sendHerdrEscape,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";

/**
 * Where a subagent surface should be created:
 *   - `"tab"`   — a brand-new tab (default)
 *   - `"right"` — split the orchestrator pane to the right
 *   - `"down"`  — split the orchestrator pane below
 */
export type SubagentLayout = "tab" | SplitDirection;

const SETUP_HINT = "Run pi inside herdr. Legacy herdr requires its CLI and HERDR_ENV=1; herdr-core requires hc and HC_TERMINAL_ID/HC_TERMINAL_SOCKET. Reload Pi after updating this extension.";

/**
 * Parse the `PI_SUBAGENT_LAYOUT` env var into a {@link SubagentLayout}.
 * Accepted values (case-sensitive, trimmed): `split`, `split:right` (both map
 * to a right-hand split), `split:down` (split below). Anything else — unset,
 * empty, or unknown — falls back to the default `tab`.
 */
export function parseSubagentLayout(raw?: string): SubagentLayout {
  const value = (raw ?? "").trim();
  if (value === "split" || value === "split:right") return "right";
  if (value === "split:down") return "down";
  return "tab";
}

/** Read `PI_SUBAGENT_LAYOUT` from the provided environment (defaults to the process env). */
export function resolveSubagentLayout(env: Record<string, string | undefined> = process.env): SubagentLayout {
  return parseSubagentLayout(env.PI_SUBAGENT_LAYOUT);
}

/** Create the surface for a subagent according to the requested layout. */
export function createSubagentSurface(name: string, layout: SubagentLayout = "tab"): PaneId {
  assertTerminalAvailable();
  if (layout === "tab") return createSubagentPane(name);
  const parentPaneId = getHerdrParentPaneId();
  if (!parentPaneId) return createSubagentPane(name);
  return createHerdrSurfaceSplit(name, layout, parentPaneId);
}

export function isTerminalAvailable(): boolean {
  return isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

function assertTerminalAvailable(): void {
  if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string): PaneId {
  assertTerminalAvailable();
  return createHerdrSurface(name);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable();
  renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable();
  renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  assertTerminalAvailable();
  sendHerdrCommand(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable();
  sendHerdrEscape(paneId);
}

export function runScriptInPane(
  paneId: PaneId,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-herdr-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptLines = ["#!/bin/bash"];
  const hcBackend = usesHcBackend();
  const bash = hcBackend ? findBashExecutable() : "bash";
  if (!bash) throw new Error("Cannot resolve Bash for the hc launch script");
  if (hcBackend) {
    // npm's Pi shell launcher also needs dirname, sed and uname from Git's
    // usr/bin, even when the parent Node PATH contains only Git/cmd.
    const gitTools = join(dirname(bash), "..", "usr", "bin");
    const tools = process.platform === "win32" && existsSync(gitTools) ? gitTools : dirname(bash);
    scriptLines.push(`export PATH=${shellQuote(bashPath(tools))}:${shellQuote(bashPath(process.env.PATH ?? ""))}:"$PATH"`);
  }
  if (options?.scriptPreamble) scriptLines.push(options.scriptPreamble.trimEnd());
  scriptLines.push(command);
  writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });

  // A core-created Bash may inherit a Windows PATH without /usr/bin. Resolve
  // the interpreter from the orchestrator instead of relying on that shell.
  runInPane(paneId, `${shellQuote(bashPath(bash))} ${shellQuote(scriptPath)}`);
  return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
  assertTerminalAvailable();
  return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
  assertTerminalAvailable();
  return readHerdrScreenAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  assertTerminalAvailable();
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") {
    return { kind: "present", observedAt: Date.now(), ...result };
  }
  return result;
}

export function closePane(paneId: PaneId): void {
  assertTerminalAvailable();
  closeHerdrSurface(paneId);
}

export function setPaneTask(paneId: PaneId, task: string): void {
  if (!isTerminalAvailable()) return;
  reportHerdrPaneTask(paneId, task);
}
