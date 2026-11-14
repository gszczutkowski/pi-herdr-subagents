import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface ProcessIdentity { pid: number; birth: string }
export type ProcessProbe = { kind: "present"; identity: ProcessIdentity } | { kind: "absent" } | { kind: "unverified" };

/** PID alone is never proof. Linux boot ID/start ticks and Windows creation time
 * distinguish reused PIDs. Unsupported/denied probes fail closed. Startup only. */
export function probeProcess(pid: number): ProcessProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unverified" };
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!ticks || !boot) return { kind: "unverified" };
      return { kind: "present", identity: { pid, birth: `linux:${boot}:${ticks}` } };
    }
    if (process.platform === "win32") {
      const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; try{$p=Get-Process -Id ${pid} -ErrorAction Stop}catch{if($_.CategoryInfo.Category -eq 'ObjectNotFound'){'null';exit}else{throw}}; @{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`],
      { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
      const value = JSON.parse(result);
      if (value === null) return { kind: "absent" };
      if (value.pid !== pid || typeof value.birth !== "string") return { kind: "unverified" };
      return { kind: "present", identity: { pid, birth: `windows:${value.birth}` } };
    }
  } catch (error) {
    if (process.platform === "linux" && (error as NodeJS.ErrnoException).code === "ENOENT" &&
        (error as NodeJS.ErrnoException).path === `/proc/${pid}/stat`) return { kind: "absent" };
  }
  return { kind: "unverified" };
}

/** True for self/ancestors; undefined when ancestry cannot be verified. No signals are sent. */
export function isProtectedProcess(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid || pid === process.ppid) return true;
  try {
    if (process.platform === "win32") {
      const rows = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId} }) | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 5000, windowsHide: true }));
      const parents = new Map<number, number>(rows.map((row: any) => [row.pid, row.parent]));
      // Exited MSYS/HC launchers leave holes in the parent chain. Creation
      // ordering is independent evidence: a process born strictly AFTER us
      // cannot be our ancestor. Equal/older/denied births remain unverified.
      const nonAncestorByBirth = (): false | undefined => {
        const own = probeProcess(process.pid), target = probeProcess(pid);
        if (own.kind === "present" && target.kind === "present" &&
            BigInt(target.identity.birth.slice("windows:".length)) > BigInt(own.identity.birth.slice("windows:".length))) return false;
        return undefined;
      };
      if (parents.get(pid) === process.pid && nonAncestorByBirth() === false) return false;
      let current = process.pid;
      const seen = new Set<number>();
      while (current > 0 && !seen.has(current)) {
        if (current === pid) return true;
        seen.add(current);
        const parent = parents.get(current);
        if (parent === undefined) return nonAncestorByBirth();
        current = parent;
      }
      return current === 0 ? false : nonAncestorByBirth();
    }
    if (process.platform === "linux") {
      let current = process.pid;
      const seen = new Set<number>();
      while (current > 0 && !seen.has(current)) {
        if (current === pid) return true;
        seen.add(current);
        const stat = readFileSync(`/proc/${current}/stat`, "utf8");
        current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      }
      return current === 0 ? false : undefined;
    }
  } catch { /* Cannot establish ancestry. */ }
  return undefined;
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.birth === b.birth;
}
