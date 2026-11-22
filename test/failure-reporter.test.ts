import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const reporter = new URL("./failure-reporter.ts", import.meta.url).href;

it("quiet reporter hides passing/skipped tests and stdout, retaining failures and totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiet-reporter-"));
  try {
    const file = join(dir, "sample.test.mjs");
    writeFileSync(file, `import { describe, it } from 'node:test';
      import assert from 'node:assert/strict';
      describe('fixture suite', () => {
        it('passing case', () => { console.log('passing stdout'); console.error('passing stderr'); });
        it('skipped case', { skip: true }, () => {});
        it('todo case', { todo: true }, () => {});
        it('failing case', () => { assert.equal('actual value', 'expected value'); });
      });`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const failing of [false, true]) {
      const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`,
        ...(failing ? [] : ["--test-name-pattern=passing|skipped|todo"]), file],
      { encoding: "utf8", env, timeout: 10_000 });
      assert.equal(result.status, failing ? 1 : 0, String(result.error ?? result.stderr));
      assert.doesNotMatch(result.stdout, /passing case|skipped case|todo case|passing stdout|passing stderr/);
      assert.equal(result.stderr, "");
      const summary = `passed: 1, skipped: 2, failed: ${failing ? 1 : 0}\n`;
      assert.ok(result.stdout.endsWith(summary), result.stdout);
      assert.equal(result.stdout.split("passed:").length, 2, result.stdout);
      if (failing) {
        assert.match(result.stdout, /FAIL failing case/);
        assert.match(result.stdout, /sample\.test\.mjs:\d+:\d+/);
        assert.match(result.stdout, /actual value/);
        assert.match(result.stdout, /expected value/);
        assert.match(result.stdout, /ERR_ASSERTION/);
      } else {
        assert.equal(result.stdout, summary);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
