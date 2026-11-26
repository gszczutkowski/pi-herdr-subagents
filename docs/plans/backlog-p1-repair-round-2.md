# Backlog P1 — repair round 2

**Worker implementation and targeted checks complete.** Both findings from [independent review #2](backlog-p1-independent-review-2.md) have proposed fixes. Independent review #3 and coordinator acceptance are pending.

## Changes and evidence

- **Durable session owns an after-intent conflict.** `index.ts` matches a blocked after-intent incident to the existing run's session or the selected plan's run relation, not to a second session named only by the disputed side journal. The ownerless journal fence remains conservative. Live and startup tests change only `sessionFile`: the original stays blocked and reserved, the side record is unchanged across custody rotation, no failure is imported, and one explicit resume sends exactly once to the otherwise unbound session. A live control also launches an independent fresh spawn under the readable conflict. An ownerless control stays blocked with no durable run synthesized.
- **Live journal errors fence new transport.** Fresh spawn checks current store custody and journal readability both before reservation/pane allocation and synchronously at the terminal `onDispatch` boundary, before committing intent. It does not need to clone historical runs/outbox for that check. Current-store reads in spawn, resume and recovery inspection latch read/schema errors under the same writer; reading successfully later or reloading that writer does not clear the fault. A failed explicit reconcile retains the fence; successful explicit reconcile can clear it and reestablish recovery supervision after a fenced reload. Readable per-run discrepancies do not set the storage latch. No changes to the intent/final-image checks, existing canonical publication, cursor quarantine, retention, or plan/delivery projections.
- **Fault injection:** `openSync` returns EIO only for a current-generation same-run after-intent journal. Fault present before spawn gives zero panes/sends without a prior diagnostic or reconcile; when resume discovers it first, the subsequent spawn is also blocked. A fault appearing during pane creation gives one pane, zero sends and no committed intent for the refused launch. Clearing EIO does not allow transport before explicit metadata repair. Repair imports exactly one bound failure and releases the original reservation without notification or replay; subsequent explicit spawn sends once under a separate run ID.
- The [round 1 report](backlog-p1-repair-round-1.md) now has an erratum and corrected `test/runtime-store.test.ts` and `test/runtime-recovery.test.ts` hash rows. Neither test file changed.

## Checks

Windows, Node `v24.21.0`, npm `11.19.0`. The new cases use mocked terminal transport. The first focused command below was red before the source change (both mismatched-session resumes were rejected; EIO did not reject fresh spawn). Subsequent development runs exposed and fixed supervisor handling around a fenced reload while preserving ordinary no-supervisor recovery. Two combined ancillary-check attempts reached the tool timeout (360s and 620s); split reruns below completed with no failures. Results from intermediate/timeout runs are not included in the final total.

| Exact command | Result |
| --- | --- |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-name-pattern='side-only journal conflict.*sessionFile\|live journal EIO' test/dispatch-recovery.test.ts` | Expected RED 0/5 before the fix. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-name-pattern='closed resume recovers a failed final image check\|side-only journal conflict.*sessionFile\|ownerless after-intent journal\|live journal EIO' test/dispatch-recovery.test.ts` | PASS 10/10 focused. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | PASS 57/57. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/runtime-recovery.test.ts test/runtime-store.test.ts` | PASS 20/20. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/delivery.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts` | PASS 35/35. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test test/settled-completion.test.ts` | PASS 24/24. |
| `npm run typecheck && npm run lint && git diff --check` | PASS; existing Git LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| `git diff --no-index --check -- /dev/null test/dispatch-recovery.test.ts`; same command for `pi-extension/subagents/dispatch-recovery.ts`, `docs/plans/backlog-p1-repair-round-1.md` and `docs/plans/backlog-p1-repair-round-2.md` | No whitespace diagnostics; exit 1 for differences from `/dev/null`, with LF/CRLF warnings. |

**136/136 final targeted tests**, no skips or cancellations. Permanent controls also cover nonempty failure proof, malformed marker whole-cursor quarantine, original memory evidence pinned across custody rotation, exact run/session/plan binding and genuine ordinary completion. No full `npm test`, authenticated Pi/herdr, or Linux run. No P3 or public ready-order v2 changes, commit, push, deployment, or parent-plan mutation.

## Version for independent review #3

Working tree on `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. SHA-256 comparison to the pre-round dirty/untracked snapshot shows only `pi-extension/subagents/index.ts`, `test/dispatch-recovery.test.ts`, the round 1 report erratum and this new report changed. Git-filtered `git hash-object <path>` IDs for the tested source/test snapshot:

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` | `fc785fbfa62e2e90ee9c840aba37d0e2eaf4bca3` |
| `pi-extension/subagents/dispatch-recovery.ts` | `4c190eca6aa7492fef71d077290d09307700fb41` |
| `pi-extension/subagents/plan-runtime.ts` | `1879384b0cebb7819d7ea47e7519f2b1fef3888c` |
| `pi-extension/subagents/runtime-recovery.ts` | `28ae3c8579ff84d3dfb80b40e70bcbb0ca8b9fa2` |
| `pi-extension/subagents/delivery.ts` | `a572387b59ead9945f21433bf0a6d84236b5cd9f` |
| `pi-extension/subagents/index.ts` (changed) | `c58aac4c78ad2fc2f4cd2ab22ef18795780ebb91` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` (changed, pre-existing untracked file) | `1d4fa0bbabf6cb0255cb6f34b47078a659c340eb` |
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

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=da1c2cc0-5d30-46b6-9612-3d46a100160f`, `runId=bcf478d7-e51c-43ea-98e6-780b10669495`.
