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

## One parent task command boundary

Audit: `plan-tools.ts` routes model commands to `PlanPersistence.create`, `detach`
and `mutate`; `plan-runtime.ts` routes attach/result/dispatch-failure imports to
that same instance's `mutate`. `plan-store.ts` is a pure command model, not another
store. Only persistence's private `save` appends native `pi-subagents-plan/v1`
snapshots. Runtime envelopes carry proposals/references, not replacement snapshots.
There was no missing production mutation route to replace.

`mutate` synchronously checks writability, plan identity, original branch authority
and expected revision, applies a bounded command, validates and appends before
returning. A replayed event is a no-op. A child-configured persistence cannot write
even if given the ancestor's session manager. A worker result leads to review,
never acceptance; parent evidence/accept commands remain separate. This is local
serialization and logical authority, not cross-process CAS or an OS sandbox.

`test/architecture-authority.test.ts` spies on the actual persistence returned by
registered tools while importing runtime events, then verifies byte-identical
storage after stale revision, child tool/import, historical branch and original
binding rejection. Native detach/reopen verifies the selected branch, not the
physical JSONL tail. Existing lifecycle tests use model-issued tools through Pi's
real session bindings with a controlled provider (no live herdr/provider claim).
