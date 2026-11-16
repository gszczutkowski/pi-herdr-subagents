import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { childSurface, HcTuiRun, jsonLines, until } from "./hc-tui-harness.ts";
import { sourceAuth } from "./hc-auth.ts";
import { shellComment } from "../../pi-extension/subagents/shell.ts";

it("HC TUI harness extracts exactly one sanitized owned surface", () => {
  assert.equal(childSurface("# Surface: t9\n"), "t9");
  assert.equal(childSurface(shellComment(shellComment("Surface: ta42")) + "\r\n"), "ta42");
  for (const script of ["Surface: t9", "# Surface: remote/t9", "# Surface: t9; echo unsafe", "# Surface: t9\n# # Surface: t8\n"]) {
    assert.throws(() => childSurface(script), /Exactly one commented child Surface required/);
  }
});

it("HC auth bridge resolves only the selected original-store provider without persisting credentials", async () => {
  const signal = new AbortController().signal;
  const calls: unknown[] = [];
  const result = { auth: { apiKey: "synthetic-test-only" }, source: "synthetic" };
  const auth = sourceAuth({
    hasConfiguredAuth(provider) { calls.push(["check", provider]); return provider === "selected"; },
    async getAuth(provider: any, options?: any) { calls.push(["resolve", provider, options?.signal]); return result; },
  }, "selected").apiKey;
  assert.deepEqual(await auth.check(), { type: "api_key", source: "original profile" });
  assert.equal(await auth.resolve({ signal }), result);
  await assert.rejects(auth.login(), /never logs in or stores credentials/);
  assert.deepEqual(calls, [["check", "selected"], ["resolve", "selected", signal]]);
  assert.equal(await sourceAuth({ hasConfiguredAuth: () => false, getAuth: async () => undefined }, "unavailable").apiKey.check(), undefined);
});

it("HC cleanup continues past a missing artifact and reports unresolved custody", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-cleanup-custody-"));
  const records: Record<string, any> = {}, closed: string[] = [];
  try {
    const script = join(dir, "valid.sh"); writeFileSync(script, "# # Surface: t2\n");
    const fake = Object.assign(Object.create(HcTuiRun.prototype), {
      evidence: dir, scratch: dir, parentSession: join(dir, "parent.jsonl"), owned: new Set(["t1"]),
      save: (name: string, data: unknown) => { records[name] = data; },
      capture: async () => {}, results: () => [], observed: () => [], artifactDirectory: () => dir,
      manifest: () => ({ runs: {
        damaged: { id: "damaged", surface: "t3", launchScriptFile: join(dir, "missing.sh") },
        valid: { id: "valid", surface: "t2", launchScriptFile: script },
      } }),
      hc: { close: (id: string) => closed.push(id), inspect: async () => ({ kind: "missing" }) },
    });
    await assert.rejects(fake.finish(new Error("synthetic journey failure")), /unresolved ownership/);
    assert.deepEqual(closed, ["t2", "t1"], "Later verified child still cleaned; unverified terminal never touched");
    assert.equal(records["cleanup.json"].allMissing, false);
    assert.equal(records["cleanup.json"].unresolved.length, 1);
    assert.equal(records["cleanup.json"].unresolved[0].surface, "t3");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
