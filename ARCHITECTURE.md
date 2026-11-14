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

## Native Pi persistence and presentation, separate delivery

The active native `SessionManager.getBranch()` selects plan snapshots appended as
custom `pi-subagents-plan/v1` session entries. Custom entries are state, not model
messages. Widget factories (`ctx.ui.setWidget`) and `/plan-view` are disposable
projections of `PlanPersistence`; neither the widget cache nor the JSONL physical
tail is authoritative. `plan-context.ts` separately projects the same selected
snapshot at the request-time `context` hook, including after compaction. It does
not append entries or send messages to refresh context.

`delivery.ts` and `RuntimeStore` retain immutable result envelopes, event cursors,
retry/uncertain handoff state and tombstones outside presentation. Transport can
fail while task acceptance remains durable, and widget/context refresh must not
retry transport, enqueue events, append snapshots, notify or wake the model.
A normal return from Pi's void `sendMessage` means synchronous handoff only, not
exactly-once delivery or an acknowledgement of durable model consumption.

`test/architecture-presentation.test.ts` composes registered native UI/context,
real SessionManager storage, parent commands, runtime import and durable outbox.
It injects a handoff failure, proves accepted state survives, byte-checks both
stores across refresh/render/reload/tree, discards the widget, reopens storage and
selects an earlier native branch. Transport retry changes only outbox state.
The Pi host UI/transport boundary is mocked; no live terminal/model is claimed.
Installed Pi references: `docs/extensions.md`, `docs/session-format.md` and
`examples/extensions/widget-placement.ts` (read before this boundary work).

## Verification limits

Section 7 boundary work: discovery + existing tests 185/185; launch/ownership/
profile/continuation/keep-open 31/31; authority/persistence/branches/runtime 14/14;
presentation/view/context/delivery/execute/capabilities 36/36. Lint passes with no
warnings. Final sequential execution of every file explicitly enumerated by
`npm test`: 420/439 pass, zero skip; 18 existing missing-Python/Claude-hook failures
and one existing CRLF release-workflow regex failure. No live herdr, external
provider, OS isolation or cross-process storage-CAS verification was performed.
