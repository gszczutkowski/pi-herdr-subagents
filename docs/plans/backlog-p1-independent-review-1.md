# Backlog P1 — independent review #1 (new iteration)

**VERDICT: CHANGES_REQUIRED.** The empty `details.error` publication/restart repair is correct on the reviewed version. Two other fail-closed cases remain open in the P1 recovery path. This is not an acceptance decision; the coordinator retains that authority.

## Findings

1. **Medium — a readable, mismatched side-only journal denies unrelated launches.** [`dispatch-recovery.ts:215–224,259–268,296–304`](../../pi-extension/subagents/dispatch-recovery.ts#L215), [`index.ts:566–570,710–715`](../../pi-extension/subagents/index.ts#L566).
   - **Trigger/reproduction:** Prepare a run and commit its intent. Capture a schema-valid, current-generation `before-send / verify-resume-images` journal without an outbox event. After journal publication, change only its `startedAt` by one; leave the journal readable and the manifest writable. `readDispatchEvidence` returns the record with no storage error. An explicit reconciliation in the live parent reports `Storage/custody: … Dispatch metadata write paused (EVIDENCE_CONFLICT)` with **0 repair writes attempted**. An unrelated saved session is refused before pane creation. After closing and restarting the parent, the same record prevents runtime custody initialization (`Dispatch evidence write blocked (EVIDENCE_CONFLICT)`) and the independent resume is still refused. The two real extension hooks and the independent resume used a synthetic parent and mock terminal; pane/send counts remained `0/0`.
   - **Impact:** This is a logical disagreement about one run, not a current read/write/custody failure. The conflicted run must stay blocked, but it also stops every launch in this parent. The positive run-local test at [`test/dispatch-recovery.test.ts:608–650`](../../test/dispatch-recovery.test.ts#L608) always has a canonical event, and the mismatched-journal test at [487–495](../../test/dispatch-recovery.test.ts#L487) explicitly expects a global `storeError` without one. Neither tests independent transport with a side-only mismatch. The broad no-canonical rule is pre-existing; the new after-intent proof is subject to it.
   - **Smallest correction:** Separate a readable per-run mismatch from a storage failure. Preserve the unresolved record and any valid original evidence across custody rotation, without adopting it as proof, dropping it, or blessing a stale generation. Keep real I/O/custody faults fail-closed globally. Add live-runtime and reopen regressions: no import/send for the conflicted run, one send for an independent explicit launch, and no automatic replay.

2. **Medium — a malformed import-only marker can be counted as execution proof under a completion cursor.** [`dispatch-recovery.ts:310–321,347–365`](../../pi-extension/subagents/dispatch-recovery.ts#L310), [`index.ts:2843–2852,2866–2867`](../../pi-extension/subagents/index.ts#L2843), [`runtime-recovery.ts:24–32`](../../pi-extension/subagents/runtime-recovery.ts#L24).
   - **Trigger/reproduction:** Reopen a structurally valid synthetic manifest with an unverified intent and a sole `handedOff` `subagent_result` containing a `beforeSendAfterIntent` marker. Use `subagent:<runId>:completion:test` for both its outbox key and `details.eventId`, include matching `details.sessionFile` and numeric `exitCode`, and provide a same-run identity whose process probe returns absent and whose writer audit is clear. The manifest reader admits it; notification correctly suppresses it, but reconciliation reports **`resolved` with no incident**. An explicit same-session `subagent_resume` then reaches the mocked terminal **once** under a new run ID. With only the cursor/event ID changed to `subagent:<runId>:other:test`, the same test reports `dispatch-unknown / DISPATCH_INTENT` and refuses the resume (`0` sends). Both cases had `0` parent notifications and `0` sends during reconciliation itself.
   - **Impact:** Recovery only checks for invalid markers at the canonical failure key. `hasBoundCompletion` inspects other cursor entries and does not reject marker-bearing envelopes, so a claim that is neither a valid tombstone nor an ordinary completion can clear the dispatch ambiguity. The fresh process/owner check still runs, but process absence does not establish prior dispatch outcome. The probe models already-persisted inconsistent metadata; no normal producer of the incorrect cursor was observed.
   - **Smallest correction:** Quarantine malformed markers on the whole run cursor (including wrong-key markers), make marker-bearing envelopes ineligible for `hasBoundCompletion`, and retain the conflict as a run-local `EVIDENCE_CONFLICT`. Add a restart regression checking the report, retained reservation, no import/notification, and no send on explicit same-session retry. Do not require delivery handoff for genuine ordinary run-bound completion.

## Checks (independent)

Windows, Node `v24.21.0`. For each Node invocation below I used `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS`.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | **46/46 pass**, no skips/cancellations. |
| `node --test --test-concurrency=1 test/runtime-recovery.test.ts test/delivery.test.ts test/runtime-store.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts test/settled-completion.test.ts` | **79/79 pass**, no skips/cancellations. |
| `npm run typecheck && npm run lint && git diff --check` | Pass. Git emitted the existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| `node --input-type=module -` (two stdin invocations) | **2/2 + 2/2 diagnostic assertions pass**, reproducing the findings, not product acceptance. The stdin wrappers reuse the import/fixture prefix of `test/dispatch-recovery.test.ts` (before its first supervisor test; relative imports rooted at the repository) and run the synthetic cases above via `spawnSync(process.execPath, ['--input-type=module-typescript', '-'], …)`. The first wrapper run had an escaped-regex parse typo; the corrected run is the one counted. No fixture/source files changed. |

## Coverage

- Read the backlog, original P1 review/checklist, historical review #4 and repair verification, and this iteration's worker report. This was a review of current P1 call sites and tests, not attribution of all dirty-tree changes to the latest worker. The eight worker-listed snapshot blobs match. Only `runtime-store.ts` and `test/dispatch-recovery.test.ts` differ from the comparable historical review #4 blobs.
- `runtime-store.ts:111–117,462–495` and `dispatch-recovery.ts:54–62` agree on rejecting an empty string. The publication test verifies no manifest snapshot/byte or plan change on refusal and a nonempty same-run control with one `handedOff` event. The restart test uses the correct marker binding and sole cursor and verifies blocked reconciliation, unchanged plan revision/attempt (`in_progress`, no result), no global import/storage error, retained owner, and no notification or transport. `plan-runtime.ts:86–114` ensures valid marked proofs project as failures, not ordinary results; ordinary bound pending results still project into `in_review`.
- Reviewed the final image check between committed intent and send (`index.ts:3018–3055`, `terminal.ts:94–142`), canonical vs delayed journal evidence, parent/writer and original selected-plan binding fences, exact run/session/start/cursor, delivery import-only controls, startup/turn/compaction/explicit projection ordering, and artifact reservation release with and without the supervisor. Permanent tests verified the clean paths, repeat reconcile without sends/duplicates, bare intent refusal, and distinct explicit launches after recovery. The two findings are additional paths beyond those controls.
- No full `npm test`, authenticated live Pi/herdr, Linux, P3, or public ready-order v2 acceptance claim. Only this report was written; no implementation/test changes, commits, pushes, or deployment.

## Reviewed version

Working tree on `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. Git-filtered `git hash-object <path>` blob identities (not commits); overlapping source/test IDs matched before and after the targeted tests. These match the worker's convention for CRLF-normalized files.

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` | `6c2804dba07fa5395d6ac5cb2c9ab2a35e5dd8f9` |
| `pi-extension/subagents/dispatch-recovery.ts` | `baddcfa293f4dcd8abbaba6f4875b91492e706bc` |
| `pi-extension/subagents/plan-runtime.ts` | `e78c653386046dfff13f65e8163abfdb77207230` |
| `pi-extension/subagents/runtime-recovery.ts` | `e07ac23f91a77e10712b71baacd89d3a8f8a2212` |
| `pi-extension/subagents/delivery.ts` | `37f4aea81962548cc9c60cccd9c808a0a941d0c2` |
| `pi-extension/subagents/index.ts` | `26178d71f651b698d0382758f2ce18de6fd48c3a` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` | `f21632efedf960ec25409b8ea0219c514cbb0911` |
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

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=d61d6e5c-b41c-4de2-9e69-67edd4998616`, `runId=84c3d13b-1cc3-4d99-a656-e200776d0ded`.
