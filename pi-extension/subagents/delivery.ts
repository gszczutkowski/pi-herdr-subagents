import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markDelivery, type SubagentLifecycle } from "./lifecycle.ts";

export interface DeliveryOwner {
  id: string;
  lifecycle: SubagentLifecycle;
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
}

export interface DeliveryState {
  api?: Pick<ExtensionAPI, "sendMessage">;
  pending: Map<string, PendingDelivery>;
  timer?: ReturnType<typeof setTimeout>;
}

export function createDeliveryState(): DeliveryState {
  return { pending: new Map() };
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
): void {
  if (owner.lifecycle.delivery !== "pending") return;
  const envelope = freeze({
    message: structuredClone(message),
    options: { triggerTurn: true, deliverAs: "steer" } as Options,
  });
  state.pending.set(owner.id, { envelope, owner, onHandoff, attempts: 0, retryAt: 0 });
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
    if (entry.owner.lifecycle.delivery !== "pending") {
      state.pending.delete(id);
      continue;
    }
    if (entry.retryAt > Date.now()) continue;
    try {
      state.api.sendMessage(entry.envelope.message, entry.envelope.options);
    } catch {
      // Do not let a transport exception become a fabricated watcher error.
      entry.retryAt = Date.now() + Math.min(250 * 2 ** Math.min(entry.attempts++, 7), 30_000);
      continue;
    }
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
