import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function assertReleaseWorkflow(source: string): void {
  // Git may check YAML out as CRLF on Windows; validate content, not checkout EOLs.
  const workflow = source.replace(/\r\n/g, "\n");

  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /paths:\n\s+- package\.json/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /git tag -a "\$TAG"/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /gh release create "\$TAG"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /npmjs\.com\/package\/pi-herdr-subagents\/v\/\$\{VERSION\}/);
}

for (const [name, newline] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
  test(`release workflow creates all release artifacts with ${name} line endings`, async () => {
    const source = await readFile(".github/workflows/publish.yml", "utf8");
    assertReleaseWorkflow(source.replace(/\r?\n/g, newline));
    assert.throws(() => assertReleaseWorkflow(source.replace(/- main\b/, "- wrong-branch")), assert.AssertionError);
  });
}
