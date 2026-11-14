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

## Launch registration and durable custody

`launch-registration.ts` is the shared prepare/register/watcher-field projection
for spawn and closed-session resume. Its input derives from `DurableRun` in
`runtime-store.ts`; `LaunchProfile` remains the saved restrictions/runtime input.
There is no second manifest. Prepared records and registered runs share identity,
locators, binding and lineage. Runtime-only routing provenance is retained on
spawn; saved routing is used for closed resume. `entryCountBefore` remains the
closed-resume baseline, not a new task or a new persistence mechanism.

Callers retain reservation/recovery/branch guards, task binding before dispatch,
contract construction, transport and dispatch-intent/supervised ordering, history
and watcher ownership. Live interrupted continuation bypasses preparation and
registration: `continueLiveChild` retains the existing run, pane and watcher and
revalidates authority in `beforeSend`. The helper is not a new execution engine.
`test/runtime-execute.test.ts` checks both production projections against the disk
manifest and saved profiles; ownership/continuation tests cover same-run resume.
