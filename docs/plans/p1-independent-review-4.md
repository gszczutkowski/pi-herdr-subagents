# P1 independent review #4 (final repair round 3)

**VERDICT: CHANGES REQUIRED** — criterion `758d9721-b6bf-46a2-971d-d5245f5d1351`. The prior plan-quarantine reproduction is fixed; a malformed canonical envelope still projects a result for a run proven not sent. No additional repair round was authorized. Parent retains acceptance.

## Finding

**Medium — a marked before-send failure can put its task in review as if the child produced a result.** [`runtime-store.ts:111–117,462–474`](../../pi-extension/subagents/runtime-store.ts#L111), [`plan-runtime.ts:90–103`](../../pi-extension/subagents/plan-runtime.ts#L90), [`plan-store.ts:609–619`](../../pi-extension/subagents/plan-store.ts#L609).

- **Trigger and repro:** Bind a run to a current attempt, prepare it, and commit its intent. Publish the exact run-bound `subagent_result` marker with `details.error: ""`, no `errorMessage` or nonzero `exitCode`, and the original sole failure-event ID. The scoped canonical writer `RuntimeStore.recordDispatchFailure` accepts and persists this as `handedOff`; the verifier checks that `error` is a string, not that it can represent a failure to the importer. Close the writer and emit `session_start`. In an independent stdin probe, startup advanced the plan one revision, recorded immutable `kind: "result"`, and moved the task from `in_progress` to `in_review`. Explicit reconciliation still reported `resolved / before-send`; no parent notification occurred. No direct on-disk mutation, transport call, or normal producer of the empty error was needed or observed.
- **Impact:** The same canonical envelope is treated as proof that execution never started and as an ordinary result eligible for parent review. This is not automatic acceptance or transport, but the immutable result and review state are false, and replay does not correct them.
- **Smallest correction:** Require a nonempty failure string in the shared `isAfterIntentFailure` predicate so both publication and recovery reject the malformed shape. Regressions should check rejection on publication and run-local quarantine/no plan revision change for an already-persisted tombstone with the same shape. Leave ordinary result projection unchanged.

## Prior findings and coverage

- `index.ts:1875–1915` routes immediate record, callback, initial and tail restoration through `importPlanEnvelope`; startup, explicit reconcile, turn and post-compaction retries use the same callback. The marked branch inspects the current canonical envelope even when a failure-ID callback omits its marker. `dispatch-recovery.ts:386–398` checks custody and unpaused state, exact current tombstone and cursor, original binding, original selected writable plan authority and attempt run membership, and rebuilt disk/in-memory side-evidence disposition. The prior `pending`, `dispatching`, mixed `handedOff`, and contradictory side journal cases did not mutate the plan or set global plan-import errors. Clearing both conflict sources permits exactly one import on the original run. An independent compaction probe also confirmed deferral and idempotent import after memory-only repair, plus refusal for changed or omitted markers, wrong authority and lost custody.
- Clean bound canonical and verified bound journal controls import one failure on the original attempt. Ordinary bound pending results still project without waiting for notification handoff. The owner/supervisor regressions retain reservations for same-run conflicting side evidence, and release artifact-only reservations on clean proof without clearing surface or pending controls. Enqueue, restoration (including branch ack), durable status transitions and flush do not promote or notify marker-bearing events.
- The terminal callback still checks final images synchronously after durable intent and before the terminal send. Both canonical and failed-write journal paths, with and without a supervisor, are metadata-only; measured transport counters changed only for a separate explicit successful resume. Bare intent remains dispatch-unknown. The larger dirty backlog, P3 and public v2 were not reviewed for acceptance.

## Independent checks

Windows, Node `v24.21.0`. Node test/probe subprocesses unset `PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION` and `PI_DENY_TOOLS`.

| Command/check | Result |
| --- | --- |
| `node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | 44/44 passed. |
| `node --test test/runtime-recovery.test.ts` | 9/9 passed. |
| `node --test test/runtime-store.test.ts`; `node --test test/delivery.test.ts` | 11/11 and 29/29 passed in isolated reruns. An initial combined delivery/store/plan run timed out at 130 s. |
| `node --test --test-concurrency=2 test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts` | 5/5 passed in the separate rerun. |
| `npm run typecheck && npm run lint && git diff --check` | Passed; existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| Two independent stdin probes using the repository's synthetic parent fixture | Exact-envelope/custody/authority and compaction conflict/repair controls passed. Empty-error canonical publication and erroneous ordinary result at startup reproduced the finding. |

Before and after independent checks, these seven `git hash-object` IDs matched [the repair verification](p1-repair-verification.md):

| File | Git blob |
| --- | --- |
| `pi-extension/subagents/delivery.ts` | `37f4aea81962548cc9c60cccd9c808a0a941d0c2` |
| `pi-extension/subagents/dispatch-recovery.ts` | `baddcfa293f4dcd8abbaba6f4875b91492e706bc` |
| `pi-extension/subagents/index.ts` | `26178d71f651b698d0382758f2ce18de6fd48c3a` |
| `pi-extension/subagents/plan-runtime.ts` | `e78c653386046dfff13f65e8163abfdb77207230` |
| `pi-extension/subagents/runtime-recovery.ts` | `e07ac23f91a77e10712b71baacd89d3a8f8a2212` |
| `pi-extension/subagents/runtime-store.ts` | `479da5729967efb60ae1de6d457ac3557e4d8147` |
| `test/dispatch-recovery.test.ts` | `92a0fd3d0a887fbcf3086c31b4e9921bac5d3703` |

No full `npm test`, live end-to-end Pi/herdr transport or Linux verification. This report is the only tracked/worktree file written by this review; no source/test edits, commits or pushes.

Correlation: `planId=c860a4c2-151b-416f-8eb2-84fb2d7ddd88`, `taskId=c9afb479-c9db-49b1-a6ac-df8c071a9aea`, `attemptId=635d2cf8-63eb-4c50-a390-13a023b3ffc3`, `runId=3d897862-c8a5-4163-84a3-5b19662f997f`.
