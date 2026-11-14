import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markDelivery, type SubagentLifecycle } from "./lifecycle.ts";

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
}

export interface DeliveryState {
  api?: Pick<ExtensionAPI, "sendMessage">;
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
  const eventId = `subagent:${owner.id}:completion${completionId ? `:${completionId}` : ""}`;
  // The first terminal callback owns the payload, including while a retry waits.
  if (owner.lifecycle.delivery !== "pending" || state.pending.has(eventId) || state.handedOff.has(eventId)) return;
  const snapshot = structuredClone(message);
  const envelope = freeze({
    message: { ...snapshot, details: { ...(snapshot.details as Record<string, unknown> | undefined), eventId } },
    options: { triggerTurn: true, deliverAs: "steer" } as Options,
  });
  state.pending.set(eventId, { envelope, owner, onHandoff, attempts: 0, retryAt: 0, inFlight: false });
  flushDeliveries(state);
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
    if (entry.owner.lifecycle.delivery !== "pending" || entry.owner.source?.lifecycle.delivery === "suppressed") {
      state.pending.delete(id);
      continue;
    }
    if (entry.inFlight || entry.retryAt > Date.now()) continue;
    entry.inFlight = true;
    try {
      state.api.sendMessage(entry.envelope.message, entry.envelope.options);
    } catch {
      // Do not let a transport exception become a fabricated watcher error.
      entry.retryAt = Date.now() + Math.min(250 * 2 ** Math.min(entry.attempts++, 7), 30_000);
      continue;
    } finally {
      entry.inFlight = false;
    }
    state.handedOff.add(id);
    entry.owner.lifecycle = markDelivery(entry.owner.lifecycle, "delivered");
    state.pending.delete(id);
    entry.onHandoff();
  }
  if (state.pending.size > 0 && state.api) {
    const next = Math.min(...Array.from(state.pending.values(), (entry) => entry.retryAt));
    state.timer = setTimeout(() => flushDeliveries(state), Math.max(1, next - Date.now()));
    state.timer.unref?.();
  }
}
