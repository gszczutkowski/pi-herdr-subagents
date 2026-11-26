import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlan, detachPlan, deserializePlan, serializePlan, type Authority, type CommandContext, type PlanSnapshot } from "./plan-store.ts";

export const PLAN_ENTRY = "pi-subagents-plan/v1";
export const PLAN_ENTRY_V2 = "pi-subagents-plan/v2";
const planEntryType = (plan: PlanSnapshot) => plan.schemaVersion === 2 ? PLAN_ENTRY_V2 : PLAN_ENTRY;
const isKnownPlanEntry = (type: string) => type === PLAN_ENTRY || type === PLAN_ENTRY_V2;
function loadEntry(customType: string, data: unknown): PlanSnapshot {
  if (!isKnownPlanEntry(customType)) throw new Error(`Unsupported plan entry schema: ${customType}; writes disabled`);
  const plan = deserializePlan(JSON.stringify(data));
  if (planEntryType(plan) !== customType) throw new Error("Plan entry and payload schema mismatch; writes disabled");
  return plan;
}
type Manager = ExtensionContext["sessionManager"];
// Pi can append to its in-memory tree before disk append throws. Keep the failure
// latch across extension reloads; only explicit disk reconciliation clears it.
const globalState = globalThis as typeof globalThis & { __subagentPlanFaults?: Map<string, string> };
const faults = globalState.__subagentPlanFaults ??= new Map();

export interface PlanView {
  readonly snapshot?: PlanSnapshot;
  readonly writable: boolean;
  readonly error?: string;
  readonly recoveryUncertain: readonly string[];
  readonly detachRequired?: "foreign" | "historical";
}

export class PlanPersistence {
  private recovery = new Map<string, string | undefined>();
  private listeners = new Set<(sm: Manager) => void>();
  subscribe(listener: (sm: Manager) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(sm: Manager): void {
    // A failed presentation observer must not change a durable command's result.
    for (const listener of this.listeners) { try { listener(sm); } catch { /* UI is best effort. */ } }
  }
  private readonly append: ExtensionAPI["appendEntry"];
  private readonly child: boolean;
  constructor(append: ExtensionAPI["appendEntry"], child: boolean) { this.append = append; this.child = child; }

  private key(sm: Manager): string { return sm.getSessionFile() ?? sm.getSessionId(); }
  private latest(sm: Manager) {
    return sm.getBranch().findLast(entry => entry.type === "custom" && entry.customType.startsWith("pi-subagents-plan/"));
  }
  private load(sm: Manager): PlanSnapshot | undefined {
    const entry = this.latest(sm);
    if (!entry || entry.type !== "custom") return undefined;
    return loadEntry(entry.customType, entry.data);
  }
  restore(sm: Manager): PlanView {
    this.recovery.clear();
    const view = this.read(sm);
    for (const task of view.snapshot?.tasks ?? []) {
      if (task.status === "in_progress") this.recovery.set(task.taskId, task.attempts.at(-1)?.attemptId);
    }
    const restored = this.read(sm);
    this.changed(sm);
    return restored;
  }
  private storageError(sm: Manager): string | undefined {
    return faults.get(this.key(sm)) ?? (this.child ? "Child sessions cannot write parent plans" :
      !sm.getSessionFile() || !existsSync(sm.getSessionFile()!) || !sm.getBranch().some(e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"))
        ? "A durable session with an actual user/assistant message is required (not --no-session or setup-only)" : undefined);
  }
  private historical(sm: Manager, plan: PlanSnapshot): boolean {
    const latest = this.latest(sm);
    if (!latest) return false;
    const active = new Set(sm.getBranch().map(entry => entry.id));
    // Tree topology only determines whether this snapshot has an abandoned future.
    // Snapshot selection/content ALWAYS comes exclusively from getBranch().
    type Node = ReturnType<Manager["getTree"]>[number];
    const abandonedFuture = (node: Node): boolean => {
      // An explicit detach marks a different branch, not a future of this one.
      // Never restore snapshot state from another path. Only a validated detach
      // can exempt that path from rollback detection; malformed data stays read-only.
      const entry = node.entry;
      if (entry.type === "custom" && entry.customType.startsWith("pi-subagents-plan/")) {
        const identity = entry.data as Partial<PlanSnapshot> | undefined;
        if (identity?.planId !== plan.planId && identity?.authority?.branchInstanceId !== plan.authority.branchInstanceId &&
          identity?.source?.planId === plan.planId && identity.source.authority?.sessionId === plan.authority.sessionId &&
          identity.source.authority?.branchInstanceId === plan.authority.branchInstanceId) {
          try { loadEntry(entry.customType, identity); return false; }
          catch { /* An invalid descendant is not proof of an independent branch. */ }
        }
        return true;
      }
      return node.children.length === 0 || node.children.some(abandonedFuture);
    };
    const pending = [...sm.getTree()];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.entry.id === latest.id) {
        const descendants = [...node.children];
        while (descendants.length) {
          const descendant = descendants.pop()!;
          if (!active.has(descendant.entry.id)) {
            if (abandonedFuture(descendant)) return true;
          } else descendants.push(...descendant.children);
        }
        return false;
      }
      pending.push(...node.children);
    }
    return false;
  }
  read(sm: Manager): PlanView {
    try {
      const snapshot = this.load(sm);
      const detachRequired = snapshot && (snapshot.authority.sessionId !== sm.getSessionId() ? "foreign" : this.historical(sm, snapshot) ? "historical" : undefined);
      const error = this.storageError(sm) ?? (detachRequired ? `${detachRequired === "foreign" ? "Foreign inherited" : "Historical"} plan is read-only; detach explicitly before editing` : undefined);
      return { snapshot, writable: !error, ...(detachRequired ? { detachRequired } : {}), ...(error ? { error } : {}), recoveryUncertain: [...this.recovery].filter(([id, attemptId]) => snapshot?.tasks.some(t => t.taskId === id && t.status === "in_progress" && t.attempts.at(-1)?.attemptId === attemptId)).map(([id]) => id) };
    } catch (error) {
      return { writable: false, error: String(error), recoveryUncertain: [] };
    }
  }
  reconcile(sm: Manager): PlanView {
    if (this.child) throw new Error("Child sessions cannot reconcile parent plan storage");
    // Never trust the possibly advanced in-memory leaf after a failed append.
    const file = sm.getSessionFile();
    if (!file || !existsSync(file)) throw new Error("Cannot reconcile an ephemeral/unflushed session");
    const disk = SessionManager.open(file);
    const leaf = sm.getLeafId();
    if (leaf && !disk.getEntry(leaf)) throw new Error("Session memory is ahead of disk; resume/reopen the durable session before reconciling");
    if (leaf) disk.branch(leaf); else disk.resetLeaf();
    const durable = this.load(disk);
    if (JSON.stringify(durable) !== JSON.stringify(this.load(sm))) throw new Error("Plan memory/disk mismatch; reopen session");
    faults.delete(this.key(sm));
    return this.restore(sm);
  }
  private requireWritable(sm: Manager): PlanView {
    const view = this.read(sm);
    if (!view.writable) throw new Error(view.error);
    return view;
  }
  private save(sm: Manager, plan: PlanSnapshot): PlanSnapshot {
    const validated = deserializePlan(serializePlan(plan));
    try {
      this.append(planEntryType(validated), validated);
      if (!existsSync(sm.getSessionFile()!)) throw new Error("Session append was not durable");
    } catch (error) {
      const message = `Plan append failed; writes disabled until explicit reconcile: ${String(error)}`;
      faults.set(this.key(sm), message);
      this.changed(sm);
      throw new Error(message);
    }
    this.changed(sm);
    return validated;
  }
  create(sm: Manager, expectedRevision: number, title: string): PlanSnapshot {
    const view = this.requireWritable(sm);
    if (view.snapshot) throw new Error("Plan already exists");
    if (expectedRevision !== 0) throw new Error("Revision conflict");
    return this.save(sm, createPlan(title, { sessionId: sm.getSessionId(), branchInstanceId: randomUUID() }));
  }
  detach(sm: Manager, planId: string, expectedRevision: number, reason: string): PlanSnapshot {
    const error = this.storageError(sm);
    if (error) throw new Error(error);
    const plan = this.load(sm);
    if (!plan) throw new Error("No active plan to detach");
    if (plan.planId !== planId) throw new Error("Plan identity conflict");
    if (plan.revision !== expectedRevision) throw new Error("Revision conflict");
    const detached = detachPlan(plan, { sessionId: sm.getSessionId(), branchInstanceId: randomUUID() }, this.latest(sm)!.id, reason);
    return this.save(sm, detached);
  }
  /** Authoritative parent command boundary shared by plan_update and plan-runtime
   * attach/result/failure imports. All use bounded plan-store commands; children
   * propose results, never replace snapshots or certify their own acceptance.
   * Synchronous compare-command-append serializes mutations in this Pi process,
   * including parallel execute calls. Not cross-process storage CAS or an OS lock. */
  mutate(sm: Manager, planId: string, expectedRevision: number, command: (plan: PlanSnapshot, context: CommandContext) => PlanSnapshot, origin?: Authority): PlanSnapshot {
    const plan = this.requireWritable(sm).snapshot;
    if (!plan) throw new Error("No active plan");
    if (plan.planId !== planId) throw new Error("Plan identity conflict");
    if (origin && (origin.sessionId !== plan.authority.sessionId || origin.branchInstanceId !== plan.authority.branchInstanceId)) throw new Error("Result origin authority mismatch; select its original branch");
    if (expectedRevision !== plan.revision) throw new Error("Revision conflict");
    const next = command(plan, { ...plan.authority, expectedRevision });
    if (next === plan) return plan;
    return this.save(sm, next);
  }
}
