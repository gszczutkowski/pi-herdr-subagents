# Backlog P1 — nonempty closed-resume failure proof

**Worker verification complete; independent review and parent acceptance pending.** This is a new authorized P1 iteration after [independent review #4](p1-independent-review-4.md). The previous [verification](p1-repair-verification.md) is historical evidence, not acceptance.

## Change and regression evidence

- [`runtime-store.ts:109–117`](../../pi-extension/subagents/runtime-store.ts#L109) now requires a nonempty `details.error` string for an after-intent before-send marker. The canonical writer (`recordDispatchFailure`) and recovery reader (`isUnsentEvent`) use the same predicate. The latter also gates plan projection: a persisted malformed marker remains import-only and yields a run-local `still-blocked / EVIDENCE_CONFLICT`, not proof of no send. This does not change ordinary result projection, the final profile/transcript check, or legacy unmarked prepared evidence.
- [`dispatch-recovery.test.ts:539`](../../test/dispatch-recovery.test.ts#L539) publishes the exact marker for a plan-bound intent, varying only `error`. It verifies empty-error rejection with unchanged manifest bytes and plan, then accepts a nonempty control with one handed-off event under the original run/cursor.
- [`dispatch-recovery.test.ts:750`](../../test/dispatch-recovery.test.ts#L750) reopens an already-persisted `handedOff` tombstone with empty error, exact marker binding and original event cursor. Startup, direct/callback import, turn and repeated tool/command reconciliation leave the original task `in_progress` at its original plan revision, with no attempt result, no global import/storage error, retained artifact ownership, no parent message and zero terminal sends. Same-session resume is refused. No retrofit of missing proof and no replay.
- Before the validator edit, the two new cases failed for the expected reasons: publication did not throw, and startup appended an immutable `kind: "result"`, incremented the plan revision from 3 to 4 and changed `in_progress` to `in_review`. Both pass with the fix.

## Targeted verification

Windows, Node `v24.21.0`, npm `11.19.0`. Each `node --test` command below was prefixed with `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS` to run the synthetic parent outside inherited child authority.

Before the source change, `node --test --test-name-pattern='nonempty failure string|empty-error-handedOff' test/dispatch-recovery.test.ts` returned the expected red result (0/2 pass).

| Command | Outcome |
| --- | --- |
| `node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | PASS 46/46. |
| `node --test test/runtime-recovery.test.ts` | PASS 9/9. |
| `node --test --test-concurrency=2 test/delivery.test.ts test/runtime-store.test.ts` | PASS 40/40. |
| `node --test --test-concurrency=2 test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts` | PASS 5/5. |
| `npm run typecheck && npm run lint && git diff --check` | PASS, with the existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |

Final targeted total: **100/100**, zero skips/cancellations. The dispatch suites cover canonical and delayed journal reconciliation with and without a supervisor, exact run/session/start-time/plan binding and mismatches, duplicate reconcile with unchanged manifest/plan and zero sends, bare intent fail-closed, and separate explicit launches after recovery (independent session and then the repaired session, one send each with distinct run IDs). They also cover clean bound canonical/journal projection, contradictory side evidence, and ordinary bound pending results still reaching review. These terminal calls are mocked; no claim of live Pi/herdr or Linux verification. Full `npm test` was not run for this targeted iteration. P3 and public ready-order v2 are unchanged. No commit, push or deployment.

## Version for review

Working tree on `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. SHA-256 comparison of pre-existing dirty/untracked contents and their Git statuses identified only the two P1 code/test files below as changed by this iteration, plus this new report. `git hash-object` IDs for the final source/test snapshot (not commits):

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` (changed) | `6c2804dba07fa5395d6ac5cb2c9ab2a35e5dd8f9` |
| `test/dispatch-recovery.test.ts` (changed, pre-existing untracked file) | `f21632efedf960ec25409b8ea0219c514cbb0911` |
| `pi-extension/subagents/delivery.ts` | `37f4aea81962548cc9c60cccd9c808a0a941d0c2` |
| `pi-extension/subagents/dispatch-recovery.ts` | `baddcfa293f4dcd8abbaba6f4875b91492e706bc` |
| `pi-extension/subagents/index.ts` | `26178d71f651b698d0382758f2ce18de6fd48c3a` |
| `pi-extension/subagents/plan-runtime.ts` | `e78c653386046dfff13f65e8163abfdb77207230` |
| `pi-extension/subagents/runtime-recovery.ts` | `e07ac23f91a77e10712b71baacd89d3a8f8a2212` |
| `test/dispatch-failure.test.ts` | `f9ca1589e29dddd4932ff40010ebe2c44416f6d6` |

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=d61d6e5c-b41c-4de2-9e69-67edd4998616`, `runId=10fd4d20-bc84-45ce-ade5-5714c7dd26f5`.
