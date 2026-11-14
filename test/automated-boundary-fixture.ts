import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PlanPersistence } from "../pi-extension/subagents/plan-persistence.ts";
import type { CommandContext, PlanSnapshot } from "../pi-extension/subagents/plan-store.ts";

/** Real on-disk native session; no agent session, transport or model is started. */
export function nativeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "automated-boundary-"));
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "Boundary regression", timestamp: Date.now() });
  const p = new PlanPersistence((type, data) => sm.appendCustomEntry(type, data), false);
  p.create(sm, 0, "Boundary plan");
  const read = () => p.read(sm).snapshot!;
  const mutate = (fn: (plan: PlanSnapshot, context: CommandContext) => PlanSnapshot) => {
    const plan = read();
    return p.mutate(sm, plan.planId, plan.revision, fn);
  };
  return { dir, sm, p, read, mutate, ctx: { sessionManager: sm } as any,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
