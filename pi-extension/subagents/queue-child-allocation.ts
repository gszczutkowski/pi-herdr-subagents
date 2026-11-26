import { constants as bufferLimits } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LaunchProfile } from "./launch-profile.ts";
import { canonicalSessionPath } from "./ownership.ts";
import { isLineage } from "./lineage.ts";
import { areaContainsCwd, captureDependencies, sameDependencies, type WorkArea } from "./plan-queue.ts";
import { canonicalWorkArea, sameWorkArea } from "./plan-queue-work-area.ts";
import { isPlanTaskBinding, samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import type { PlanSnapshot } from "./plan-store.ts";

export interface QueueChildAllocation {
  readonly version: 1;
  readonly rootRunId: string;
  readonly binding: Readonly<PlanTaskBinding>;
  readonly area: WorkArea;
}

export const QUEUE_CHILD_ENV = "PI_SUBAGENT_QUEUE_CHILD";
export const queueChildMarkerPath = (file: string): string => `${file}.queue-child`;
export const launchProfilePath = (file: string): string => `${file}.launch-profile.json`;
const disabled = "Queue-bound transport is unavailable pending execution-tree settlement support";
const noAuthority = "Queue descendant execution requires current trusted root authority; no transport attempted";

export function hasQueueAllocation(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.hasOwn(value, "queueAllocation");
}

export function isQueueChildAllocation(value: unknown): value is QueueChildAllocation {
  const a = value as QueueChildAllocation | undefined;
  const canonical = (path: unknown) => typeof path === "string" && path.length <= 8192 &&
    isAbsolute(path) && normalize(path) === path && !path.includes("\0") && !/[\r\n]/.test(path);
  return !!a && typeof a === "object" && Object.keys(a).length === 4 && a.version === 1 &&
    typeof a.rootRunId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(a.rootRunId) &&
    isPlanTaskBinding(a.binding) && !!a.area && typeof a.area === "object" && Object.keys(a.area).length === 4 &&
    canonical(a.area.cwd) && canonical(a.area.root) && ["read", "write"].includes(a.area.access) &&
    ["git", "directory"].includes(a.area.kind) && areaContainsCwd(a.area);
}

export function assertQueueProfile(profile: LaunchProfile): void {
  if (!hasQueueAllocation(profile)) return;
  const a = profile.queueAllocation;
  if (!isQueueChildAllocation(a) || profile.harness !== "pi" || !samePlanBinding(profile.planTask, a.binding) ||
      !isLineage(profile.lineage) || profile.lineage.child.sessionFile !== profile.sessionFile ||
      profile.lineage?.parent.sessionId !== a.binding.authority.sessionId) {
    throw new Error("Invalid queue allocation in the Pi launch profile");
  }
}

function requireMatchingReservation(plan: PlanSnapshot, allocation: QueueChildAllocation) {
  const { binding, rootRunId, area } = allocation;
  const task = plan.tasks.find(task => task.taskId === binding.taskId);
  const attempt = task?.attempts.at(-1);
  const reservation = attempt?.reservation;
  if (plan.schemaVersion !== 2 || !plan.queue || plan.queue.pause !== undefined || plan.planId !== binding.planId ||
      !isDeepStrictEqual(plan.authority, binding.authority) || task?.status !== "in_progress" ||
      attempt?.attemptId !== binding.attemptId || reservation?.runId !== rootRunId || !task.workArea ||
      !sameWorkArea(area, reservation.area) || !sameWorkArea(area, task.workArea) ||
      !sameDependencies(reservation.dependencies, captureDependencies(plan, task))) {
    throw new Error("Queue allocation is paused, stale, or no longer assigned to this run");
  }
  return reservation;
}

export function assertQueueWorkArea(allocation: QueueChildAllocation, cwd: string, access: WorkArea["access"], interactive: boolean): void {
  // Require the exact allowed CWD (allow path aliases to that directory), not
  // merely the same checkout root. Access here is a contract, not a sandbox.
  if (allocation.area.access !== access || (access === "write" && interactive) ||
      !sameWorkArea(allocation.area, canonicalWorkArea(cwd, access))) {
    throw new Error("Queue execution requires the assigned CWD and access mode (no user-managed writer)");
  }
}

/** Stamp the original Pi profile from the bound reservation, not task text or
 * tool parameters. This snapshot is identity only, not permission to send. */
export function queueChildProfile(plan: PlanSnapshot, binding: PlanTaskBinding, runId: string, profile: LaunchProfile): LaunchProfile {
  if (hasQueueAllocation(profile) || !samePlanBinding(profile.planTask, binding)) throw new Error("Queue profile identity is immutable");
  const area = plan.tasks.find(task => task.taskId === binding.taskId)?.attempts.at(-1)?.reservation?.area;
  if (!area) throw new Error("Missing queue allocation");
  const allocation = structuredClone({ version: 1 as const, binding, rootRunId: runId, area });
  const scoped = { ...profile, planTask: allocation.binding, queueAllocation: allocation };
  assertQueueProfile(scoped);
  if (requireMatchingReservation(plan, allocation).phase !== "uncertain") throw new Error("Queue profile requires original dispatch intent");
  assertQueueWorkArea(allocation, profile.cwd, allocation.area.access, profile.interactive);
  Object.freeze(allocation.binding.authority);
  Object.freeze(allocation.binding);
  Object.freeze(allocation.area);
  Object.freeze(allocation);
  return Object.freeze(scoped);
}

/** Validate an active resume against a fresh, already authenticated root
 * view. Never call with a plan reconstructed in a separate child process. */
export function assertQueueActiveResume(plan: PlanSnapshot, profile: LaunchProfile, liveCwd: string): void {
  assertQueueProfile(profile);
  const allocation = profile.queueAllocation;
  if (!allocation || requireMatchingReservation(plan, allocation).phase !== "dispatched") {
    throw new Error("Active queue resume requires positive dispatch and an occupied allocation");
  }
  assertQueueWorkArea(allocation, profile.cwd, allocation.area.access, profile.interactive);
  if (liveCwd !== profile.cwd) assertQueueWorkArea(allocation, liveCwd, allocation.area.access, profile.interactive);
}

/** The marker is a reason to deny, never a reason to trust. A missing launch
 * env does not change the classification after reopening the same session. */
export function isQueueMarkedSession(file: string): boolean {
  return lstatSync(queueChildMarkerPath(file), { throwIfNoEntry: false }) !== undefined;
}

const verificationFailed = () => new Error("Queue provenance could not be verified");
const sameFileImage = (a: BigIntStats, b: BigIntStats | undefined) => !!b?.isFile() &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function pathState(file: string): BigIntStats | undefined {
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (canonicalSessionPath(file) !== file || (stat && !stat.isFile())) throw verificationFailed();
  return stat;
}

/** Cross-check the opened object against the original name and identity before
 * reading and after. The portable checks matter even when O_NOFOLLOW (which
 * does not guard ancestor directories) or O_NONBLOCK is unavailable. This is
 * not a lock against concurrent namespace mutations. */
function withProvenanceFile<T>(file: string, inspect: (fd: number, size: number) => T,
  assertIdentity?: (image: BigIntStats | undefined) => void,
): { value: T | undefined; verifyImage: () => void } {
  try {
    const expected = pathState(file);
    assertIdentity?.(expected);
    const verifyImage = () => {
      try {
        const current = pathState(file);
        if (expected ? sameFileImage(expected, current) : current === undefined) return;
      } catch { /* Do not surface filesystem details. */ }
      throw verificationFailed();
    };
    if (!expected) {
      verifyImage();
      return { value: undefined, verifyImage };
    }
    if (expected.ino === 0n || expected.size > BigInt(Number.MAX_SAFE_INTEGER)) throw verificationFailed();
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const verify = () => {
        const opened = fstatSync(fd, { bigint: true });
        assertIdentity?.(opened);
        if (!sameFileImage(expected, opened)) throw verificationFailed();
        verifyImage();
      };
      verify();
      const value = inspect(fd, Number(expected.size));
      verify();
      return { value, verifyImage };
    } finally { closeSync(fd); }
  } catch {
    // JSON and filesystem errors can quote data or paths. Do not propagate
    // their messages or causes into a model-facing error.
    throw verificationFailed();
  }
}

function scanChunks(fd: number, size: number, visit: (chunk: Buffer) => boolean | void): boolean {
  const block = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < size;) {
    const bytes = readSync(fd, block, 0, Math.min(block.length, size - offset), offset);
    if (bytes <= 0) throw verificationFailed();
    offset += bytes;
    if (visit(block.subarray(0, bytes))) return true;
  }
  return false;
}

// Decode each chunk once. No rolling Buffer.concat of a long line: one set of
// decoded fragments and at most one joined string / parsed JSON record at a time.
function jsonRecord() {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let parts: string[] = [];
  let length = 0;
  const append = (text: string) => {
    if (!text) return;
    length += text.length;
    if (length > bufferLimits.MAX_STRING_LENGTH) throw verificationFailed();
    parts.push(text);
  };
  return {
    add: (data: Buffer) => append(decoder.decode(data, { stream: true })),
    finish: () => {
      append(decoder.decode());
      const text = parts.length === 1 ? parts[0] : parts.join("");
      parts = [];
      length = 0;
      return /^\s*$/.test(text) ? undefined : JSON.parse(text) as unknown;
    },
  };
}

/** Pin the selected session across the async pane preparation. Appends are
 * permitted between scans; each individual scan verifies a stable image. */
export function captureQueueResumeTarget(file: string) {
  try {
    const original = pathState(file);
    const assertIdentity = (current: BigIntStats | undefined) => {
      if ((!original && !current) || (original && current && original.ino !== 0n &&
          current.ino === original.ino && current.dev === original.dev)) return;
      throw verificationFailed();
    };
    return {
      verifyIdentity: () => {
        try { assertIdentity(pathState(file)); }
        catch { throw verificationFailed(); }
      },
      scanAssignment: () => scanPersistedQueueAssignment(file, assertIdentity),
    };
  } catch { throw verificationFailed(); }
}

export function inspectPersistedQueueProfile(file: string) {
  return withProvenanceFile(launchProfilePath(file), (fd, size) => {
    const record = jsonRecord();
    scanChunks(fd, size, record.add);
    return record.finish();
  });
}

export function readPersistedQueueProfile(file: string): unknown {
  return inspectPersistedQueueProfile(file).value;
}

export function hasPersistedQueueProfile(file: string): boolean {
  // Inspect raw data, not only known schema versions. Unsupported/corrupt
  // profiles may deny execution, but never grant it or become legacy.
  return hasQueueAllocation(readPersistedQueueProfile(file));
}

function isExactQueueAssignment(entry: unknown, file: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const { type, customType, data } = entry as { type?: unknown; customType?: unknown; data?: unknown };
  // The driver writes the canonical session path. A fork can copy the entry
  // without changing its data, but cannot thereby become the original session.
  return type === "custom" && customType === "subagent-assignment" && hasQueueAllocation(data) &&
    (data as { sessionFile?: unknown }).sessionFile === file;
}

/** Called only after resume has authorized access to the exact target path.
 * Scan physical entries, including abandoned branches; never restore model
 * context or rewrite the target. An incomplete scan is not permission. */
function scanPersistedQueueAssignment(file: string, assertIdentity: (image: BigIntStats | undefined) => void) {
  return withProvenanceFile(file, (fd, size) => {
    const record = jsonRecord();
    const found = scanChunks(fd, size, chunk => {
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf(0x0a, start)) >= 0) {
        record.add(chunk.subarray(start, end));
        if (isExactQueueAssignment(record.finish(), file)) return true;
        start = end + 1;
      }
      if (start < chunk.length) record.add(chunk.subarray(start));
    });
    return found || isExactQueueAssignment(record.finish(), file);
  }, assertIdentity);
}

type ChildSession = Pick<ExtensionContext["sessionManager"], "getSessionFile"> &
  Partial<Pick<ExtensionContext["sessionManager"], "getEntries">>;
export function captureQueueChildFence(receiverFile?: string) {
  const launchedInQueue = Boolean(process.env[QUEUE_CHILD_ENV]);
  let markedPath: string | undefined;
  return (session: ChildSession | undefined) => {
    if (launchedInQueue) throw new Error(noAuthority);
    const current = session?.getSessionFile();
    if (!current) {
      if (receiverFile) throw verificationFailed();
      return;
    }
    const file = canonicalSessionPath(current);
    if (receiverFile && file !== receiverFile) throw verificationFailed();
    const deny = (): never => { markedPath = file; throw new Error(noAuthority); };
    if (file === markedPath || isQueueMarkedSession(file)) deny();
    const target = receiverFile ? captureQueueResumeTarget(file) : undefined;
    const profile = inspectPersistedQueueProfile(file);
    if (hasQueueAllocation(profile.value) || session?.getEntries?.().some(entry => isExactQueueAssignment(entry, file))) deny();
    // Only a continuation receiver scans its exact on-disk transcript: its
    // session manager can still expose entries loaded before the parent intent.
    const transcript = target?.scanAssignment();
    if (transcript?.value) deny();
    if (transcript && transcript.value === undefined) throw verificationFailed();
    const verifyImages = () => {
      if (canonicalSessionPath(current) !== file) throw verificationFailed();
      if (isQueueMarkedSession(file)) deny();
      profile.verifyImage();
      transcript?.verifyImage();
    };
    verifyImages();
    return verifyImages;
  };
}

/** Public tools do not yet obtain a queue execution permit. A sidecar, a
 * manifest marker or the original queue task binding cannot opt in. */
export function denyQueueTransport(): never { throw new Error(disabled); }
