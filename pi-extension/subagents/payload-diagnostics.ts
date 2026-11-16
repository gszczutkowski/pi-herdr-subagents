import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextProtectionConfig } from "./context-policy.ts";

const STATUS = "subagent-payload-bytes";

/** JSON bytes at this extension's hook position, not final/compressed wire bytes.
 * Later hooks and transport full/delta selection can still change the request. */
export function providerPayloadBytes(payload: unknown): number | undefined {
  try {
    const json = JSON.stringify(payload);
    return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
  } catch { return undefined; }
}

export function payloadWarningBudget(config: ContextProtectionConfig, model?: { provider: string; id: string }): number | undefined {
  if (!model) return undefined;
  const budgets = config.providerPayloadWarningBytes;
  for (const key of [`${model.provider}/${model.id}`, model.provider]) {
    if (Object.hasOwn(budgets, key)) return budgets[key];
  }
  return undefined;
}

/** Advisory only: extension-hook exceptions are swallowed by Pi, and abort is
 * not a guaranteed pre-send gate on cached WebSockets. Never alter the payload,
 * truncate protocol history, log bodies, or classify every HTTP 400 as overflow. */
export function registerPayloadDiagnostics(pi: ExtensionAPI, config: ContextProtectionConfig): void {
  if (process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SESSION) return;
  let observed = 0;
  let unavailable = 0;
  let maximum = 0;
  let lastBytes: number | undefined;
  let lastBudget: number | undefined;
  let lastStatus: number | undefined;
  let warningActive = false;
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    observed = 0; unavailable = 0; maximum = 0;
    lastBytes = undefined; lastBudget = undefined; lastStatus = undefined; warningActive = false;
    if (ctx.hasUI) ctx.ui.setStatus?.(STATUS, undefined);
  };
  for (const event of ["session_start", "session_tree", "model_select", "session_shutdown"] as const) pi.on(event, reset);

  pi.on("before_provider_request", (event, ctx) => {
    lastBytes = providerPayloadBytes(event.payload);
    lastBudget = payloadWarningBudget(config, ctx.model);
    lastStatus = undefined;
    if (lastBytes === undefined) { unavailable++; return; }
    observed++;
    maximum = Math.max(maximum, lastBytes);
    const over = config.enabled && lastBudget !== undefined && lastBytes >= lastBudget;
    if (ctx.hasUI) {
      ctx.ui.setStatus?.(STATUS, over ? `Payload JSON: ${lastBytes} bytes (advisory threshold ${lastBudget})` : undefined);
      if (over && !warningActive) ctx.ui.notify(
        `Provider payload JSON is ${lastBytes} UTF-8 bytes at this hook (warning threshold ${lastBudget}). Final wire/full-delta size is unknown; nothing was blocked. Use native /compact before further work if appropriate.`, "warning");
    }
    warningActive = over;
    // Explicitly leave the provider payload unchanged.
  });
  pi.on("after_provider_response", event => { lastStatus = event.status; });
  pi.registerCommand("context-bytes", {
    description: "Show numeric provider-payload byte observations (advisory, not a final-wire limit; no body logging)",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(
        `Payload diagnostics: observed=${observed}; unavailable=${unavailable}; last=${lastBytes ?? "unknown"}; max=${observed ? maximum : "unknown"} UTF-8 JSON bytes; threshold=${lastBudget ?? "not configured"}; HTTP=${lastStatus ?? "unknown"}. Scope=provider-payload at this hook; transport/full-delta/final wire bytes=unknown. Selected-model budgets may differ from routed requests. Providers that omit onPayload (including installed Kiro 0.12.3) are not observed. No hard send limit.`, "info");
    },
  });
}
