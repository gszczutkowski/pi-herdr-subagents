import { canonicalSessionPath, releaseSession, reserveSession, sessionOwners } from "./ownership.ts";
import { readRetainedCompletion, RetainedCompletionIndex, type CompletionResult } from "./completion.ts";
import { readChildIdentity, verifyRecoveryChild } from "./recovery-identity.ts";
import { probeProcess, sameProcess } from "./process-identity.ts";
import { assertSessionWriters, auditSession } from "./session-audit.ts";
import type { DurableRun, RuntimeStore } from "./runtime-store.ts";
import { reconcileContinuation } from "./live-continuation.ts";

/** Explicit resume decision for an artifact-only reservation. Neither a retained
 * completion nor a cached recovery outcome proves that a session is safe now.
 * Keep this synchronous through release so concurrent resumes cannot both win. */
export function releaseRecoveredSession(store: RuntimeStore, sessionFile: string): void {
  store.assertCustody();
  const path = canonicalSessionPath(sessionFile);
  const owner = sessionOwners.get(path);
  if (!owner || owner.surface) return;
  const run = store.getRun(owner.runId);
  if (!run || run.cli !== "pi" || canonicalSessionPath(run.sessionFile) !== path) return;
  const identity = readChildIdentity(path, run.id);
  if (!identity) return;
  const probe = probeProcess(identity.process.pid);
  if (probe.kind !== "absent" && !(probe.kind === "present" && !sameProcess(identity.process, probe.identity))) return;
  // The original process may be gone while a manually opened Pi still writes.
  // Incomplete/denied OS enumeration must not be mistaken for an empty set.
  assertSessionWriters(auditSession(path));
  store.assertCustody();
  if (sessionOwners.get(path) !== owner) throw new Error("Session ownership changed during recovered resume");
  store.reconcileRun(run.id, "exited: original process gone and session writer audit clear; explicit resume released reservation");
  releaseSession(path, run.id);
}

export interface RecoveryFailure { runId?: string; error: string }
export interface RecoveryStatus { state: "active" | "paused" | "stopped"; errors: readonly RecoveryFailure[] }
export interface RecoverySupervisor {
  (): void;
  /** One bounded artifact-only pass. No dispatch, launch, or custody acquisition. */
  reconcile(): RecoveryStatus;
  status(): RecoveryStatus;
}

/** Restart policy B. No launch builders, terminal APIs or task scripts here.
 * Reservations are synchronous, before the first identity probe/await. */
export async function reconcileRuntime(
  store: RuntimeStore,
  onEvidence: (run: DurableRun, completion: CompletionResult) => void,
  isCurrent: () => boolean,
  options: { onError?: (failure: RecoveryFailure) => void; maxEventsPerPass?: number } = {},
): Promise<RecoverySupervisor> {
  const limit = options.maxEventsPerPass ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Recovery pass limit must be 1..1000 events");
  store.assertCustody();
  const runs = store.listRuns().sort((a, b) => b.startTime - a.startTime);
  const reserved = new Set<string>();
  const baseline = new Map<string, string>();
  for (const run of runs) {
    const path = canonicalSessionPath(run.sessionFile);
    const previous = sessionOwners.get(path);
    if (previous) {
      // Same-run reservations must still pass a fresh identity probe. A different
      // run can contribute immutable evidence, never inherit writer controls.
      if (previous.runId === run.id) { reserved.add(run.id); continue; }
      const decision = `decision: session reserved by ${previous.runId}`;
      store.reconcileRun(run.id, decision); baseline.set(run.id, decision);
      continue;
    }
    const owner = reserveSession(path, run.id);
    owner.dispatched = true;
    owner.continuationRequestId = run.continuationRequestId;
    reserved.add(run.id);
  }
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let globalFailure: RecoveryFailure | undefined;
  let nextRun = 0;
  const current = () => !stopped && isCurrent();
  const verified = new Set<string>();
  const backlog = new Set(runs.map(run => run.id));
  const paused = new Map<string, RecoveryFailure>();
  const indexes = new Map(runs.map(run => [run.id, new RetainedCompletionIndex()]));
  const status = (): RecoveryStatus => ({ state: stopped ? "stopped" : globalFailure || paused.size ? "paused" : "active",
    errors: structuredClone([...(globalFailure ? [globalFailure] : []), ...paused.values()]) });
  const report = (failure: RecoveryFailure) => {
    try { options.onError?.(failure); } catch { /* Native timer diagnostics must not escape. */ }
  };
  const pauseRun = (run: DurableRun, error: unknown) => {
    const failure = { runId: run.id, error: `Recovered supervision paused: ${String(error)}; explicit reconciliation required` };
    paused.set(run.id, failure);
    try { store.reconcileRun(run.id, `paused: ${failure.error}`); } catch { /* The callback/status still reports failure if this disk is unavailable. */ }
    report(failure);
  };
  const checkCustody = () => {
    if (!current()) throw new Error("Parent runtime lost custody/current branch");
    store.assertCustody();
  };
  const harvest = (run: DurableRun, budget: { remaining: number }): void => {
    checkCustody();
    const owner = sessionOwners.get(canonicalSessionPath(run.sessionFile));
    if (owner?.runId === run.id) reconcileContinuation(owner, run, (requestId) => store.settleContinuation(run.id, requestId));
    while (budget.remaining > 0) {
      checkCustody();
      const cursor = store.committedEventIds(run.id);
      const before = cursor.size;
      const event = readRetainedCompletion(run.sessionFile, run.id, cursor, indexes.get(run.id));
      if (!event) { backlog.delete(run.id); return; }
      budget.remaining--; // Failed attempts count too; a partial failure cannot exceed the pass bound.
      onEvidence(run, event);
      if (store.committedEventIds(run.id).size <= before) throw new Error("Recovery failed to commit evidence cursor");
    }
    backlog.add(run.id); // A later bounded pass must check whether more remain.
  };
  const pass = (explicit = false): RecoveryStatus => {
    if (stopped || (globalFailure && !explicit)) return status();
    try { checkCustody(); globalFailure = undefined; }
    catch (error) {
      globalFailure = { error: `Recovered supervision paused: ${String(error)}; explicit reconciliation required` };
      report(globalFailure); return status();
    }
    if (explicit) nextRun = 0;
    const budget = { remaining: limit };
    const start = nextRun;
    for (let n = 0; n < runs.length && budget.remaining > 0; n++) {
      const index = (start + n) % runs.length;
      const run = runs[index];
      if (!explicit && (paused.has(run.id) || (!verified.has(run.id) && !backlog.has(run.id)))) continue;
      nextRun = (index + 1) % runs.length;
      try {
        harvest(run, budget);
        if (paused.has(run.id)) {
          store.reconcileRun(run.id, baseline.get(run.id) ?? "unverified: artifact reconciliation resumed; no terminal controls or automatic launch");
          paused.delete(run.id);
        }
      } catch (error) { pauseRun(run, error); }
    }
    return status();
  };
  for (const run of runs) {
    if (!current()) break;
    if (!reserved.has(run.id)) continue;
    const outcome = run.cli === "pi"
      ? await verifyRecoveryChild(run.sessionFile, run.id, store.generation, current) : "unverified";
    if (!current()) break;
    store.assertCustody();
    const decision = outcome === "verified-live"
      ? "verified-live: artifact-only supervision; terminal controls disabled"
      : outcome === "exited" ? "exited: decision required before another writer"
        : "unverified: decision required; no terminal controls or automatic launch";
    store.reconcileRun(run.id, decision); baseline.set(run.id, decision);
    if (outcome === "verified-live") verified.add(run.id);
  }
  pass();
  if (verified.size || backlog.size) {
    timer = setInterval(() => { pass(); }, 250);
    timer.unref?.();
  }
  const stop = (() => { stopped = true; if (timer) clearInterval(timer); }) as RecoverySupervisor;
  stop.status = status;
  stop.reconcile = () => pass(true);
  return stop;
}
