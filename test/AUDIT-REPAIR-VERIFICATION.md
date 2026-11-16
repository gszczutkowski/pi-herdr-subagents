# Audit repair verification

Date: 2026-11-16. Branch: `fix/subagent-repair-sequence`; base HEAD `d226f33`.
This records the repair of `AUDIT-REPAIR-HANDOFF.md`, not a new audit of every
optional backlog item. Existing uncommitted work was preserved; no commit/reset
or global Pi installation change was performed.

## Implemented scope

| Item | Implementation and retained guarantees | Regression evidence |
| --- | --- | --- |
| R1 | Explicit done/ping stage intent. Only `agent_settled` freezes and publishes a result and requests shutdown after successful publication. Ping wins mixed ping/done; first same-kind intent wins. Failure tracking is restricted to the completion batch, not earlier successfully recovered tool errors. Aborted staged work reports error + keepOpen. | `settled-completion.test.ts`, `caller-ping-loop.test.ts`, `keep-open.test.ts`; real Pi scheduler and deterministic providers, slow/error/aborted siblings, automatic/explicit completion and extra native boundary continuation. |
| R2 | Bind supervised run to canonical session path and original header, verify disk identity at publication, retain active-task/branch summary boundaries. Unrelated new/resume/fork sessions detach instead of completing/closing the old task. Reload and exact-original resume preserve supervision. Bootstrap skill failure uses the same identity-gated pending publication; non-mismatch I/O/JSON validation failures block input without consuming required skills. | `completion-session.test.ts`, `completion-turn.test.ts`, `initial-skills.test.ts`; native runtime replacement/reload/tree and injected validation failures/retry. |
| R3a | Watcher cleanup is independent of diagnostic storage; native callback and watcher-error failures cannot throw through the Node callback. Claimed uncertain dispatch is never replayed. Watcher is unreferenced. | `live-continuation.test.ts`, including ENOSPC/EACCES/EIO. |
| R3b | Immutable settled payload/target/event ID retained until successful publication; initial attempt plus three bounded automatic retries (100/500/1000 ms), then observable pause. `/subagent_retry_completion` retries in the child without a model turn. Pending data survives in-process reload, not process death while storage is unavailable. | `completion-retry.test.ts`; exact bytes, one logical result, reload, retries, explicit recovery, no false delivered/shutdown. |
| R3c | Recovered supervision exposes per-run paused errors without disabling healthy runs. Explicit `/subagents-reconcile` performs bounded artifact reconciliation (100 events/pass), never child launch or uncertain dispatch replay. Active watcher read failures also pause without closing the child or losing ownership. | `runtime-recovery.test.ts`, `ownership-execute.test.ts`; active ENOSPC/EACCES/EIO, recovery, healthy-run isolation, bounded passes and custody fences. |
| R4a/b | Shared `shellComment()` comments every physical CR/LF/CRLF metadata line in every driver and terminal writer. Template replacement scans the original template once; inserted values are never expanded again. Trusted executable templates remain supported. | `launch-data.test.ts`, `terminal-launch.test.ts`, `harness-drivers.test.ts`; quoted separators, Unicode, newlines and literal placeholders. |
| R4c | Every Pi prompt shape, including direct/fork and closed resume, travels in one controlled `@artifact`. File contents are not recursively parsed as flags or attachments. Initial role/skills/task share one input; closed resume does not replay initial skills/role. Live continuation remains literal through its guarded API. | Native parser/file processor/provider tests in `launch-data.test.ts`, `role-delivery.test.ts`, `initial-skills.test.ts`, `launch-profile.test.ts`. |
| R5 | Project role sources and local user-level agentDirs require separate exact-source approval in the parent user profile's `subagent-trust.json`. Host/saved target denial wins; agents-only default is not approved. Discovery uses authorized cwd; dispatch revalidates source/hash. Saved provenance records originating checkout cwd independently of a junction/symlink target. Resume rechecks grants and source; legacy named profiles without provenance reject. Project denial propagates as `--no-approve`, never implicit approval. | `project-trust.test.ts`, `discovery.test.ts`, `ownership-execute.test.ts`; isolated native bootstrap payload stays unexecuted, same-name override denial, target cwd, revocation, source changes and junction-backed roles resumed from another cwd. |
| R6 | Retained-event fingerprint/index + Set-backed committed membership; small store selectors; append-only outbox tail and failed/new-only plan import queue; no hashing unmarked/unrelated publication content. Historical evidence is retained and edits still detected. | `resume-safety.test.ts`, `runtime-store.test.ts`, `runtime-recovery.test.ts`, `plan-import-publication.test.ts`, `context-publication.test.ts`. |
| M9 | Abort checked before preparation and at dispatch; shell-ready delay is cancellable. Accepted child lifetime/watch signal remains separate from the short-lived tool signal. | `ownership-execute.test.ts`. |
| M10 | Legacy synchronous herdr calls have 15-second timeout with SIGKILL; original ambiguous dispatch errors propagate without replay. | `terminal-launch.test.ts`; isolated inert hanging CLI, one dispatch, bounded termination. |
| M11 | Local host/peer/dev requirements updated to Pi 1.5.2; lockfile uses `undici@8.12.3`, `minimatch@11.0.3`. No force overrides or global package patching. | Full suite on patched dependencies and `npm audit`: zero vulnerabilities. |

## Integrated verification

- Final `npm test`, local Pi/pi-ai/pi-tui **1.5.2**, Node **24.21.0**, Windows:
  **712/712 pass; 0 failures, skips, cancellations; 287,777.1617 ms**.
- Final `npm run lint`: exit 0.
- `npm audit`: **0 vulnerabilities** after `npm install --ignore-scripts`.
- `git diff --check`: exit 0 (Git LF/CRLF conversion notices only).
- Earlier complete baseline on Pi **1.3.0**: **707/707 pass**, no skips/cancellations,
  224,407.9627 ms. The final five additional review regressions and host-specific
  test adjustments were subsequently verified on 1.5.2, not rerun on 1.3.0.
- The first 1.5.2 run exposed a removed test-only `pi-ai.Type` export and native
  append rollback improvements. Fixtures now import TypeBox explicitly, assert
  native rollback, and separately simulate memory-ahead-of-disk to keep the
  original reconciliation guard covered. No production guard was weakened.
- Existing and new tests are all included in the explicit `package.json` list.
  No full typecheck was performed: the project has no typecheck script/compiler.

Reproduction: `npm install --ignore-scripts`, `npm run lint`, `npm test`,
`npm audit`, `git diff --check`. Temporary full-run outputs in this session:
`C:/Users/grzeg/AppData/Local/Temp/pi-herdr-full-1.3-final.txt` and
`C:/Users/grzeg/AppData/Local/Temp/pi-herdr-full-1.5-final.txt`.
Focused worker/test counts overlap the final suite and are not added to 712.

## Measured performance limits

The 1,000 retained, committed-event fixture records **0 payload reads and 1,001
metadata stats** on an empty poll, keeping all 1,000 files. Restart, new event,
metadata/content corruption and retry are covered. This is an operation-count
fixture, not a disk-time benchmark: directory enumeration/stat work remains
linear to detect edits. One hundred unchanged store custody checks reread no JSON;
metadata changes trigger validation. Empty plan-publication phases read no old
outbox payloads, and one newly appended event reads/imports only that tail.
These are local I/O/CPU optimizations, not measured model-token savings.

## Review and limitations

Read-only review found and prompted fixes for three concrete issues: junction
origin trust, fail-open startup-skill validation, and historical recovered tool
errors poisoning completion. The reviewer approved the latter two fixes and their
inspected regressions; parent verification supplies the full-suite evidence.
Reviewers did not independently execute the final suite. Some worker/review turns
ended on diagnostic-tool failures; their incomplete turns were not treated as
acceptance. Parent integration and the final passing suite supersede intermediate
failures, including incomplete old test contexts and stale CLI regexes.

**No live herdr/provider end-to-end claim.** `HERDR_ENV` is unset and no `herdr`
command is available in this parent environment. Native Pi/SDK tests use
controlled providers, isolated temp profiles and mocked terminal/OS boundaries.
No historical private session was replayed, no payload was executed in the real
user profile, and no external model was called by these tests. Publication,
synchronous handoff, model consumption, process exit and plan acceptance remain
separate facts. Full live e2e still requires the integration skill/preflight and
explicitly authorized fresh test sessions.

The global Pi executable was not updated. Upgrade the actual host to **1.5.2+ on
the compatible 1.5.x line** before relying on the patched dependency baseline.
Project approvals are intentionally empty unless the user explicitly configures
them; this session did not grant any checkout user-level executable trust.
Optional audit items M4/M5/M6, snippet/metrics work, CI/module refactors and unrelated
backlogs remain outside this repair scope.
