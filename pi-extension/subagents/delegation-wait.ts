import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// An in-process, read-only query between the two Pi extensions. This is not a
// session message, a notification, or an additional source of runtime state.
export const DELEGATION_WAIT_QUERY = "pi-subagents:can-wait-for-delegation/v1";
export const DELEGATION_PAUSED = "pi-subagents:delegation-paused/v1";
export interface DelegationPause {
  sessionManager: ExtensionContext["sessionManager"];
  reason: string;
}
export interface DelegationWaitQuery {
  sessionManager: ExtensionContext["sessionManager"];
  confirm: () => void;
}

// A silent settlement has no result artifact. Remember that notification is owed
// across /reload, but never carry a stale Pi context or infer process liveness.
// The marker is scoped to this process, child run, session header and branch.
export function delegationWaitMarker() {
  const key = Symbol.for(`pi-subagents/delegation-wait/v1/${process.env.PI_SUBAGENT_ID}/${process.env.PI_SUBAGENT_SESSION}`);
  type Marker = { header: string; file: string; leaf: string };
  const state = globalThis as typeof globalThis & { [key: symbol]: Marker | undefined };
  return {
    remember(ctx: ExtensionContext) {
      const sm = ctx.sessionManager;
      const header = sm.getHeader()?.id, file = sm.getSessionFile(), leaf = sm.getLeafId();
      if (header && file && leaf) state[key] = { header, file, leaf };
    },
    matches(ctx: ExtensionContext) {
      const m = state[key];
      const sm = ctx.sessionManager;
      return !!m && m.header === sm.getHeader()?.id && m.file === sm.getSessionFile() &&
        sm.getBranch().some(entry => entry.id === m.leaf);
    },
    clear() { delete state[key]; },
  };
}

export function canWaitForDelegation(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  let confirmed = false;
  pi.events?.emit(DELEGATION_WAIT_QUERY, {
    sessionManager: ctx.sessionManager,
    confirm: () => { confirmed = true; },
  } satisfies DelegationWaitQuery);
  return confirmed;
}
