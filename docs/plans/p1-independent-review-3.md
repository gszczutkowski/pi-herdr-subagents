# P1 independent review #3 (repair round 2)

**VERDICT: CHANGES REQUIRED** (P1 criterion `758d9721-b6bf-46a2-971d-d5245f5d1351`). The previous notification-promotion reproduction is fixed. A separate plan-projection path still trusts the quarantined claim. Parent retains acceptance.

## Finding

**Medium — a quarantined after-intent failure can still fail the bound plan task.** [`index.ts:1874–1904,2001–2009`](../../pi-extension/subagents/index.ts#L1874), [`plan-runtime.ts:78–100`](../../pi-extension/subagents/plan-runtime.ts#L78), [`plan-store.ts:602–619`](../../pi-extension/subagents/plan-store.ts#L602).

- **Trigger:** Restart with a bound `dispatch-intent` run and its sole, exact-marker failure event persisted as `pending` or `dispatching`. The same problem occurs with a `handedOff` marker whose structured metadata says `send-possible`. The delivery and dispatch layers already quarantine these as conflicts. The startup/explicit/turn plan importer independently enumerates the whole outbox, discards event status, and imports a failure through `delivery.onEnvelope` without checking the verified dispatch disposition. This is a P1 interaction with the existing ordinary outbox projection; pending ordinary results are intentionally eligible for plan import.
- **Evidence/impact:** Independent stdin probe using the synthetic registered extension fixture: persist the bound event directly in a temporary manifest (the repaired enqueue correctly refuses it); restart, then reconcile. For `pending`, `dispatching`, and mixed `handedOff`, the durable event status stayed unchanged, reconciliation reported `still-blocked / EVIDENCE_CONFLICT`, and the run kept its artifact reservation with zero parent messages. Nevertheless **startup changed the original plan task from `in_progress` to `failed`, advanced revision 3 → 4, and added the unverified claim as an immutable `kind: failure` result to the original attempt**. This can change dependencies and force a parent retry decision even though reconciliation cannot establish that the run failed before transport. A clean bound `handedOff` control correctly imported and resolved. This finding is about unverified plan mutation, not notification, automatic send or an authorized replacement transport.
- **Smallest correction:** For marker-bearing events only, require the exact outbox event and a clean, verified before-send disposition (including side conflicts) before the retry/startup projection calls `importPlanEnvelope`. Re-evaluate deferred claims after repair; do not mark them imported or turn quarantine into a global import error. Keep the ordinary pending-result projection and legitimate tombstone/journal imports working. Add a plan-bound restart case checking the conflicted attempt and plan revision are unchanged, along with the existing owner/notification/transport assertions and a clean bound control.

## Checks

Independent on Windows, Node `v24.21.0`; Node tests had `PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`, and `PI_DENY_TOOLS` unset.

| Command/check | Result |
| --- | --- |
| `node --test test/dispatch-recovery.test.ts` | 35/35 passed. |
| `node --test test/dispatch-failure.test.ts` | 2/2 passed. |
| `node --test --test-concurrency=2 test/delivery.test.ts test/runtime-store.test.ts` | 40/40 passed. |
| `node --test test/runtime-recovery.test.ts` | 9/9 passed on longer rerun. Initial 100 s attempt timed out. |
| `node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | Initial 90 s combined attempt timed out after both dispatch-failure tests and all three marker restart cases had reported passing; separate runs above completed. |
| `npm run typecheck && npm run lint && git diff --check` | Passed; existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| Independent stdin `node --input-type=module-typescript` using the existing synthetic parent fixture | Reproduced the plan-projection defect for both non-tombstone states and mixed handed-off evidence; clean control imported and resolved. No source/test file written. |

The seven `git hash-object` IDs matched the worker's verification report before and after testing/review:

| File | Git blob |
| --- | --- |
| `pi-extension/subagents/delivery.ts` | `37f4aea81962548cc9c60cccd9c808a0a941d0c2` |
| `pi-extension/subagents/dispatch-recovery.ts` | `dc8507b0eef6ad8a31c4b8304f7e44a06a77b09d` |
| `pi-extension/subagents/index.ts` | `9287d97898860f78a0b6c71ffdc283f9ca2037ad` |
| `pi-extension/subagents/plan-runtime.ts` | `60b6f5077ba4102cb9a8699c4de1d98918f4ef0a` |
| `pi-extension/subagents/runtime-recovery.ts` | `e07ac23f91a77e10712b71baacd89d3a8f8a2212` |
| `pi-extension/subagents/runtime-store.ts` | `479da5729967efb60ae1de6d457ac3557e4d8147` |
| `test/dispatch-recovery.test.ts` | `6530787c0da2e6aa2357e661520dc84600f8e674` |

## Coverage

Reviewed the seven scoped files and relevant terminal, ownership, plan-result and delivery call sites. Ordinary enqueue rejects marker-bearing envelopes; generic delivery refuses all status changes for marked events; restart drops them before branch acknowledgement; flush also checks the marker before sending. The tested `pending` (with and without acknowledgement) and `dispatching` cases kept the exact per-run conflict/reservation, refused same-session retry and neither notified nor sent. Unrelated ordinary delivery and a fresh explicit resume after a clean tombstone remained usable. The earlier mixed canonical and same-run journal/supervisor reproductions remain fixed for dispatch classification and reservation release. Verified the final synchronous image check remains between durable intent and transport, the exact run/session/start/plan/cursor checks and journal parent/writer/retained-record checks, and the tested metadata-only, idempotent repair with no automatic replay. The new finding is confined to the plan projection of P1 marker events; the larger dirty backlog, public v2 and P3 were not reviewed for acceptance. No full `npm test`, end-to-end Pi/herdr transport, or Linux verification claimed. Only this report was written; no source/test edits, commits or pushes.

Correlation: `planId=c860a4c2-151b-416f-8eb2-84fb2d7ddd88`, `taskId=c9afb479-c9db-49b1-a6ac-df8c071a9aea`, `attemptId=635d2cf8-63eb-4c50-a390-13a023b3ffc3`, `runId=a3e2e56b-4e3d-426a-ba9d-953b0b1a4369`.
