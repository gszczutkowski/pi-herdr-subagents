import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createSubagentPane, createSubagentSurface, closePane, inspectPane, runInPane, runScriptInPane, shellQuote } from "../../pi-extension/subagents/terminal.ts";
import { setTimeout as delay } from "node:timers/promises";
import { probeProcess, sameProcess } from "../../pi-extension/subagents/process-identity.ts";
import { trackTransportSurface, until } from "./hc-tui-harness.ts";

// Real transport only: never starts a Pi conversation or an AI provider.
it("live HC transport isolates concurrent scripts with Unicode, quotes, and long payloads", {
  skip: process.env.PI_TEST_HC_LIVE !== "1", timeout: 60_000,
}, async () => {
  const id = randomUUID();
  const git = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const evidence = join(git, "verification", `${id}-hc-transport`);
  mkdirSync(evidence, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "hc transport ' żółw-"));
  const owned: string[] = [];
  let failure: unknown;
  try {
    const payload = `Unicode: zażółć gęślą jaźń 日本語 🐢; quote ' "; dollar $HOME; slash \\; newline\n${"long-$'\\\"-".repeat(8000)}`;
    const launches = ["alpha", "beta"].map(name => {
      const surface = createSubagentPane(`Transport ${name} ${id}`);
      trackTransportSurface(owned, surface);
      const marker = join(scratch, `${name}.json`);
      const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker + ".tmp")},JSON.stringify({name:${JSON.stringify(name)},payload:${JSON.stringify(payload)},cwd:process.cwd()}));fs.renameSync(${JSON.stringify(marker + ".tmp")},${JSON.stringify(marker)});`;
      // Feed source on stdin: Windows' argv limit is not a launch-script limit.
      const command = `cd ${shellQuote(scratch)} && node <<'PI_HC_PAYLOAD'\n${code}\nPI_HC_PAYLOAD`;
      const script = runScriptInPane(surface, command, { scriptPath: join(evidence, `launch ${name} ' unicode-ż.sh`) });
      assert.ok(readFileSync(script, "utf8").includes(command), "Full payload must reach actual launch artifact");
      return { name, surface, marker };
    });
    const results = await Promise.all(launches.map(async launch => {
      await until(scratch, () => existsSync(launch.marker) ? true : undefined, `${launch.name} actual script side effect`, 25_000);
      const actual = JSON.parse(readFileSync(launch.marker, "utf8"));
      assert.equal(actual.name, launch.name);
      assert.equal(actual.payload, payload, "No shell interpolation, truncation, or cross-terminal delivery");
      assert.equal(actual.cwd.toLowerCase().replaceAll("\\", "/"), scratch.toLowerCase().replaceAll("\\", "/"));
      assert.equal((await inspectPane(launch.surface)).kind, "present");
      return { surface: launch.surface, ...actual };
    }));
    writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2));
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanup = [];
    for (const surface of owned.reverse()) {
      try { closePane(surface); cleanup.push({ surface, inspection: await inspectPane(surface) }); }
      catch (error) { cleanup.push({ surface, error: String(error) }); }
    }
    const allMissing = cleanup.length === owned.length && cleanup.every(result => result.inspection?.kind === "missing");
    writeFileSync(join(evidence, "cleanup.json"), JSON.stringify({ allMissing, terminals: cleanup }, null, 2));
    writeFileSync(join(evidence, "assertions.json"), JSON.stringify({ passed: !failure && allMissing, error: failure ? String(failure) : undefined, noModelRequests: true }, null, 2));
    if (!failure && allMissing) rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    console.log(`HC transport evidence: ${evidence}`);
    assert.ok(allMissing, "Every owned transport terminal must be verified missing");
  }
});

it("closing an idle HC terminal releases its Bash process and working directory", {
  skip: process.env.PI_TEST_HC_LIVE !== "1" || !["linux", "win32"].includes(process.platform), timeout: 60_000,
}, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hc-idle-shell-"));
  const surface = createSubagentPane(`Idle shell ${randomUUID()}`);
  trackTransportSurface([], surface); // Guard the parent terminal before sending or closing anything.
  const marker = join(scratch, "shell.pid");
  let nativePid: number;
  let original: ReturnType<typeof probeProcess>;
  try {
    // Run in the persistent interactive shell, not a child script. $$ is an MSYS PID on Git Bash.
    const pid = process.platform === "win32" ? '$(/usr/bin/cat /proc/$$/winpid)' : '$$';
    runInPane(surface, `cd ${shellQuote(scratch)} && printf '%s\\n' "${pid}" > shell.pid`);
    nativePid = await until(scratch, () => {
      const value = existsSync(marker) && readFileSync(marker, "utf8").trim();
      return value && /^\d+$/.test(value) ? Number(value) : undefined;
    }, "interactive Bash reached its test cwd", 15_000);
    original = probeProcess(nativePid);
    assert.equal(original.kind, "present", "Must identify the live shell before closing its terminal");
  } finally {
    closePane(surface);
  }
  assert.equal((await inspectPane(surface)).kind, "missing");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const now = probeProcess(nativePid);
    if (now.kind === "absent" || (now.kind === "present" && !sameProcess(original.identity, now.identity))) break;
    assert.ok(Date.now() < deadline, `Original Bash ${nativePid} not verified gone (${now.kind}); scratch: ${scratch}`);
    await delay(100);
  }
  // On Windows, a lingering cwd can prevent rename even after the HC address disappears.
  renameSync(scratch, `${scratch}-released`);
  rmSync(`${scratch}-released`, { recursive: true });
});

it("live HC layout requests use isolated terminals, never a legacy layout command", {
  skip: process.env.PI_TEST_HC_LIVE !== "1", timeout: 30_000,
}, async () => {
  const owned: string[] = [];
  try {
    for (const layout of ["tab", "right", "down"] as const) {
      const surface = createSubagentSurface(`Transport layout ${layout}`, layout);
      trackTransportSurface(owned, surface);
      assert.equal((await inspectPane(surface)).kind, "present");
    }
  } finally {
    const failures: unknown[] = [];
    for (const surface of owned.reverse()) {
      try { closePane(surface); assert.equal((await inspectPane(surface)).kind, "missing"); }
      catch (error) { failures.push(error); }
    }
    assert.deepEqual(failures, [], "Cleanup attempts every exact owned terminal independently");
  }
});
