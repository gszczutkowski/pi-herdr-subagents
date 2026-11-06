import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createSubagentPane, runScriptInPane, readPane, readPaneAsync, inspectPane, interruptPane, closePane, shellQuote } from "../pi-extension/subagents/terminal.ts";

// Explicit opt-in: creates a real terminal, but never starts an AI model.
it("runs a synthetic launch script through the live hc adapter", { skip: process.env.PI_TEST_HC_LIVE !== "1", timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-adapter-smoke-"));
  const marker = join(dir, "result.json");
  const piPath = join(dir, "pi.txt");
  let surface: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    surface = createSubagentPane("Adapter smoke");
    const ready = new Promise<void>((resolve, reject) => {
      watcher = watch(dir, (_event, filename) => {
        if (filename === "result.json" && existsSync(marker)) resolve();
      });
      watcher.on("error", reject);
      timer = setTimeout(() => reject(new Error("synthetic hc launch script did not finish")), 10_000);
    });
    // Avoid an unhandled rejection if sending fails before the await below.
    void ready.catch(() => {});
    const code = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, JSON.stringify({version:process.version,cwd:process.cwd()})); fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)})`;
    runScriptInPane(surface, `command -v pi > ${shellQuote(piPath)} && pi --version >> ${shellQuote(piPath)} && node -e ${shellQuote(code)}`, { scriptPath: join(dir, "launch smoke.sh") });
    await ready;
    const result = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(result.version, process.version);
    const piOutput = readFileSync(piPath, "utf8").trim().split(/\r?\n/);
    assert.ok(piOutput[0].endsWith("/pi"));
    assert.ok(piOutput.length >= 2, "Pi launcher must actually execute, not just resolve");
    assert.equal((await inspectPane(surface)).kind, "present");
    assert.equal(typeof readPane(surface, 10), "string");
    assert.equal(typeof await readPaneAsync(surface, 10), "string");
    interruptPane(surface);
    closePane(surface);
    assert.equal((await inspectPane(surface)).kind, "missing");
    surface = undefined;
  } finally {
    if (timer) clearTimeout(timer);
    watcher?.close();
    try { if (surface) closePane(surface); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
