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
        `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $p){'null'}else{@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`],
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

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.birth === b.birth;
}
