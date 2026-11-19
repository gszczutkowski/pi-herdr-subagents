import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findHcExecutable } from "../../pi-extension/subagents/hc.ts";
import { localPiCli } from "./local-pi.ts";

const reporter = new URL("./runner-reporter.ts", import.meta.url).href;

export type IntegrationBackend = "hc" | "legacy";
export type IntegrationScope = "all" | "transport" | "pi" | "plugin";
const root = resolve(import.meta.dirname, "../..");
const files = {
  hc: {
    transport: ["test/hc-live.test.ts", "test/integration/hc-transport.test.ts"],
    plugin: ["test/integration/hc-plugin.test.ts"],
    lifecycle: ["test/integration/hc-tui.test.ts"],
  },
  legacy: {
    transport: ["test/integration/mux-surface.test.ts"],
    plugin: ["test/integration/subagent-lifecycle.test.ts"],
    lifecycle: ["test/integration/claude-completion.test.ts"],
  },
};

/** Pure selection: never probe a terminal, start Pi, or silently pass an empty suite. */
export function integrationSelection(args: string[], env: NodeJS.ProcessEnv, nodeVersion = process.versions.node) {
  if (Number(nodeVersion.split(".")[0]) < 24) throw new Error("Integration tests require Node.js 24+");
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(backend|scope|test-name-pattern)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(`Invalid or duplicate argument: ${arg}. Use --help.`);
    values.set(match[1], match[2]);
  }
  const requested = values.get("backend") ?? "auto";
  const scope = values.get("scope") ?? "all";
  if (!["auto", "hc", "legacy"].includes(requested)) throw new Error(`Unknown backend: ${requested}`);
  if (!["all", "transport", "pi", "plugin"].includes(scope)) throw new Error(`Unknown scope: ${scope}`);
  const hc = Boolean(env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET);
  const legacy = env.HERDR_ENV === "1" && Boolean(env.HERDR_WORKSPACE_ID);
  const backend = requested === "auto" ? hc ? "hc" : legacy ? "legacy" : undefined : requested;
  if (!backend) throw new Error("No supported terminal environment. Start inside HC (HC_TERMINAL_ID + HC_TERMINAL_SOCKET) or legacy herdr (HERDR_ENV=1 + HERDR_WORKSPACE_ID).");
  if (backend === "hc" && !hc) throw new Error("HC tests require HC_TERMINAL_ID and HC_TERMINAL_SOCKET; no legacy fallback.");
  if (backend === "legacy" && (!legacy || hc)) throw new Error("Legacy tests require HERDR_ENV=1 + HERDR_WORKSPACE_ID and no active HC environment; HC cannot prove legacy compatibility.");
  const model = env.PI_TEST_MODEL?.trim();
  if (scope !== "transport" && (!model || !/^[^\s/]+\/[^\s]+$/.test(model))) {
    throw new Error("Set PI_TEST_MODEL to an exact authenticated provider/model-id. Pi integration tests make real, potentially billable requests; transport scope needs no model.");
  }
  const timeout = env.PI_TEST_TIMEOUT ?? "180000";
  if (!/^\d+$/.test(timeout) || !Number.isSafeInteger(Number(timeout)) || Number(timeout) < 1000) throw new Error("PI_TEST_TIMEOUT must be an integer of at least 1000 milliseconds.");
  const selected = files[backend as IntegrationBackend];
  const selectedFiles = [
    ...(scope === "all" || scope === "transport" ? selected.transport : []),
    ...(scope !== "transport" ? selected.plugin : []),
    ...(scope === "all" || scope === "pi" ? selected.lifecycle : []),
  ];
  return {
    backend: backend as IntegrationBackend, scope: scope as IntegrationScope, files: selectedFiles,
    pattern: values.get("test-name-pattern"),
    env: { ...env, PI_TEST_MODEL: model, PI_TEST_TIMEOUT: timeout,
      PI_TEST_HC_LIVE: backend === "hc" && ["all", "transport"].includes(scope) ? "1" : "0",
      PI_TEST_HC_TUI: backend === "hc" && scope !== "transport" ? "1" : "0" },
  };
}

export function runIntegration(args = process.argv.slice(2)): number {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: npm run test:integration -- [--backend=auto|hc|legacy] [--scope=all|transport|pi|plugin] [--test-name-pattern=REGEXP]\nTransport starts no model. Other scopes require explicit PI_TEST_MODEL and make real requests. Plugin selects public feature journeys; pi adds lifecycle/recovery journeys. No missing-backend success or HC/legacy substitution.");
    return 0;
  }
  const selected = integrationSelection(args, process.env);
  if (!existsSync(localPiCli)) throw new Error("Local Pi CLI missing. Install dependencies with npm ci.");
  const pi = execFileSync(process.execPath, [localPiCli, "--version"], { encoding: "utf8", timeout: 15_000 }).trim();
  if (selected.backend === "hc") {
    const hc = findHcExecutable();
    if (!hc) throw new Error("HC executable unavailable; no tests launched.");
    execFileSync(hc, ["server", "status"], { stdio: "pipe", timeout: 15_000, windowsHide: true });
  } else {
    execFileSync("herdr", ["workspace", "list"], { stdio: "pipe", timeout: 15_000, windowsHide: true });
  }
  console.log(JSON.stringify({ backend: selected.backend, scope: selected.scope, pi, node: process.version,
    model: selected.scope === "transport" ? "none (no model requests)" : selected.env.PI_TEST_MODEL,
    files: selected.files, filter: selected.pattern ?? null, evidence: ".git/verification/ (HC TUI journeys)",
    note: "Only the selected backend is verified. Filtered/skipped journeys are not evidence." }, null, 2));
  const result = spawnSync(process.execPath, integrationTestArgs(selected.files, selected.pattern),
    { cwd: root, env: selected.env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function integrationTestArgs(testFiles: string[], pattern?: string): string[] {
  return ["--test", "--test-concurrency=1", `--test-reporter=${reporter}`,
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...testFiles];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runIntegration(); }
  catch (error) { console.error(`Integration preflight failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
