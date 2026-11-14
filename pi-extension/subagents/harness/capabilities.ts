import type { HarnessDriver, HarnessSessionMode } from "./types.ts";

/** Fail before any pane, session directory, or launch artifacts are created. */
export function validateHarnessLaunch(
  driver: HarnessDriver,
  sessionMode: HarnessSessionMode,
  resumeSessionId?: string,
): void {
  const supportedModes = driver.supportedSessionModes ?? ["standalone"];
  if (!supportedModes.includes(sessionMode)) {
    throw new Error(
      `${driver.name} does not support session mode "${sessionMode}" (Pi session transfer). Use a Pi-backed agent or explicitly select standalone mode.`,
    );
  }
  if (resumeSessionId !== undefined) {
    if (!driver.supportsNativeResume) {
      throw new Error(`${driver.name} does not support resumeSessionId; native session resume cannot be silently ignored.`);
    }
    if (sessionMode !== "standalone") {
      throw new Error("Native resumeSessionId cannot be combined with Pi lineage-only or fork session transfer.");
    }
  }
}
