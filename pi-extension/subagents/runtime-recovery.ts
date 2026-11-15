import { canonicalSessionPath, releaseSession, reserveSession, sessionOwners } from "./ownership.ts";
import { readRetainedCompletion, type CompletionResult } from "./completion.ts";
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
  const run = store.snapshot().runs[owner.runId];
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

/** Restart policy B. No launch builders, terminal APIs or task scripts here.
 * Reservations are synchronous, before the first identity probe/await. */
export async function reconcileRuntime(
  store: RuntimeStore,
  onEvidence: (run: DurableRun, completion: CompletionResult) => void,
  isCurrent: () => boolean,
): Promise<() => void> {
  const runs = Object.values(store.snapshot().runs).sort((a, b) => b.startTime - a.startTime);
  const reserved = new Set<string>();
  for (const run of runs) {
    const path = canonicalSessionPath(run.sessionFile);
    const previous = sessionOwners.get(path);
    if (previous) {
      // Re-establish artifact-only supervision after a temporary suspension.
      // The same run keeps its reservation, but must pass a fresh identity probe.
      if (previous.runId === run.id) { reserved.add(run.id); continue; }
      // Another run in this manifest cannot inherit a writer reservation.
      store.reconcileRun(run.id, `decision: session reserved by ${previous.runId}`);
      continue;
    }
    const owner = reserveSession(path, run.id);
    owner.dispatched = true;
    owner.continuationRequestId = run.continuationRequestId;
    // No recovered surface: presence cannot prove pane -> process binding.
    reserved.add(run.id);
  }
  let stopped = false;
  const current = () => !stopped && isCurrent();
  const verified = new Set<string>();
  const harvest = (run: DurableRun) => {
    if (!current()) return;
    store.assertCustody();
    const owner = sessionOwners.get(canonicalSessionPath(run.sessionFile));
    if (owner?.runId === run.id) reconcileContinuation(owner, run, (requestId) => store.settleContinuation(run.id, requestId));
    // Drain only immutable run-bound evidence, never terminal output or transcript
    // tails from another invocation. The outbox transaction advances the cursor.
    for (;;) {
      if (!current()) return;
      store.assertCustody();
      const before = store.snapshot().runs[run.id].eventCursor;
      const event = readRetainedCompletion(run.sessionFile, run.id, before);
      if (!event) return;
      onEvidence(run, event);
      const after = store.snapshot().runs[run.id].eventCursor;
      if (after.length <= before.length) throw new Error("Recovery failed to commit evidence cursor");
    }
  };
  for (const run of runs) {
    if (!current()) break;
    if (!reserved.has(run.id)) { harvest(run); continue; }
    const outcome = run.cli === "pi"
      ? await verifyRecoveryChild(run.sessionFile, run.id, store.generation, current) : "unverified";
    // Fence every asynchronous probe before touching state or installing a timer.
    if (!current()) break;
    store.assertCustody();
    store.reconcileRun(run.id, outcome === "verified-live"
      ? "verified-live: artifact-only supervision; terminal controls disabled"
      : outcome === "exited" ? "exited: decision required before another writer"
        : "unverified: decision required; no terminal controls or automatic launch");
    if (outcome === "verified-live") verified.add(run.id);
    // Durable events can be reconciled even when the child is dead/unverified.
    harvest(run);
  }
  const timer = verified.size ? setInterval(() => {
    if (!current()) { clearInterval(timer); return; }
    try { for (const run of runs) if (verified.has(run.id)) harvest(run); }
    catch { stopped = true; clearInterval(timer); }
  }, 250) : undefined;
  timer?.unref?.();
  return () => { stopped = true; if (timer) clearInterval(timer); };
}
