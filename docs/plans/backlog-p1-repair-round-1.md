# Backlog P1 — repair round 1

**Worker implementation and targeted verification complete.** This addresses both findings in [independent review #1](backlog-p1-independent-review-1.md), on top of the [nonempty-error repair](backlog-p1-iteration-2026-11-18.md). Independent review #2 and coordinator acceptance are pending.

## Fixes and regression evidence

1. **Readable side-only mismatch is run-local.** `dispatch-recovery.ts` distinguishes a schema-valid record that conflicts with its durable run from journal read/validation and actual write/custody failures. Live reconcile and startup keep the conflicting run reserved, with `EVIDENCE_CONFLICT`, without pausing an independent launch. The disputed side file is left byte-for-byte intact across rotation. If an independent in-process original from the current writer still matches the durable run, reconciliation pins that exact record using the existing bounded manifest retention. The conflict still prevents publication; only a later clean evidence view can import the retained original. A disk-only mismatch gains no custody: even changing it to otherwise matching data after rotation cannot make it proof. An actual failure to pin the original (`ENOSPC` in the regression) still causes a storage pause. Existing read/validation, generation, writer and plan-binding fences remain active.
2. **Malformed marker anywhere in a cursor quarantines the run.** `runtime-store.ts` and `dispatch-recovery.ts` share the exact sole canonical tombstone predicate; marker-bearing envelopes are independently excluded from bound ordinary completion proof. `delivery.ts`, `plan-runtime.ts`, and the `index.ts` import callback honor the whole-cursor quarantine, including ordinary-shaped siblings and callbacks with the marker omitted. `runtime-recovery.ts` refuses artifact-only reservation release for a quarantined cursor even if the original process is absent. Recovery still accepts genuine run-bound ordinary completion proof without notification handoff. The shared nonempty-error predicate remains intact.

Regressions in `test/dispatch-recovery.test.ts` cover live and startup side-only mismatches and preservation of the correct memory copy across simulated process-state loss. They verify no plan import/notification/transport for the conflict, one pane/send for an independent explicit resume, repeated reconciliation and restart without replay, and original-evidence versus stale-generation controls. Restart tests exercise a sole completion-shaped marker and one sharing a cursor with a pending ordinary-shaped result. They verify a readable same-run identity with an absent process and clear writer audit, continued `EVIDENCE_CONFLICT`, the original reservation, unchanged cursor/plan, and zero parent messages or terminal sends on explicit same-session retries.

## Verification

Windows, Node `v24.21.0`, npm `11.19.0`. The focused red command was `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-name-pattern='side-only journal|completion-shaped marker|tracked intent' test/dispatch-recovery.test.ts`: 0/6 before the fix, as expected. The initial green rerun passed 6/6; the complete final dispatch run below includes the added ENOSPC and identity assertions.

| Exact command | Final result |
| --- | --- |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | PASS 51/51. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/runtime-recovery.test.ts test/delivery.test.ts test/runtime-store.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts test/settled-completion.test.ts` | PASS 79/79. |
| `npm run typecheck && npm run lint && git diff --check` | PASS; existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| `git diff --no-index --check -- /dev/null pi-extension/subagents/dispatch-recovery.ts`; `git diff --no-index --check -- /dev/null test/dispatch-recovery.test.ts` | No whitespace diagnostics on the two pre-existing untracked files; diff detected differences from `/dev/null` (exit 1), with LF/CRLF warnings. |

**130/130** final targeted tests, zero skips/cancellations. The permanent new regressions use mocked terminal transport. No full `npm test`, authenticated live Pi/herdr, or Linux verification in this round. P3/public ready-order v2, commits, pushes, deployment and parent-plan binding are unchanged.

## Version for independent review

Working tree on `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. SHA-256 comparison against the starting dirty/untracked file snapshot found changes only to the seven scoped code/test files shown below, plus this new report. Final Git-filtered `git hash-object` IDs (not commits):

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` (changed) | `fc785fbfa62e2e90ee9c840aba37d0e2eaf4bca3` |
| `pi-extension/subagents/dispatch-recovery.ts` (changed) | `4c190eca6aa7492fef71d077290d09307700fb41` |
| `pi-extension/subagents/plan-runtime.ts` (changed) | `1879384b0cebb7819d7ea47e7519f2b1fef3888c` |
| `pi-extension/subagents/runtime-recovery.ts` (changed) | `28ae3c8579ff84d3dfb80b40e70bcbb0ca8b9fa2` |
| `pi-extension/subagents/delivery.ts` (changed) | `a572387b59ead9945f21433bf0a6d84236b5cd9f` |
| `pi-extension/subagents/index.ts` (changed) | `8efd6cbce787836b3087e66eb84a6f3e9657bf6e` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` (changed) | `71bbe03f4ab392f628644be7a7edec2c7656f5a8` |
| `test/dispatch-failure.test.ts` | `f9ca1589e29dddd4932ff40010ebe2c44416f6d6` |
| `test/runtime-store.test.ts` | `e745f9345043f0bfc0fda9578c491845bf1156d5` |
| `test/runtime-recovery.test.ts` | `ba6d999763ba0151766e2d50cbd04044a6ddcb46` |
| `test/plan-runtime.test.ts` | `f6e4aa05f75241097b4ed0aef460020cbf4d0a84` |
| `test/delivery.test.ts` | `b7b2ce4652b89e35c8d9fe60c787cc3ac555dd1a` |
| `test/architecture-authority.test.ts` | `ddad6a284dc15db242368f22611e5d5cceda6167` |
| `test/automated-plan-boundary.test.ts` | `0508de157fd4c80e0a1bab293a8b8f1975046c17` |
| `test/automated-state-boundary.test.ts` | `39de3ddae2ea8c4afc17beffb8fe040975665c61` |
| `test/plan-import-publication.test.ts` | `dd8a5733e06079be6779ce538d96cd8a3fffc204` |
| `test/settled-completion.test.ts` | `4c304c6fd4e9025d36dbb631b33ac08fcac4daf2` |

Round 2 erratum: corrected two hash transcription errors in the table above (`test/runtime-store.test.ts` omitted `bfc0`; `test/runtime-recovery.test.ts` copied `…cbd04444…` instead of `…cbd04044…`). The actual blobs were unchanged, as verified by [independent review #2](backlog-p1-independent-review-2.md).

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=ee8d3fc5-5b3c-46de-bda1-b4ab0c34369b`, `runId=bf1c00ee-d7a2-428b-b824-7f4668384153`.
