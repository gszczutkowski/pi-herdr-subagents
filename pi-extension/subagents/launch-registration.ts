import { canonicalSessionPath } from "./ownership.ts";
import { createLifecycle, markProcessRunning } from "./lifecycle.ts";
import type { LaunchProfile } from "./launch-profile.ts";
import type { DurableRun, RuntimeStore } from "./runtime-store.ts";

// Derived from the one durable schema, not a second manifest definition.
type LaunchRun = Omit<DurableRun, "phase" | "eventCursor" | "profile" | "surface"> & {
  profile: LaunchProfile;
  surface: string;
};

/** Both new launches and closed-session resumes persist preparation before dispatch. */
export function prepareLaunchRun(store: RuntimeStore | undefined, input: LaunchRun): LaunchRun {
  store?.prepare({ ...input, sessionFile: canonicalSessionPath(input.sessionFile) });
  // Keep the driver's native path spelling in the live registry/command contract.
  // Canonical identity is required for durable custody, not display/CLI arguments.
  return input;
}

/** Shared registry/watcher projection. Dispatch and task authority stay with callers. */
export function registerLaunchedRun(
  registry: { set(id: string, run: RegisteredLaunch): unknown },
  store: RuntimeStore | undefined,
  run: LaunchRun,
  options: { agent?: string; hasActivitySnapshots: boolean; runtimePlan?: LaunchProfile["runtimePlan"] },
): RegisteredLaunch {
  const running: RegisteredLaunch = {
    planTask: run.planTask,
    durableStore: store,
    lineage: run.lineage,
    id: run.id,
    name: run.name,
    task: run.task,
    agent: options.agent,
    surface: run.surface,
    startTime: run.startTime,
    sessionFile: run.sessionFile,
    launchScriptFile: run.launchScriptFile,
    cli: run.cli,
    sentinelFile: run.sentinelFile,
    completionRunId: run.id,
    interactive: run.profile.interactive,
    runtimePlan: options.runtimePlan ?? run.profile.runtimePlan,
    activityFile: options.hasActivitySnapshots ? run.activityFile : undefined,
    lifecycle: options.hasActivitySnapshots
      ? createLifecycle(run.startTime)
      : markProcessRunning(createLifecycle(run.startTime), Date.now()),
  };
  registry.set(run.id, running);
  return running;
}

// This is a projection only; RuntimeStore and LaunchProfile own persisted types.
export type RegisteredLaunch = Pick<LaunchRun,
  "id" | "name" | "task" | "surface" | "startTime" | "sessionFile" |
  "launchScriptFile" | "cli" | "sentinelFile" | "planTask" | "lineage"> & {
  durableStore?: RuntimeStore;
  agent?: string;
  completionRunId: string;
  interactive: boolean;
  runtimePlan: LaunchProfile["runtimePlan"];
  activityFile?: string;
  lifecycle: ReturnType<typeof createLifecycle>;
};
