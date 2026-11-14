// Test-only observation. Never invokes orchestration tools or fabricates results.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { __test__ } from "../../pi-extension/subagents/index.ts";
import { canonicalSessionPath, sessionOwners } from "../../pi-extension/subagents/ownership.ts";

export default function (pi: ExtensionAPI) {
  const path = process.env.PI_TEST_HC_EVENTS;
  if (!path) return;
  const record = (kind: string, data: unknown, ctx: any) => appendFileSync(path, JSON.stringify({
    at: Date.now(), kind, pid: process.pid, terminal: process.env.HC_TERMINAL_ID,
    session: ctx.sessionManager?.getSessionFile(), mode: ctx.mode, data,
  }) + "\n");
  // Only the unique disposable project is trusted, without persisting global trust.
  pi.on("project_trust", (event) => event.cwd === process.env.PI_TEST_HC_SCRATCH
    ? { trusted: "yes", remember: false } : { trusted: "undecided" });
  pi.on("session_start", (event, ctx) => record("session_start", {
    reason: event.reason, tools: pi.getAllTools().map(t => ({ name: t.name, source: t.sourceInfo })),
  }, ctx));
  pi.on("session_shutdown", async (event, ctx) => {
    record("session_shutdown", event, ctx);
    // Hold the real reload gap open so completion can be correlated to that window.
    if (event.reason === "reload") await new Promise(resolve => setTimeout(resolve, 20_000));
  });
  const closeObservations = new Map<string, { stop: () => void }>();
  pi.on("tool_execution_start", (event, ctx) => {
    record("tool_start", event, ctx);
    if (event.toolName !== "subagent_close") return;
    const child = __test__.runningSubagents.get((event.args as any)?.id);
    if (!child) return;
    let previous = "";
    const runs = __test__.runningSubagents, originalGet = runs.get;
    const inspect = (source: "start" | "tick" | "end" | "closure-validation-read") => {
      const state = { id: child.id, running: originalGet.call(runs, child.id) === child,
        owner: sessionOwners.get(canonicalSessionPath(child.sessionFile))?.runId };
      const next = JSON.stringify(state);
      if (next !== previous || source === "closure-validation-read") { previous = next; record("close_custody", { ...state, source }, ctx); }
    };
    // Observe the actual production closure-validation read, not only a
    // tool_end snapshot that could follow later cleanup. Forward the exact
    // Map.get result unchanged; never fabricate state, OS probes, or replies.
    const observedGet: typeof runs.get = function (id) {
      const value = originalGet.call(this, id);
      if (id === child.id && !value && new Error().stack?.includes("validateClosed")) inspect("closure-validation-read");
      return value;
    };
    runs.get = observedGet;
    inspect("start");
    const timer = setInterval(() => inspect("tick"), 10); timer.unref();
    closeObservations.set(event.toolCallId, { stop: () => {
      clearInterval(timer); inspect("end");
      if (runs.get === observedGet) runs.get = originalGet;
    } });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    closeObservations.get(event.toolCallId)?.stop(); closeObservations.delete(event.toolCallId);
    record("tool_end", event, ctx);
  });
  pi.on("session_shutdown", () => {
    for (const observation of closeObservations.values()) observation.stop();
    closeObservations.clear();
  });
  pi.on("agent_settled", (event, ctx) => record("settled", { aborted: event.aborted }, ctx));
}
