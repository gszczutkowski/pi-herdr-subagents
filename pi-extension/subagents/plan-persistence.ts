import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SessionManager, type ExtensionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlan, deserializePlan, serializePlan, type Authority, type CommandContext, type PlanSnapshot } from "./plan-store.ts";

export const PLAN_ENTRY = "pi-subagents-plan/v1";
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
}

export class PlanPersistence {
  private recovery = new Set<string>();
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
    if (entry.customType !== PLAN_ENTRY) throw new Error(`Unsupported plan entry schema: ${entry.customType}; writes disabled`);
    return deserializePlan(JSON.stringify(entry.data));
  }
  restore(sm: Manager): PlanView {
    this.recovery.clear();
    const view = this.read(sm);
    for (const task of view.snapshot?.tasks ?? []) {
      if (task.status === "in_progress") this.recovery.add(task.taskId);
    }
    return this.read(sm);
  }
  read(sm: Manager): PlanView {
    try {
      const snapshot = this.load(sm);
      const error = faults.get(this.key(sm)) ?? (this.child ? "Child sessions cannot write parent plans" :
        !sm.getSessionFile() || !existsSync(sm.getSessionFile()!) || !sm.getBranch().some(e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant")) ? "A durable session with an actual user/assistant message is required (not --no-session or setup-only)" :
        snapshot && snapshot.authority.sessionId !== sm.getSessionId() ? "Foreign inherited plan is read-only; detach explicitly before editing" : undefined);
      return { snapshot, writable: !error, ...(error ? { error } : {}), recoveryUncertain: [...this.recovery].filter(id => snapshot?.tasks.some(t => t.taskId === id && t.status === "in_progress")) };
    } catch (error) {
      return { writable: false, error: String(error), recoveryUncertain: [] };
    }
  }
  reconcile(sm: Manager): PlanView {
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
      this.append(PLAN_ENTRY, validated);
      if (!existsSync(sm.getSessionFile()!)) throw new Error("Session append was not durable");
    } catch (error) {
      const message = `Plan append failed; writes disabled until explicit reconcile: ${String(error)}`;
      faults.set(this.key(sm), message);
      throw new Error(message);
    }
    return validated;
  }
  create(sm: Manager, expectedRevision: number, title: string): PlanSnapshot {
    const view = this.requireWritable(sm);
    if (view.snapshot) throw new Error("Plan already exists");
    if (expectedRevision !== 0) throw new Error("Revision conflict");
    return this.save(sm, createPlan(title, { sessionId: sm.getSessionId(), branchInstanceId: randomUUID() }));
  }
  /** Synchronous compare-command-append serializes model mutations, including
   * parallel execute calls. This is not cross-process storage CAS or an OS lock. */
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
