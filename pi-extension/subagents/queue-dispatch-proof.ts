import { confirmedUnsent, type DispatchIncident } from "./dispatch-recovery.ts";
import { samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import { dispatchFailureEventId, type RuntimeStore } from "./runtime-store.ts";

export type QueueDispatchProof =
  | { kind: "not_dispatched"; runId: string }
  | { kind: "working"; runId: string; owner: "coordinator" | "runtime" }
  | { kind: "uncertain"; runId: string; reason: "custody" | "binding" | "dispatch" | "continuation" | "tree_unaccounted" };

interface DispatchClaim { runId: string; binding: PlanTaskBinding }
interface CurrentSupervision {
  runId: string;
  store: DispatchStore;
  owner: "coordinator" | "runtime";
}

type DispatchStore = Pick<RuntimeStore, "dispatchCustody" | "getRun" | "getEvent">;

/** Corroborate a *committed* plan-side dispatch claim, under the original runtime
 * writer. The caller selects the current parent/branch and supplies its current
 * supervision and journal diagnostics (not saved history or child claims).
 * Missing run/manifest is never proof of a non-send. A prepared run alone is
 * still in flight. Nothing here attests to the closure of an execution tree. */
export function queueDispatchProof(claim: DispatchClaim, runtime: {
  store: DispatchStore;
  incidents: ReadonlyMap<string, Pick<DispatchIncident, "status" | "phase">>;
  storageUncertain: boolean;
  supervised?: CurrentSupervision;
} | undefined): QueueDispatchProof {
  const { runId, binding } = claim;
  const uncertain = (reason: Extract<QueueDispatchProof, { kind: "uncertain" }>["reason"]): QueueDispatchProof => ({ kind: "uncertain", runId, reason });
  if (!runtime || runtime.storageUncertain) return uncertain("custody");
  try {
    // The writer supplying the run also supplies its current custody. A cached
    // manifest could predate pauseCustody even when its writer lease is live.
    const custody = runtime.store.dispatchCustody();
    if (custody.custodyPaused !== undefined || custody.parent.headerId !== binding.authority.sessionId) return uncertain("custody");
    const run = runtime.store.getRun(runId);
    if (!run || run.id !== runId || !samePlanBinding(run.planTask, binding)) return uncertain("binding");
    if (run.continuationRequestId !== undefined) return uncertain("continuation");
    const incident = runtime.incidents.get(runId);
    if (incident && incident.status !== "resolved") return uncertain("dispatch");
    const live = runtime.supervised?.runId === runId ? runtime.supervised : undefined;
    if (live && live.store !== runtime.store) return uncertain("custody");
    if (run.phase === "prepared") {
      const onlyFailureEvent = run.eventCursor.length === 1 && run.eventCursor[0] === dispatchFailureEventId(runId);
      return !live && onlyFailureEvent && incident?.phase !== "send-possible" && confirmedUnsent(runtime.store, run)
        ? { kind: "not_dispatched", runId } : uncertain("dispatch");
    }
    if (live && (run.phase === "supervised" || run.dispatchVerified === true)) return { kind: "working", runId, owner: live.owner };
    return uncertain(run.phase === "dispatch-intent" && !incident ? "dispatch" : "tree_unaccounted");
  } catch {
    return uncertain("custody");
  }
}
