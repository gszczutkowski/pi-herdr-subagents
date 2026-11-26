import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { PlanSnapshot } from "./plan-store.ts";
import { areaContainsCwd, replacementRepairBlocker, sameAreaPath, type QueueFacts, type QueueRuntimeAdapter, type QueueRuntimeObservation, type WorkArea } from "./plan-queue.ts";

// Without explicit GIT_* overrides implicit discovery needs a worktree .git
// marker or a Git directory HEAD. Avoid spawning Git for plain directories.
function hasGitMarker(cwd: string): boolean {
  for (let path = cwd;; path = dirname(path)) {
    if (lstatSync(join(path, ".git"), { throwIfNoEntry: false }) || lstatSync(join(path, "HEAD"), { throwIfNoEntry: false })) return true;
    if (dirname(path) === path) return false;
  }
}
export function canonicalWorkArea(cwd: string, access: WorkArea["access"], gitTimeoutMs = 3000): WorkArea {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 8192 || cwd.includes("\0") || /[\r\n]/.test(cwd)) throw new Error("Work area must be an absolute directory");
  if (access !== "read" && access !== "write") throw new Error("Invalid work area access");
  const path = realpathSync.native(cwd);
  if (!statSync(path).isDirectory()) throw Object.assign(new Error("Work area must be an existing directory"), { code: "ENOTDIR" });
  const outsideGit = { cwd: path, root: path, kind: "directory" as const, access };
  if (!hasGitMarker(path)) return outsideGit;
  // Resolve actual checkout identity, not a caller's GIT_DIR/WORK_TREE/index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path, env: { ...env, LC_ALL: "C", LANG: "C" }, encoding: "utf8", timeout: gitTimeoutMs, killSignal: "SIGKILL", maxBuffer: 16_384,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }).replace(/\r?\n$/, "");
  } catch (error) {
    const result = error as { status?: number; stderr?: string };
    if (result.status === 128 && /^fatal: not a git repository\b/.test(result.stderr ?? "")) return outsideGit;
    throw new Error("Work area checkout identity could not be verified");
  }
  if (!isAbsolute(root) || root.includes("\0") || /[\r\n]/.test(root)) throw new Error("Invalid Git checkout location");
  const area: WorkArea = { cwd: path, root: realpathSync.native(root), kind: "git", access };
  if (!areaContainsCwd(area)) throw new Error("Work area is outside its detected Git checkout");
  return area;
}
export function sameWorkArea(a: WorkArea, b: WorkArea): boolean {
  return a.access === b.access && a.kind === b.kind && sameAreaPath(a.cwd, b.cwd) && sameAreaPath(a.root, b.root);
}
function checkWorkArea(area: WorkArea, gitTimeoutMs?: number): "verified" | "invalid" | "inconclusive" {
  try { return sameWorkArea(area, canonicalWorkArea(area.cwd, area.access, gitTimeoutMs)) ? "verified" : "invalid"; }
  catch (error) {
    // Git probing failures (including a timeout or missing Git) are wrapped by
    // canonicalWorkArea. Only an actual absent/non-directory path is invalid.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "invalid" : "inconclusive";
  }
}
export function verifiedWorkArea(area: WorkArea, gitTimeoutMs?: number): boolean {
  return checkWorkArea(area, gitTimeoutMs) === "verified";
}
export function queueRuntimeAvailable(plan: PlanSnapshot, adapter: QueueRuntimeAdapter | undefined): boolean {
  try { return adapter?.available(plan) === true; } catch { return false; }
}
export function inspectQueueRuntime(plan: PlanSnapshot, taskId: string, attemptId: string, runId: string, adapter?: QueueRuntimeAdapter): QueueRuntimeObservation {
  try {
    const observation = adapter?.inspect({ planId: plan.planId, authority: plan.authority, taskId, attemptId, runId });
    const proposal = observation && "proposal" in observation && observation.proposal === true;
    if (observation?.state === "settled" || observation?.state === "not_dispatched") return { state: observation.state, proposal };
    if (observation?.state === "working" && ["coordinator", "runtime"].includes(observation.owner)) return { state: observation.state, owner: observation.owner, proposal };
  } catch { /* A fault cannot establish positive proof. */ }
  return { state: "unknown" };
}
export const QUEUE_VIEW_AREA_CHECK_LIMIT = 4;
const QUEUE_VIEW_GIT_TIMEOUT_MS = 150;

function occupiedTasks(plan: PlanSnapshot) {
  return plan.tasks.filter(task => {
    const reservation = task.attempts.at(-1)?.reservation;
    return reservation && reservation.phase !== "released";
  });
}
const areaKey = (area: WorkArea) => JSON.stringify([area.cwd, area.root, area.kind]);

/** Transactions never reuse projection data: verify the target and every active
 * resource peer (at most 32), but no unrelated pending task. */
export function collectQueueAdmissionFacts(plan: PlanSnapshot, writable: boolean, adapter: QueueRuntimeAdapter | undefined, taskId: string): QueueFacts {
  const available = writable && queueRuntimeAvailable(plan, adapter);
  const checkedTaskIds = new Set<string>();
  const verifiedTaskIds = new Set<string>();
  const target = plan.tasks.find(task => task.taskId === taskId);
  if (available && plan.queue && !plan.queue.pause && target) {
    const checked = new Map<string, boolean>();
    for (const task of [target, ...occupiedTasks(plan)]) {
      if (!task.workArea) continue;
      const key = areaKey(task.workArea);
      if (!checked.has(key)) checked.set(key, verifiedWorkArea(task.workArea));
      checkedTaskIds.add(task.taskId);
      if (checked.get(key)) verifiedTaskIds.add(task.taskId);
    }
  }
  return { writable, available, checkedTaskIds, verifiedTaskIds };
}

// Internal capability, not a tool argument or a durable/public pagination token.
declare const queueFactsCursorBrand: unique symbol;
export type QueueFactsCursor = { readonly [queueFactsCursorBrand]: true };
interface PinnedFacts {
  plan: PlanSnapshot;
  writable: boolean;
  adapter: QueueRuntimeAdapter | undefined;
  runtimeStamp: string;
  sampled: ReadonlyMap<string, ReturnType<typeof checkWorkArea>>;
}
const pinned = new WeakMap<QueueFactsCursor, PinnedFacts>();

/** Each slice checks up to four new distinct areas (including failed checks)
 * and reobserves at most 32 active intent bindings. Resume against the same
 * immutable snapshot instance and runtime; a changed observation or custody
 * means restart. The filesystem samples are not an atomic snapshot: they're
 * advisory and valid only for this read, never for admission. A future caller
 * must drain slices or expose partial coverage, not translate it to no work. */
export function collectQueueFacts(plan: PlanSnapshot, writable: boolean, adapter?: QueueRuntimeAdapter, cursor?: QueueFactsCursor): QueueFacts & { readonly cursor?: QueueFactsCursor } {
  const prior = cursor === undefined ? undefined : pinned.get(cursor);
  if (cursor !== undefined && (!prior || prior.plan !== plan || prior.writable !== writable || prior.adapter !== adapter)) {
    throw new Error("Queue projection cursor does not match snapshot, authority or runtime adapter");
  }
  const available = !!plan.queue && writable && queueRuntimeAvailable(plan, adapter);
  const checkedTaskIds = new Set<string>();
  const verifiedTaskIds = new Set<string>();
  const deferredTaskIds = new Set<string>();
  const inconclusiveTaskIds = new Set<string>();
  const observations = new Map<string, QueueRuntimeObservation>();
  const facts = { writable, available, checkedTaskIds, verifiedTaskIds, deferredTaskIds, inconclusiveTaskIds, observations };
  const occupied = available ? occupiedTasks(plan) : [];
  for (const task of occupied) {
    const attempt = task.attempts.at(-1)!;
    const runId = attempt.reservation?.runId;
    if (runId) observations.set(attempt.attemptId, inspectQueueRuntime(plan, task.taskId, attempt.attemptId, runId, adapter));
  }
  const runtimeStamp = JSON.stringify([available, [...observations]]);
  if (prior && prior.runtimeStamp !== runtimeStamp) throw new Error("Queue projection runtime state changed; restart read");
  if (!available || !plan.queue) return facts;

  const assigned = occupied.filter(task => task.status === "in_progress" && !task.attempts.at(-1)?.reservation?.runId);
  const pending = [];
  if (!plan.queue.pause && occupied.length < plan.queue.maxActive) {
    const accepted = new Set(plan.tasks.filter(task => task.status === "accepted").map(task => task.taskId));
    for (const task of plan.tasks) if (task.status === "pending" && task.workArea && !replacementRepairBlocker(task) &&
      task.dependencies.every(id => accepted.has(id))) pending.push(task);
  }
  // Check unstarted reservations first so vanished CWDs can be released.
  const relevant = pending.length || (assigned.length && !plan.queue.pause) ? [...assigned, ...occupied, ...pending] : assigned;
  const sampled = new Map(prior?.sampled);
  let budget = QUEUE_VIEW_AREA_CHECK_LIMIT;
  for (const task of relevant) {
    const area = task.workArea;
    if (!area) continue;
    const key = areaKey(area);
    if (!sampled.has(key) && budget > 0) {
      budget--;
      sampled.set(key, checkWorkArea(area, QUEUE_VIEW_GIT_TIMEOUT_MS));
    }
    const observation = sampled.get(key);
    if (observation === undefined) deferredTaskIds.add(task.taskId);
    else if (observation === "inconclusive") inconclusiveTaskIds.add(task.taskId);
    else {
      checkedTaskIds.add(task.taskId);
      if (observation === "verified") verifiedTaskIds.add(task.taskId);
    }
  }
  // A new read resamples inconclusive I/O. Continuing this read would keep
  // the same incomplete image and cannot turn a timeout into invalidity.
  if (!deferredTaskIds.size) return facts;
  const next = Object.freeze({}) as QueueFactsCursor;
  pinned.set(next, { plan, writable, adapter, runtimeStamp, sampled });
  return { ...facts, cursor: next };
}
