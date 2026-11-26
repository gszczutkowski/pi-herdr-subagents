import { Value } from "@sinclair/typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalSessionPath } from "./ownership.ts";
import type { PlanPersistence } from "./plan-persistence.ts";
import { PlanTaskParams, type PlanTaskBinding, type PlanTaskSelection } from "./plan-runtime.ts";
import { beginQueueDispatch, verifyQueueDispatchIntent } from "./plan-store.ts";
import { createQueueRuntimeAdapter, type QueueRuntimeSource } from "./queue-runtime-adapter.ts";
import { dispatchRunIdPattern, type RuntimeStore } from "./runtime-store.ts";

/** Internal first-launch primitive. No registered tool issues this permit yet:
 * descendant allocation/settlement and continuation gates must land first.
 * The caller must keep it local to the initiating tool invocation, prepare a
 * Pi run with `binding`, and use `commitBeforeSend` only at the synchronous
 * transport boundary. The runtime source is trusted local code. */
export function beginQueueLaunch(
  persistence: PlanPersistence,
  sm: ExtensionContext["sessionManager"],
  store: RuntimeStore,
  selection: PlanTaskSelection,
  launch: { runId: string; sessionFile: string; cwd: string },
  source: QueueRuntimeSource,
): { readonly binding: PlanTaskBinding; readonly commitBeforeSend: () => void } {
  if (!Value.Check(PlanTaskParams, selection) || !dispatchRunIdPattern.test(launch.runId)) {
    throw new Error("Invalid queue dispatch selection or run ID");
  }
  const { planId, taskId, attemptId, expectedRevision } = selection;
  const { runId, cwd, sessionFile: requestedPath } = launch;
  const sessionFile = canonicalSessionPath(requestedPath);
  // Admission requires an unused ID, while the transport boundary requires
  // the exact prepared run under that ID. Both checks use current evidence.
  const claimAdapter = createQueueRuntimeAdapter(persistence, sm, store, source, { runId, sessionFile, stage: "claim" });
  const adapter = createQueueRuntimeAdapter(persistence, sm, store, source, { runId, sessionFile, stage: "prepare" });
  claimAdapter.assertCustody();
  const plan = persistence.mutate(sm, planId, expectedRevision, (p, c) =>
    beginQueueDispatch(p, c, taskId, attemptId, runId, cwd, claimAdapter));
  const binding: PlanTaskBinding = { planId, taskId, attemptId, authority: { ...plan.authority } };
  let consumed = false;
  return Object.freeze({
    binding: structuredClone(binding),
    commitBeforeSend() {
      if (consumed) throw new Error("Queue dispatch permit is already consumed");
      // Spend it even if validation or the durable write fails. Recovery never
      // recreates it from an uncertain plan entry or a prepared manifest run.
      consumed = true;
      adapter.assertCustody();
      const { snapshot, writable, error } = persistence.read(sm);
      if (!writable || snapshot?.planId !== planId) throw new Error(error ?? "Original writable queue plan is not selected");
      const run = store.getRun(runId);
      if (run?.cli !== "pi" || canonicalSessionPath(requestedPath) !== sessionFile) throw new Error("Queue dispatch requires the original prepared Pi session");
      const profile = run.profile;
      if (typeof profile !== "object" || profile === null || !("cwd" in profile) || typeof profile.cwd !== "string") {
        throw new Error("Queue dispatch requires the prepared Pi launch profile cwd");
      }
      // Check the effective CWD from the prepared launch, not just the CWD
      // declared when obtaining the permit. Transport must use this profile.
      verifyQueueDispatchIntent(snapshot, { ...binding.authority, expectedRevision: snapshot.revision }, taskId, attemptId, runId, profile.cwd, adapter);
      adapter.assertCustody();
      store.commitFreshDispatch(runId, sessionFile, binding);
    },
  });
}
