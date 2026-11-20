import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { integrationSelection as selectIntegration, integrationTestArgs } from "./run.ts";

import { getAvailableBackends } from "./harness.ts";
import { findBashExecutable } from "../../pi-extension/subagents/hc.ts";
import { localPiCli, localPiShellCommand } from "./local-pi.ts";

// Selection unit tests model the supported integration runtime, independently
// of the Node version running the deterministic suite (which also supports 22).
const integrationSelection: typeof selectIntegration = (args, env, version = "24.0.0") => selectIntegration(args, env, version);

const hc = { HC_TERMINAL_ID: "t-test", HC_TERMINAL_SOCKET: "synthetic", PI_TEST_MODEL: "test/exact-model" };
const legacy = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "synthetic", PI_TEST_MODEL: "test/exact-model" };

it("integration runner selects HC transport with no model and no legacy tests", () => {
  const selection = integrationSelection(["--scope=transport"], { ...hc, PI_TEST_MODEL: undefined });
  assert.equal(selection.backend, "hc");
  assert.deepEqual(selection.files, ["test/hc-live.test.ts", "test/integration/hc-transport.test.ts"]);
  assert.equal(selection.env.PI_TEST_HC_LIVE, "1");
  assert.equal(selection.env.PI_TEST_HC_TUI, "0");
});
it("integration runner opts in all real HC journeys, including public plugin paths", () => {
  const selection = integrationSelection([], hc);
  assert.deepEqual(selection.files, ["test/hc-live.test.ts", "test/integration/hc-transport.test.ts", "test/integration/hc-plugin.test.ts", "test/integration/hc-tui.test.ts"]);
  assert.equal(selection.env.PI_TEST_HC_TUI, "1");
  assert.equal(selection.env.PI_TEST_HC_LIVE, "1");
  assert.equal(selection.env.PI_TEST_TIMEOUT, "180000");
  assert.equal(selection.env.PI_TEST_MODEL, hc.PI_TEST_MODEL);
  const pi = integrationSelection(["--scope=pi"], hc);
  assert.deepEqual(pi.files, selection.files.slice(2));
  assert.equal(pi.env.PI_TEST_HC_LIVE, "0");
  const plugin = integrationSelection(["--scope=plugin", "--test-name-pattern=fork"], hc);
  assert.deepEqual(plugin.files, ["test/integration/hc-plugin.test.ts"]);
  assert.equal(plugin.pattern, "fork");
});
it("integration runner preserves legacy suite and never enables HC opt-ins", () => {
  const selection = integrationSelection(["--backend=legacy"], legacy);
  assert.deepEqual(selection.files, ["test/integration/mux-surface.test.ts", "test/integration/subagent-lifecycle.test.ts", "test/integration/claude-completion.test.ts"]);
  assert.equal(selection.env.PI_TEST_HC_TUI, "0");
  assert.equal(selection.env.PI_TEST_HC_LIVE, "0");
});
it("integration preflight rejects unavailable, incomplete, and contradictory backend environments", () => {
  for (const env of [{}, { HC_TERMINAL_ID: "t1" }, { HC_TERMINAL_SOCKET: "socket" }, { HERDR_ENV: "1" }, { HERDR_WORKSPACE_ID: "workspace" }]) {
    assert.throws(() => integrationSelection(["--scope=transport"], env), /No supported terminal/);
  }
  assert.throws(() => integrationSelection(["--backend=legacy"], hc), /Legacy tests require/);
  assert.throws(() => integrationSelection(["--backend=hc"], legacy), /HC tests require/);
  assert.equal(integrationSelection([], { ...legacy, ...hc }).backend, "hc");
  assert.throws(() => integrationSelection(["--backend=legacy"], { ...legacy, ...hc }), /HC cannot prove legacy/);
});
it("integration runner requires explicit exact models, valid timeouts, and valid CLI options", () => {
  for (const model of [undefined, "", "free", "provider/has whitespace", "provider/model\nunsafe"]) {
    assert.throws(() => integrationSelection([], { ...hc, PI_TEST_MODEL: model }), /exact authenticated/);
  }
  for (const timeout of ["0", "-1", "NaN", "1.5", "999", "Infinity", "9007199254740992"]) {
    assert.throws(() => integrationSelection([], { ...hc, PI_TEST_TIMEOUT: timeout }), /PI_TEST_TIMEOUT/);
  }
  assert.equal(integrationSelection([], { ...hc, PI_TEST_TIMEOUT: "200000" }).env.PI_TEST_TIMEOUT, "200000");
  for (const args of [["--backend=unknown"], ["--scope=unit"], ["--scope=pi", "--scope=all"], ["--typo=hc"], ["--scope="], ["--test-name-pattern="]]) {
    assert.throws(() => integrationSelection(args, hc));
  }
  assert.throws(() => integrationSelection([], hc, "22.1.0"), /Node.js 24/);
});
it("integration CLI exits nonzero instead of reporting all-skipped success outside herdr", () => {
  const result = spawnSync(process.execPath, ["test/integration/run.ts", "--scope=transport"], {
    encoding: "utf8", env: { ...process.env, HC_TERMINAL_ID: "", HC_TERMINAL_SOCKET: "", HERDR_ENV: "", HERDR_WORKSPACE_ID: "" }, timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, Number(process.versions.node.split(".")[0]) < 24
    ? /Integration preflight failed: Integration tests require Node.js 24\+/
    : /Integration preflight failed: No supported terminal/);
  assert.doesNotMatch(result.stdout, /tests 0|# pass/);
});
it("integration subprocess fails with no matching cases or only skipped cases", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-integration-reporter-"));
  try {
    const file = join(dir, "sample.test.mjs");
    writeFileSync(file, `import { describe, it } from 'node:test';
      describe('fixture', () => {
        it('scenario runs', () => {});
        it('scenario skipped', { skip: true }, () => {});
        it('scenario fails', () => { throw Error('expected failure'); });
      });`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const [pattern, status, empty] of [
      ["^no match$", 1, true], ["scenario skipped", 1, true],
      ["scenario runs", 0, false], ["scenario fails", 1, false],
    ] as const) {
      const result = spawnSync(process.execPath, integrationTestArgs([file], pattern), { encoding: "utf8", env, timeout: 10_000 });
      assert.equal(result.status, status, String(result.error ?? result.stderr ?? result.stdout));
      assert.equal(result.stdout.includes("No integration test cases executed"), empty, result.stdout);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("integration shell launch uses the preflight Node and Pi even with an empty PATH", t => {
  const bash = findBashExecutable();
  if (!bash) return t.skip("Bash unavailable");
  const options = { encoding: "utf8" as const, timeout: 10_000, env: { ...process.env, PATH: "" } };
  const preflight = spawnSync(process.execPath, [localPiCli, "--version"], options);
  const launch = spawnSync(bash, ["--noprofile", "--norc", "-c", `${localPiShellCommand()} --version`], options);
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout.trim(), preflight.stdout.trim());
});

it("legacy workspace harness never claims HC availability", () => {
  const keys = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "synthetic", HC_TERMINAL_ID: "t-test", HC_TERMINAL_SOCKET: "synthetic" });
    assert.deepEqual(getAvailableBackends(), [], "No legacy CLI call or workspace creation permitted on HC");
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    assert.deepEqual(getAvailableBackends(), []);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
