# Live HC continuation corrections — 2026-11-14

## Result

Both relevant **actual authenticated HC Pi TUI journeys passed on MAIN** after the corrections:

- `keepOpen followup`: first and second bash markers and correlated completion events; same child run, session, terminal and startup identity.
- `interrupt live continuation`: successful Escape dispatch, actual aborted settlement, surviving process, no abort-only result or finished gate marker; same-run resumed bash marker and successful completion.

Command:

```bash
PI_TEST_HC_TUI=1 node --test --test-concurrency=1 --test-name-pattern='keepOpen followup|interrupt live continuation' test/integration/hc-tui.test.ts
```

Final result: **2 passed, 0 failed, 0 skipped**. Model: `openai-codex/gpt-6.1-sol`. The imported isolated harness uses scratch projects, explicit extensions and owned background HC terminal IDs, without focusing a user terminal, changing global settings or copying authentication. Both final `cleanup.json` records confirm all owned terminals missing.

Private durable evidence: `.git/verification/2026-11-14-live-continuation-fix/summary.json`. It references the complete final journey directories and includes source hashes, assertions, cleanup and verification limits. Each final `environment.json` records the MAIN source root and hashes of `index.ts`, `subagent-done.ts` and `live-continuation.ts`; these were checked against the working tree after both runs. Logs are preserved beside the summary. Evidence contains private paths, prompts and model output; do not publish it.

## Corrections

1. HC `done` is accepted only alongside an existing owned Pi process and fresh child-issued settled-idle token. Coarse status alone never authorizes continuation.
2. Advertised `artifact-v1` transport uses an atomic run-bound request and a child `fs.watch` handler started at `session_start`, stopped at shutdown/reload. Binding/custody validation precedes publication. The child shares validation with the manual compatibility command, claims durably and calls `sendUserMessage` with expansion disabled. No production terminal send or legacy blind-typing fallback remains.

The durable claim and final acknowledgement are separate files: an exploratory live run exposed Windows failure replacing a claim while the parent read it. Final immutable acknowledgement publication avoids that overwrite. Another exploratory interrupt run had an HC Escape timeout; the driver now explicitly requires `interrupt_requested` rather than accepting any non-throwing result. These failed attempts remain recorded, not counted as passes.

## Other checks

- Focused production regressions: **70 passed, 0 failed, 0 skipped** across live continuation, ownership execute, plan runtime, runtime recovery, HC, terminal queries, keep-open and delivery.
- `npm run lint`: exit 0. `git diff --check`: exit 0.
- Default HC opt-out: exit 0, no model journey requested.
- Real filesystem tests cover hostile multiline slash/`!`/`@` text, duplicate requests, busy/pending rejection, wrong run/session/token, custody-before-publication, unsupported capability, watcher shutdown/restart, durable ambiguous API dispatch and no retry/relaunch. Registered parent-tool tests retain binding validation and failed-import durability.

## Limits

The complete `npm test` run did not finish: two attempts stalled in `harness-drivers.test.ts`; only this task's timed-out test process trees were stopped. A bounded broad run excluding that file completed with unrelated environment-sensitive failures: Python is unavailable for 18 Claude hook cases, and the release workflow test assumes LF while the working file has CRLF. Those files were not changed. The full suite is **not claimed passing**.

Hostile text and child watcher shutdown/reload are verified using actual filesystem events at the mocked Pi API/lifecycle boundary; the two named live journeys provide real Pi runtime proof, not additional hostile-text model or child-reload journeys. Earlier parallel/reload, closed-resume and parent-death journeys from the separate verification worktree were not rerun here. No blanket T4/all-journeys acceptance is claimed.

Artifacts rely on local OS/filesystem trust, not protection from a malicious same-user writer. Accepted means synchronous API dispatch returned, not exactly-once model processing. Ambiguous requests remain reserved and never trigger replacement launch. Recovered unverified panes retain their existing control-disabled policy.
