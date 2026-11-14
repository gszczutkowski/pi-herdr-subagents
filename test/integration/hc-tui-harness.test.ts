import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { jsonLines, until } from "./hc-tui-harness.ts";

it("HC TUI harness observes atomic filesystem progress without a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-tui-observation-"));
  try {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, "");
    const observed = until(dir, () => jsonLines(file).find(e => e.token === "ready"), "filesystem event", 1000);
    writeFileSync(file, '{"token":"ready"}\n{"partial":');
    assert.deepEqual(await observed, { token: "ready" });
    await assert.rejects(until(dir, () => undefined, "bounded deadline", 20), /Timed out: bounded deadline/);
    assert.equal(jsonLines(join(dir, "missing")).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
