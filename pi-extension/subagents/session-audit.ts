import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonicalSessionPath } from "./ownership.ts";
import { probeProcess, sameProcess, type ProcessIdentity } from "./process-identity.ts";

export interface ProcessRow { pid: number; parentPid: number; argv?: string[]; cwd?: string }
export interface ProcessSnapshot { rows: ProcessRow[]; verified: boolean }
export interface SessionAudit {
  sessionPath: string; status: "clear" | "single" | "duplicate" | "uncertain";
  owners: ProcessIdentity[]; ownerCount: number; uncertainCount: number; truncated: boolean;
}

/** CommandLineToArgvW/CRT quoting, not shell splitting. Never evaluate command text. */
export function windowsArgv(command: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? "") && i < command.length) i++;
    if (i === command.length) break;
    let value = "", quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === "\\") { slashes++; i++; }
      if (command[i] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) { value += '"'; i++; }
        else if (quoted && command[i + 1] === '"') { value += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else { value += "\\".repeat(slashes); if (i < command.length) value += command[i++]; }
    }
    if (quoted) throw new Error("Unterminated process argument");
    args.push(value);
  }
  return args;
}

/** OS read only. Partial/denied enumeration is explicitly not an empty safe set. */
export function enumerateProcesses(): ProcessSnapshot {
  const rows: ProcessRow[] = [];
  let verified = true;
  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|pi)(\\.exe)?$' } | ForEach-Object { @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;command=$_.CommandLine} }) | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const values = JSON.parse(output);
      for (const row of Array.isArray(values) ? values : [values]) {
        let argv: string[] | undefined;
        try { if (row.command) argv = windowsArgv(row.command); } catch { /* uncertainty retained */ }
        rows.push({ pid: row.pid, parentPid: row.parentPid, argv });
      }
      return { rows, verified };
    }
    if (process.platform === "linux") {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const executable = readlinkSync(`/proc/${entry}/exe`);
          if (!/^(node|nodejs|pi)$/.test(basename(executable))) continue;
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const parentPid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
          let cwd: string | undefined;
          try { cwd = readlinkSync(`/proc/${entry}/cwd`); } catch { /* relative paths unverified */ }
          rows.push({ pid: Number(entry), parentPid, argv, cwd });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") verified = false;
        }
      }
      return { rows, verified };
    }
  } catch { /* Unsupported/denied is not clear. */ }
  return { rows, verified: false };
}

const valueOptions = new Set(["--mode", "--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session-id", "--fork", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode"]);

/** Resolve aliases first, then verify the owning package's declared pi bin. */
function piEntrypoint(entry: string, cwd?: string): "pi" | "other" | "uncertain" {
  if (!isAbsolute(entry) && !cwd) return "uncertain";
  try {
    const file = realpathSync(resolve(cwd ?? ".", entry));
    let root = dirname(file);
    for (;;) {
      let pkg: any;
      try { pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "uncertain";
      }
      if (pkg) {
        if (!["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(pkg.name)) return "other";
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (typeof bin !== "string") return "other";
        const declared = realpathSync(resolve(root, bin));
        if (declared === file) return "pi";
        // Published packages also ship an unbundled SDK CLI. Accept that exact
        // companion only when the declared bin is the canonical bundled CLI.
        if (existsSync(resolve(root, "dist/bundle/cli.js")) && existsSync(resolve(root, "dist/cli.js")) &&
            declared === realpathSync(resolve(root, "dist/bundle/cli.js")) &&
            file === realpathSync(resolve(root, "dist/cli.js"))) return "pi";
        return "other";
      }
      const parent = dirname(root);
      if (parent === root) return "other";
      root = parent;
    }
  } catch { return "uncertain"; }
}

/** Only a real Pi entrypoint in Node's script position qualifies, never -e text or argument mentions. */
export function piSessionArgument(row: ProcessRow): { kind: "other" | "uncertain" } | { kind: "session"; path: string } {
  const argv = row.argv;
  if (!argv?.length) return { kind: "uncertain" };
  // This audit covers explicit CLI selection only. With the complete argv and
  // no selector at all, even an unresolved script/VM option cannot explicitly
  // select this session. Missing/denied argv above remains uncertain.
  if (!argv.some(arg => arg === "--session" || arg.startsWith("--session="))) return { kind: "other" };
  let start = 1;
  if (/^(node|nodejs)(\.exe)?$/i.test(basename(argv[0]))) {
    let unknownFlag = false;
    while (argv[start]?.startsWith("-")) {
      const flag = argv[start++];
      if (["-e", "--eval", "-p", "--print", "--test"].includes(flag) || /^(--eval|--print)=/.test(flag)) return { kind: "other" };
      if (["--import", "--require", "-r", "--loader", "--experimental-loader"].includes(flag)) start++;
      else if (flag === "--") break;
      else if (!/^(--input-type=(?:module|commonjs)|--experimental-strip-types|--no-warnings|--disable-warning=.*|--inspect(?:-brk)?(?:=.*)?|--enable-source-maps|--no-deprecation)$/.test(flag)) unknownFlag = true;
    }
    const entry = argv[start++];
    if (!entry) return { kind: "other" };
    const kind = piEntrypoint(entry, row.cwd);
    if (kind !== "pi") {
      // Unknown VM options may consume a value. Do not mistake that value for
      // an unrelated script if a later argument could actually be Pi's bin.
      if (unknownFlag && argv.slice(start).some(arg => !arg.startsWith("-") && piEntrypoint(arg, row.cwd) === "pi")) return { kind: "uncertain" };
      return { kind };
    }
    if (unknownFlag) return { kind: "uncertain" };
  } else if (!/^pi(\.exe)?$/i.test(basename(argv[0]))) return { kind: "other" };
  let session: string | undefined;
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--session") { session = argv[++i]; if (!session) return { kind: "uncertain" }; }
    // Current Pi CLI does not parse this spelling; never report it as clear.
    else if (arg.startsWith("--session=")) return { kind: "uncertain" };
    else if (valueOptions.has(arg)) i++;
    else if (arg === "-p" || arg === "--print") { if (argv[i + 1] && !argv[i + 1].startsWith("-")) i++; }
  }
  if (!session) return { kind: "other" };
  if (!isAbsolute(session) && !row.cwd) return { kind: "uncertain" };
  // IDs/partial UUIDs require Pi's session lookup, not cwd resolution.
  if (!isAbsolute(session) && !/[\\/]|\.jsonl$/.test(session)) return { kind: "uncertain" };
  try { return { kind: "session", path: canonicalSessionPath(session, row.cwd) }; }
  catch { return { kind: "uncertain" }; }
}

export function auditSession(sessionPath: string, snapshot = enumerateProcesses(), probe = probeProcess): SessionAudit {
  const canonical = canonicalSessionPath(sessionPath);
  const owners: ProcessIdentity[] = [];
  let uncertainCount = snapshot.verified ? 0 : 1;
  for (const row of snapshot.rows) {
    const parsed = piSessionArgument(row);
    if (parsed.kind === "uncertain") { uncertainCount++; continue; }
    if (parsed.kind !== "session" || parsed.path !== canonical) continue;
    const result = probe(row.pid);
    if (result.kind === "present") owners.push(result.identity);
    else if (result.kind === "unverified") uncertainCount++;
  }
  return { sessionPath: canonical, status: owners.length > 1 ? "duplicate" : uncertainCount ? "uncertain" : owners.length ? "single" : "clear",
    owners: owners.slice(0, 32), ownerCount: owners.length, uncertainCount, truncated: owners.length > 32 };
}

export function assertSessionWriters(audit: SessionAudit, allowed?: ProcessIdentity): void {
  if (audit.uncertainCount || audit.ownerCount > 1 || (audit.ownerCount === 1 && (!allowed || !sameProcess(audit.owners[0], allowed)))) {
    throw new Error(`Session process audit is ${audit.status} (${audit.ownerCount} owners, ${audit.uncertainCount} unverified). Use subagent_audit; manually close untracked/legacy writers before resuming. No terminal/task writes were attempted.`);
  }
}
