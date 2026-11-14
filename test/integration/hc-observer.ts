// Test-only observation. Never invokes orchestration tools or fabricates results.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  pi.on("tool_execution_start", (event, ctx) => record("tool_start", event, ctx));
  pi.on("tool_execution_end", (event, ctx) => record("tool_end", event, ctx));
  pi.on("agent_settled", (event, ctx) => record("settled", { aborted: event.aborted }, ctx));
}
