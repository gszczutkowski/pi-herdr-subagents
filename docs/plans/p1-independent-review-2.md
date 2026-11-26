# P1 independent review #2 (repair round 1)

**VERDICT: CHANGES REQUIRED** (P1 criterion `758d9721-b6bf-46a2-971d-d5245f5d1351`). The two original reproductions are fixed. Parent retains acceptance.

## Finding

**Medium — notification handoff can promote a conflicted after-intent record into proof of no terminal send.** [`runtime-store.ts:426–437,489–495`](../../pi-extension/subagents/runtime-store.ts#L426), [`dispatch-recovery.ts:54–64,347–356`](../../pi-extension/subagents/dispatch-recovery.ts#L347), [`delivery.ts:81–100,160–185`](../../pi-extension/subagents/delivery.ts#L81), [`index.ts:732,2006–2009`](../../pi-extension/subagents/index.ts#L732).

- **Trigger:** A saved `dispatch-intent` run has the exact bound after-intent marker and sole failure-event cursor, but the event is `pending`, not a tombstone. The normal `recordDispatchFailure` producer cannot create this state; the public store `enqueue` accepts it, and the loader accepts the resulting persisted state. The pre-start dispatch view correctly identifies `EVIDENCE_CONFLICT` because `isUnsentEvent` requires `handedOff`.
- **Reproduction:** In the fake-Pi/terminal fixture, `prepare` and `commitFreshDispatch`, then `enqueue(failureId, runId, exactMarkerEnvelope)` and restart. Startup restored the notification and called mocked Pi `sendMessage` once with `triggerTurn: true`. Delivery changed the event from `pending` to `handedOff`. The next `subagents_reconcile` reported `resolved / before-send`, cleared the original reservation, and a subsequent explicit `subagent_resume` started a different run (`panes=1`, `sends=1`). No terminal command was sent automatically. A parent notification handoff is not transport evidence, but it changed the canonical verdict without new proof.
- **Smallest correction:** Treat after-intent marker envelopes as import-only. Reject them on ordinary `enqueue`. Quarantine already-persisted non-tombstone marker events during delivery restoration (including branch-ack promotion), and fence generic status transitions so delivery cannot make one a tombstone. Preserve the per-run conflict/owner without pausing unrelated deliveries or transport. Add a restart regression proving the persisted event stays conflicted with its reservation held, zero parent notifications and zero terminal sends, and same-session retry refused. Keep the ordinary `recordDispatchFailure` path and clean journal import unchanged.

## Original findings and coverage

1. **Contradictory structured canonical metadata:** The shared `isAfterIntentFailure` predicate checks exact run marker and the optional structured `before-send / verify-resume-images` evidence in both canonical store publication and outbox classification. Independently reran the regression: `send-possible / send-to-terminal` is rejected by publication; the same already-persisted mixed envelope remains a run-local conflict with owner retained and no retry/transport.
2. **Conflicting side journal:** Startup and explicit supervision now use the per-run evidence disposition, not canonical evidence alone. Both tested startup timings retain the artifact reservation, reject same-session retry, permit an unrelated start, and only release on a clean reread after removing the conflict. Surface and pending close/continuation controls protected the owner in the explicit reconciliation regression.

Reviewed the six scoped files, terminal ordering, plan binding/import and ownership/delivery call sites against the P1 description and round-1 findings. The final image verification is still synchronous after durable intent and before `sendHerdrCommand`. Clean canonical/journal proofs bind original run, session path, start time, plan binding and sole cursor; journal import retains its writer/parent/selected-plan checks. The targeted suite covers idempotent metadata import, bare intent staying unknown, and fresh explicit retry. No normal producer of the new finding's invalid shape was observed; it concerns persisted input, not the ordinary exact-evidence path. `delivery.ts` is unchanged from the Git index (`c5d604c433b590b6f7eca9b40ea4956b9df94855`); the regression is its interaction with the new P1 marker. The extensive dirty tree also contains unrelated backlog; previous review blobs are recorded in its report but not available as local Git objects for exact inter-round diff. No P3 or public v2 acceptance implied.

## Independent checks

Windows, Node `v24.21.0`, subprocess child markers unset for Node tests (`env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS`):

| Command/check | Result |
| --- | --- |
| `node --test test/dispatch-recovery.test.ts` | 32/32 passed. |
| `node --test test/dispatch-failure.test.ts` | 2/2 passed. |
| `node --test test/runtime-recovery.test.ts test/runtime-store.test.ts` | 20/20 passed. |
| Combined serial run of all four files, `--test-concurrency=1` | Timed out at 120 seconds after the dispatch files reported passing; separate runs above completed. |
| `npm run typecheck && npm run lint && git diff --check` | Passed; existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| Independent stdin `node --input-type=module-typescript` probe with fake-Pi/terminal fixture | Reproduced the finding, including one mocked parent notification and one terminal send only after an explicit new resume. No source/test file changed. |

The six hashes before and after independent checks matched `docs/plans/p1-repair-verification.md` exactly. No full `npm test`, live Pi/herdr transport, or Linux claim. Only this report was written; no source/test edits, commits, or pushes.

| File | Git blob |
| --- | --- |
| `pi-extension/subagents/dispatch-recovery.ts` | `7fa860534ab6548263e62e71714d14fc5f2629d9` |
| `pi-extension/subagents/index.ts` | `9287d97898860f78a0b6c71ffdc283f9ca2037ad` |
| `pi-extension/subagents/plan-runtime.ts` | `60b6f5077ba4102cb9a8699c4de1d98918f4ef0a` |
| `pi-extension/subagents/runtime-recovery.ts` | `e07ac23f91a77e10712b71baacd89d3a8f8a2212` |
| `pi-extension/subagents/runtime-store.ts` | `ab1c3735c8afdc374e929356d12638832c11a6a9` |
| `test/dispatch-recovery.test.ts` | `2be66848b660630331907385657649d3b6bc04b4` |

Correlation: `planId=c860a4c2-151b-416f-8eb2-84fb2d7ddd88`, `taskId=c9afb479-c9db-49b1-a6ac-df8c071a9aea`, `attemptId=635d2cf8-63eb-4c50-a390-13a023b3ffc3`, `runId=6d63a38d-36ce-43c8-b665-e068e06f3236`.
