import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLifecycle, markDelivery, type SubagentLifecycle } from "./lifecycle.ts";
import { messageNotificationReason, notificationOptions } from "./notification-policy.ts";
import { hasAfterIntentMarker } from "./runtime-store.ts";

export interface DeliveryOwner {
  id: string;
  lifecycle: SubagentLifecycle;
  source?: DeliveryOwner;
}

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
type Options = NonNullable<Parameters<ExtensionAPI["sendMessage"]>[1]>;

export interface DeliveryEnvelope {
  readonly message: Message;
  readonly options: Options;
}

interface PendingDelivery {
  readonly envelope: DeliveryEnvelope;
  readonly owner: DeliveryOwner;
  readonly onHandoff: () => void;
  attempts: number;
  retryAt: number;
  inFlight: boolean;
  parked?: boolean;
  store?: import("./runtime-store.ts").RuntimeStore;
  failure?: { stage: "before-send" | "retry-reset" | "after-send"; error: string };
}

export interface DeliveryState {
  onEnvelope?: (runId: string, envelope: DeliveryEnvelope) => void;
  onPark?: (store: PendingDelivery["store"], error: string) => void;
  api?: Pick<ExtensionAPI, "sendMessage">;
  store?: import("./runtime-store.ts").RuntimeStore;
  persistenceError?: string;
  pending: Map<string, PendingDelivery>;
  handedOff: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

export function createDeliveryState(): DeliveryState {
  return { pending: new Map(), handedOff: new Set() };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot once: retries must not rebuild or mutate a completion. */
export function enqueueDelivery(
  state: DeliveryState,
  owner: DeliveryOwner,
  message: Message,
  onHandoff: () => void,
  completionId?: string,
): void {
  const options = notificationOptions(messageNotificationReason(message));
  if (!options) return; // Presentation/progress never enters the waking outbox.
  const eventId = `subagent:${owner.id}:completion${completionId ? `:${completionId}` : ""}`;
  // The first terminal callback owns the payload, including while a retry waits.
  if (owner.lifecycle.delivery !== "pending" || state.pending.has(eventId) || state.handedOff.has(eventId)) return;
  const snapshot = structuredClone(message);
  const envelope = freeze({
    message: { ...snapshot, details: { ...(snapshot.details as Record<string, unknown> | undefined), eventId } },
    options,
  });
  if (hasAfterIntentMarker(envelope)) throw new Error("After-intent dispatch failure evidence is import-only");
  // Persist before publication; callbacks and owners are never serialized.
  state.store?.enqueue(eventId, owner.id, envelope);
  state.pending.set(eventId, { envelope, owner, onHandoff, attempts: 0, retryAt: 0, inFlight: false, store: state.store });
  // Plan import is a separate projection: its failure must never suppress delivery.
  try { state.onEnvelope?.(owner.id, envelope); } catch { /* Retained in durable outbox for import retry. */ }
  flushDeliveries(state);
}

/** Reconstruct callbacks from stable IDs, never executable serialized state. */
export function restoreDurableDeliveries(
  state: DeliveryState,
  store: import("./runtime-store.ts").RuntimeStore,
  branchEventIds: ReadonlySet<string>,
): void {
  for (const [id, event] of Object.entries(store.snapshot().outbox)) {
    if (hasAfterIntentMarker(event.envelope) || store.hasMalformedAfterIntentCursor(event.runId)) {
      // Quarantine even when the branch appears to acknowledge the event.
      // Notification handoff cannot convert a persisted claim into proof.
      state.pending.delete(id);
      if (event.status === "handedOff") state.handedOff.add(id);
      else state.handedOff.delete(id);
      continue;
    }
    if (branchEventIds.has(id) && event.status !== "handedOff") store.delivery(id, "handedOff");
    if (event.status === "handedOff" || branchEventIds.has(id)) {
      state.handedOff.add(id);
      state.pending.delete(id);
      continue;
    }
    if (state.pending.has(id)) continue;
    state.pending.set(id, {
      envelope: freeze(structuredClone(event.envelope)),
      owner: { id: event.runId, lifecycle: createLifecycle(Date.now()) },
      onHandoff: () => {}, attempts: 0, retryAt: 0, inFlight: false,
      parked: event.status === "dispatching", store,
    });
  }
}

function parkDelivery(state: DeliveryState, id: string, entry: PendingDelivery,
  stage: NonNullable<PendingDelivery["failure"]>["stage"], error: unknown): void {
  entry.parked = true;
  entry.failure = { stage, error: `Delivery ${id} paused at ${stage}: ${String(error)}` };
  state.persistenceError = entry.failure.error;
  try { state.onPark?.(entry.store, entry.failure.error); } catch { /* Diagnostics cannot interrupt delivery bookkeeping. */ }
}

/** Per-event errors survive later failures so recovery reports retain the actual stage. */
export function deliveryDiagnostics(state: DeliveryState): string[] {
  return [...new Set([
    ...Array.from(state.pending.values()).flatMap(entry => entry.failure ? [entry.failure.error] : []),
    ...(state.persistenceError ? [state.persistenceError] : []),
  ])];
}

/** Explicit bounded recovery only for a proven-unsent event in this exact store.
 * A failed dispatching commit can itself be ambiguous; pending on validated disk
 * is mandatory. Never reset/replay dispatching or an after-send persistence fault. */
export function reconcileUnsentDeliveries(state: DeliveryState, limit = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid delivery reconciliation limit");
  const store = state.store;
  if (!store) return 0;
  store.assertCustody();
  if (store.snapshot().custodyPaused) throw new Error("Delivery reconciliation requires unpaused branch custody");
  let recovered = 0;
  for (const [id, entry] of state.pending) {
    if (recovered >= limit) break;
    if (!entry.parked || entry.failure?.stage !== "before-send" || entry.inFlight || entry.store !== store ||
        store.hasMalformedAfterIntentCursor(entry.owner.id) || entry.owner.lifecycle.delivery !== "pending" ||
        entry.owner.source?.lifecycle.delivery === "suppressed") continue;
    const event = store.getEvent(id);
    if (event?.status !== "pending" || event.runId !== entry.owner.id ||
        JSON.stringify(event.envelope) !== JSON.stringify(entry.envelope)) continue;
    // assertCustody checks the writer, on-disk revision/content, and active branch.
    store.assertCustody();
    if (state.persistenceError === entry.failure.error) state.persistenceError = undefined;
    entry.failure = undefined;
    entry.parked = false;
    entry.retryAt = 0;
    recovered++;
  }
  return recovered;
}

export function pauseDeliveries(state: DeliveryState): void {
  state.api = undefined;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
}

/** Normal void return is synchronous handoff only; asynchronous failures are invisible. */
export function flushDeliveries(state: DeliveryState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  if (!state.api) return;
  for (const [id, entry] of state.pending) {
    if (hasAfterIntentMarker(entry.envelope) || state.store?.hasMalformedAfterIntentCursor(entry.owner.id) ||
        entry.owner.lifecycle.delivery !== "pending" || entry.owner.source?.lifecycle.delivery === "suppressed") {
      state.pending.delete(id);
      continue;
    }
    if (entry.parked || entry.inFlight || entry.retryAt > Date.now()) continue;
    entry.inFlight = true;
    try {
      state.store?.delivery(id, "dispatching");
    } catch (error) {
      parkDelivery(state, id, entry, "before-send", error);
      entry.inFlight = false;
      continue;
    }
    try {
      state.api.sendMessage(entry.envelope.message, entry.envelope.options);
    } catch {
      // A synchronous rejection permits an in-process retry. A crash during
      // dispatch remains UNKNOWN on disk and must not be blindly replayed.
      try { state.store?.delivery(id, "pending"); }
      catch (error) { parkDelivery(state, id, entry, "retry-reset", error); }
      entry.retryAt = Date.now() + Math.min(250 * 2 ** Math.min(entry.attempts++, 7), 30_000);
      continue;
    } finally {
      entry.inFlight = false;
    }
    try { state.store?.delivery(id, "handedOff"); }
    catch (error) {
      parkDelivery(state, id, entry, "after-send", error);
      continue;
    }
    state.handedOff.add(id);
    entry.owner.lifecycle = markDelivery(entry.owner.lifecycle, "delivered");
    state.pending.delete(id);
    entry.onHandoff();
  }
  const retryable = Array.from(state.pending.values()).filter((entry) => !entry.parked);
  if (retryable.length > 0 && state.api) {
    const next = Math.min(...retryable.map((entry) => entry.retryAt));
    state.timer = setTimeout(() => flushDeliveries(state), Math.max(1, next - Date.now()));
    state.timer.unref?.();
  }
}
