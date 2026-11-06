import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_OPTIONS = { encoding: "utf8" as const, timeout: 15_000, windowsHide: true };

/** Resolve a real executable, not a shell alias (Node launches without a shell). */
export function findExecutable(command: string): string | null {
  try {
    if (process.platform === "win32") {
      return execFileSync("where.exe", [command], { ...CLI_OPTIONS, stdio: "pipe" }).trim().split(/\r?\n/)[0] || null;
    }
    // Command names here are fixed by the adapter, never caller-supplied text.
    return execFileSync("sh", ["-c", 'command -v "$1"', "sh", command], { ...CLI_OPTIONS, stdio: "pipe" }).trim() || null;
  } catch {
    return null;
  }
}

export function findBashExecutable(): string | null {
  const onPath = findExecutable("bash");
  if (onPath) return onPath;
  // Pi's Bash tool adds Git to its own environment. Extension callbacks run
  // in the original Node environment, where only Git/cmd may be on PATH.
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
      if (!root) continue;
      const installed = join(root, "Git", "usr", "bin", "bash.exe");
      if (existsSync(installed)) return installed;
    }
  }
  return null;
}

export function findHcExecutable(): string | null {
  const onPath = findExecutable("hc");
  if (onPath) return onPath;
  // The Windows app installer need not add its sibling core installation to PATH.
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const installed = join(process.env.LOCALAPPDATA, "Programs", "herdr-core", "hc.exe");
    if (existsSync(installed)) return installed;
  }
  return null;
}

export type HcInspection =
  | { kind: "present"; agent?: string; agentStatus: "idle" | "working" | "blocked" | "done" | "unknown" }
  | { kind: "missing"; error?: string }
  | { kind: "unavailable"; error: string };

type HcTerminal = {
  address?: string;
  state?: string;
  status?: { app?: string; state?: string } | null;
};

function parseJson(output: string): any {
  try { return JSON.parse(output); } catch { return null; }
}

export function parseHcInspection(output: string, terminal: string): HcInspection {
  const record = parseJson(output) as HcTerminal | null;
  if (record?.address !== terminal) return { kind: "unavailable", error: "hc terminal address mismatch" };
  if (record.state === "finished") return { kind: "missing", error: "hc terminal finished" };
  if (record.state !== "live") return { kind: "unavailable", error: "hc returned no live terminal record" };
  const raw = record.status?.state;
  const agentStatus = raw === "idle" || raw === "working" || raw === "blocked" || raw === "done"
    ? raw : raw === "error" ? "blocked" : "unknown";
  const agent = typeof record.status?.app === "string" ? record.status.app : undefined;
  return { kind: "present", ...(agent ? { agent } : {}), agentStatus };
}

export function parseHcError(error: unknown): HcInspection {
  const failure = error as { stdout?: string; stderr?: string } | null;
  for (const output of [failure?.stdout, failure?.stderr]) {
    if (typeof output !== "string") continue;
    const parsed = parseJson(output);
    // CLI and JSON-RPC errors have different envelopes. Transport failures must
    // never be confused with a confirmed missing terminal.
    if ((parsed?.error?.kind ?? parsed?.error?.data?.kind) === "not_found") {
      return { kind: "missing", error: "hc terminal not found" };
    }
  }
  return { kind: "unavailable", error: "hc terminal query failed" };
}

export function extractHcAddress(output: string): string {
  const parsed = parseJson(output);
  const address = parsed?.address;
  if (typeof address !== "string" || !/^t[a-z0-9]+$/.test(address)) {
    throw new Error("hc run returned no local terminal address");
  }
  return address;
}

export function buildHcRunArgs(name: string, cwd: string, bash: string, parent?: string): string[] {
  return ["run", "--bg", "--no-notify", "--cwd", cwd, "--label", `pi.name=${name}`,
    ...(parent ? ["--parent", parent] : []), "--", bash, "--noprofile", "--norc", "-i"];
}

/** hc terminals are not legacy UI panes; all operations target explicit IDs. */
export class HcClient {
  readonly executable: string;
  private readonly execute: (args: string[]) => string;
  private readonly executeAsync: (args: string[]) => Promise<string>;

  constructor(
    executable: string,
    execute = (args: string[]) => execFileSync(executable, args, CLI_OPTIONS),
    executeAsync = async (args: string[]) => (await execFileAsync(executable, args, CLI_OPTIONS)).stdout,
  ) {
    this.executable = executable;
    this.execute = execute;
    this.executeAsync = executeAsync;
  }

  available(parent?: string): boolean {
    try {
      if (parent) return parseHcInspection(this.execute(["get", parent]), parent).kind === "present";
      const status = parseJson(this.execute(["server", "status"]));
      return typeof status?.version === "string" && typeof status?.pid === "number";
    } catch { return false; }
  }

  create(name: string, cwd: string, parent?: string): string {
    const bash = findBashExecutable();
    if (!bash) throw new Error("hc subagents require Bash on PATH or a standard Git for Windows installation");
    return extractHcAddress(this.execute(buildHcRunArgs(name, cwd, bash, parent)));
  }

  read(terminal: string, lines: number): string {
    return this.execute(["read", terminal, "--lines", String(lines)]);
  }

  readAsync(terminal: string, lines: number): Promise<string> {
    return this.executeAsync(["read", terminal, "--lines", String(lines)]);
  }

  async inspect(terminal: string): Promise<HcInspection> {
    try { return parseHcInspection(await this.executeAsync(["get", terminal]), terminal); }
    catch (error) { return parseHcError(error); }
  }

  send(terminal: string, command: string): void { this.execute(["send", terminal, command]); }
  escape(terminal: string): void { this.execute(["keys", terminal, "esc"]); }

  close(terminal: string): void {
    try { this.execute(["kill", terminal]); }
    catch (error) { if (parseHcError(error).kind !== "missing") throw error; }
    try { this.execute(["rm", terminal]); }
    catch (error) { if (parseHcError(error).kind !== "missing") throw error; }
  }

  label(terminal: string, key: string, value: string): void {
    this.execute(["label", terminal, `${key}=${value}`]);
  }
}

/** Preserve the orchestrator's tool locations, not the core daemon's stale PATH. */
export function bashPath(path: string, platform = process.platform): string {
  return platform === "win32"
    ? path.split(";").map((entry) => entry.replace(/\\/g, "/").replace(/^([a-z]):\//i, (_, drive: string) => `/${drive.toLowerCase()}/`)).join(":")
    : path;
}
