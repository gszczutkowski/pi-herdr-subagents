/** Shared budgets for proactive compaction, checkpoints and child report delivery. */
export interface ContextProtectionConfig {
  enabled: boolean;
  reserveTokens: number;
  reservePercent: number;
  keepRecentTokens: number;
  maxReportBytes: number;
}

export const DEFAULT_CONTEXT_PROTECTION: Readonly<ContextProtectionConfig> = Object.freeze({
  enabled: true, reserveTokens: 50000, reservePercent: 20,
  keepRecentTokens: 20000, maxReportBytes: 12000,
});

export function parseContextProtection(raw: unknown, source = "config.json"): ContextProtectionConfig {
  if (raw === undefined) return { ...DEFAULT_CONTEXT_PROTECTION };
  const fail = (message: string): never => { throw new Error(`Invalid subagent config in ${source}: contextProtection ${message}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("must be an object");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULT_CONTEXT_PROTECTION, key)) fail(`has unsupported key: ${key}`);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail("enabled must be a boolean");
  const result = { ...DEFAULT_CONTEXT_PROTECTION, ...value } as ContextProtectionConfig;
  for (const key of ["reserveTokens", "reservePercent", "keepRecentTokens", "maxReportBytes"] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) fail(`${key} must be a non-negative safe integer`);
  }
  if (result.reservePercent < 5 || result.reservePercent > 40) fail("reservePercent must be between 5 and 40");
  if (result.maxReportBytes < 1024 || result.maxReportBytes > 50000) fail("maxReportBytes must be between 1024 and 50000");
  return result;
}

/** Cap the absolute reserve for small models; a 50k reserve must not consume a 33k window. */
export function contextBudgets(window: number, config: ContextProtectionConfig) {
  if (!Number.isSafeInteger(window) || window <= 0) return undefined;
  const reserve = Math.min(Math.floor(window * 0.4), Math.max(config.reserveTokens, Math.ceil(window * config.reservePercent / 100)));
  const threshold = window - reserve;
  return { reserveTokens: reserve, thresholdTokens: threshold,
    keepRecentTokens: Math.min(config.keepRecentTokens, Math.floor(threshold / 2)) };
}
