# P1 verification: closed-resume refusal after dispatch intent

The final profile/transcript check stays after the durable `dispatch-intent` and before the terminal call. Only a refusal at that boundary adds an explicit before-send claim. The handed-off outbox event must match the original run ID, session file, start time, plan binding and sole event cursor, with no verified dispatch or continuation. Journal import keeps its parent, writer generation/revision or retained-record, and selected-plan checks. Recovery preserves the intent and imports metadata only; an explicit resume still needs the usual plan, profile and writer checks.

## Review repair 1

- The canonical store and recovery reader share the same shape check. Optional structured dispatch evidence must be the valid `before-send` / `verify-resume-images` variant; mixed claims are refused on publication and reported as a run-local conflict if already persisted.
- Startup and explicit reconciliation derive a per-run disposition from the outbox and side evidence together. A conflict keeps the applicable artifact reservation without pausing unrelated transport. Clearing a conflict does not send anything: only a verified, clean before-send disposition releases the same-run artifact-only reservation, and not when it has a surface or a pending close/continuation control.
- Bare intent, legacy unmarked intent events and possible sends do not become before-send proof. No migration from error text and no automatic retry.

## Review repair 2

- After-intent markers are import-only. The ordinary queue refuses any marker, generic delivery cannot change its durable status, and restart quarantines non-tombstone marker events before checking branch acknowledgements. A matching parent transcript entry is not proof about the terminal.
- Restart regressions inject previously persisted `pending` events with and without branch acknowledgement and a `dispatching` event with acknowledgement. Each stays unchanged and conflicted after repeated reconciliation; the exact reservation is retained, same-session retry remains blocked, and there is no notification/model wake or terminal send for the conflicted run. An unrelated ordinary result delivers exactly once and a clean canonical tombstone still permits a distinct explicit resume.

## Review repair 3

- The plan importer now verifies the exact current canonical envelope, original writer/plan binding and clean per-run disposition before projecting an after-intent failure. This applies to the immediate `recordDispatchFailure` path and the delivery callback shared by startup, explicit reconcile, turn and compaction retries. Deferred claims are neither imported nor surfaced as global task-import errors; later passes can recheck them.
- Plan-bound restart regressions leave the original revision, task and attempt results untouched for `pending`, `dispatching`, mixed `handedOff`, and clean `handedOff` with contradictory journal evidence. They verify owner retention, refusal to resume, zero notifications/transport, and release and exactly one plan import after both disk and in-process conflict evidence are resolved. Positive controls cover immediate bound canonical import, the verified bound journal import, and ordinary bound pending results.

## Checks (Windows, Node v24.21.0)

| Command | Result |
| --- | --- |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | PASS 44/44. All previous P1 regressions and seven new plan projection cases. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test test/runtime-recovery.test.ts` | PASS 9/9. The Windows identity-file rename `EPERM` from the initial round's parallel run did not recur. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/delivery.test.ts test/runtime-store.test.ts` | PASS 40/40. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts` | PASS 5/5. |
| `npm run typecheck && npm run lint && git diff --check` | PASS; existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |

Transport in P1 regressions is mocked. No live Pi/herdr, Linux, full `npm test`, or ready-order v2 verification claim. Public v2 and P3 are unchanged. Independent review #4 is pending.

Tested code blobs (`git hash-object`, not commits):

- `pi-extension/subagents/delivery.ts` — `37f4aea81962548cc9c60cccd9c808a0a941d0c2`
- `pi-extension/subagents/dispatch-recovery.ts` — `baddcfa293f4dcd8abbaba6f4875b91492e706bc`
- `pi-extension/subagents/index.ts` — `26178d71f651b698d0382758f2ce18de6fd48c3a`
- `pi-extension/subagents/plan-runtime.ts` — `e78c653386046dfff13f65e8163abfdb77207230`
- `pi-extension/subagents/runtime-recovery.ts` — `e07ac23f91a77e10712b71baacd89d3a8f8a2212`
- `pi-extension/subagents/runtime-store.ts` — `479da5729967efb60ae1de6d457ac3557e4d8147`
- `test/dispatch-recovery.test.ts` — `92a0fd3d0a887fbcf3086c31b4e9921bac5d3703`
