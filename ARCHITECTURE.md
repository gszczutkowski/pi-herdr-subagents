# Subagent module boundaries

## Discovery and composition

`index.ts` composes registered tools, ownership guards and lifecycle callbacks.
It is not a replacement runtime engine. Extraction is incremental:

- `discovery.ts` owns agent definition types, frontmatter parsing, name-keyed
  discovery and catalog formatting. Package → global → project precedence is
  unchanged. Global configuration and project cwd are resolved at call time;
  role-relative launch paths remain the launcher's responsibility. Existing
  `index.__test__` discovery aliases reference these same functions.
- Harness drivers and `launch-profile.ts` build commands and saved profiles.
- `delivery.ts` owns enqueue/retry/handoff, independently of widget refresh.
- `plan-view.ts`, `plan-view-registration.ts`, `history-view.ts` and frame helpers
  own native Pi presentation. No wholesale index rewrite is required.

Regression: `test/discovery.test.ts` and the existing discovery/launch tests in
`test/test.ts` exercise the extracted helpers and registered-tool compatibility.
