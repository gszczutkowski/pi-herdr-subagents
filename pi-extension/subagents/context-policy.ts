/** Shared budgets for proactive compaction, checkpoints and child report delivery. */
export interface ContextProtectionConfig {
  enabled: boolean;
  reserveTokens: number;
  reservePercent: number;
  keepRecentTokens: number;
  maxReportBytes: number;
  /** Advisory UTF-8 JSON payload thresholds, keyed by provider or provider/model. No universal backend limit is assumed. */
  providerPayloadWarningBytes: Readonly<Record<string, number>>;
}

export const DEFAULT_CONTEXT_PROTECTION: Readonly<ContextProtectionConfig> = Object.freeze({
  enabled: true, reserveTokens: 50000, reservePercent: 20,
  keepRecentTokens: 20000, maxReportBytes: 12000,
  providerPayloadWarningBytes: Object.freeze({}),
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
  const budgets = result.providerPayloadWarningBytes;
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) fail("providerPayloadWarningBytes must be an object");
  if (Object.keys(budgets).length > 100) fail("providerPayloadWarningBytes supports at most 100 entries");
  for (const [key, bytes] of Object.entries(budgets)) {
    if (!key.trim() || key.length > 300 || [...key].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || ["__proto__", "constructor", "prototype"].includes(key)) {
      fail("providerPayloadWarningBytes keys must be bounded provider or provider/model names");
    }
    if (!Number.isSafeInteger(bytes) || bytes < 1024) fail("providerPayloadWarningBytes values must be safe integers of at least 1024 bytes");
  }
  result.providerPayloadWarningBytes = Object.freeze({ ...budgets });
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
