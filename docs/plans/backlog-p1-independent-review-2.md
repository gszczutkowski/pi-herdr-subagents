# Backlog P1 — independent review #2 (after repair round 1)

**VERDICT: CHANGES_REQUIRED — not APPROVE.** The empty-error regression and whole-cursor marker quarantine pass. The prior storage-wide pause for a readable mismatch no longer reproduces, but a session-binding mismatch can still block an independent resume. A live journal I/O failure does not consistently fence new transport. The coordinator retains acceptance authority.

## Findings

1. **Medium — a readable journal naming a different saved session can block that unrelated resume.** [`dispatch-recovery.ts:215–224,342–356`](../../pi-extension/subagents/dispatch-recovery.ts#L215), [`index.ts:2845–2852`](../../pi-extension/subagents/index.ts#L2845).
   - **Trigger:** Prepare a closed resume and commit its intent. Record a schema-valid, disk-only `before-send / verify-resume-images` journal, with no canonical outbox entry. Change only `record.sessionFile` to another saved session that has no durable run, matching plan run, reservation, or writer. Run explicit reconciliation in the live parent or reopen first.
   - **Evidence/impact:** Both probes reported run-local `EVIDENCE_CONFLICT`, no `Storage/custody` pause, preserved journal bytes and original reservation, and left the original plan and outbox unchanged. Explicit resume of the original was correctly refused. Explicit resume of the unrelated session named only by the disputed field was **also refused with the original run's ID** (`0` panes / `0` sends); a third, unmentioned session started (`1` pane / `1` send). Matching `record.sessionFile` as an independent OR branch lets an unverified field expand the conflict beyond the run. Here the record is specifically an after-intent claim, and only the durable intent can bind it to a session. The permanent conflict tests mutate `startedAt`, not `sessionFile`.
   - **Smallest correction:** For this conflicted after-intent journal with an existing durable run, scope the refusal to the durable run's session and exact plan/run relationship; do not use the disputed journal path to block a second session. Preserve the journal intact and keep separate conservative handling for claims without a durable owner. Add live and startup controls varying `sessionFile`: original remains blocked; the previously unbound named session may launch explicitly once.

2. **Medium — a confirmed live journal read failure blocks resume but not a fresh spawn until explicit reconcile.** [`index.ts:517–524,566–570,1590–1594,2797–2800`](../../pi-extension/subagents/index.ts#L517).
   - **Trigger:** After startup with a writable, owned manifest, publish a same-run side journal and make `openSync` of that record fail persistently with `EIO` (other I/O unchanged). Attempt an independent saved-session resume; the preflight detects `EIO` and refuses before pane allocation. The read-only recovery tool also reports `EIO`. Without invoking `/subagents-reconcile`, request an independent fresh `subagent` spawn.
   - **Evidence/impact:** The registered spawn created one mocked pane, sent once and persisted `supervised` while the journal was still unreadable. The registered reconcile tool then reported `Dispatch metadata write paused (EIO)` and a subsequent spawn was refused with no additional pane or send. `assertStorageAvailable()` only observes the latched repair/recovery state; resume and read-only inspection learn the current evidence read failure without arming the spawn gate, and spawn does not check the journal itself. This violates the live global failure fence, not the startup/reconcile fence. The probe did not replay the old run and does not establish any external session takeover.
   - **Smallest correction:** Apply a shared current-store journal-health gate to fresh spawn preflight and its final dispatch check (or equivalent shared fault propagation plus a fresh transport check); keep real read faults fail-closed until explicit repair and do not globally pause on valid per-run disagreements. Regress a live fault before the next spawn, without requiring an explicit reconcile to discover/fence it; assert zero panes/sends for preflight-detected faults and zero sends for faults appearing during pane setup.

## Independent checks

Windows, Node `v24.21.0`, npm `11.19.0`. All `node --test` and fixture probe invocations used `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS`.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | **51/51 pass**, no skips/cancellations. |
| `node --test --test-concurrency=1 test/runtime-recovery.test.ts test/delivery.test.ts test/runtime-store.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts test/settled-completion.test.ts` | Initial 180 s tool timeout; independent rerun with 360 s limit finished in 178 s: **79/79 pass**, no skips/cancellations. |
| `npm run typecheck && npm run lint && git diff --check` | Pass; existing LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| `git diff --no-index --check -- /dev/null pi-extension/subagents/dispatch-recovery.ts`; same for `test/dispatch-recovery.test.ts` | No whitespace diagnostics on the pre-existing untracked files; exit 1 for differences from `/dev/null` and LF/CRLF warnings. |
| `node --input-type=module -` (stdin fixture wrappers using `spawnSync(process.execPath, ['--input-type=module-typescript', '-'], …)`) | **2/2 + 1/1 diagnostic probes** reproduced findings 1 and 2, respectively. **3/3 control cases** verified startup retention over two rotations and direct reservation-release refusal with a `null` marker, with and without an ordinary sibling. Initial null-marker wrapper lacked the `resumeIntentFailure` fixture helper (two setup errors); corrected rerun passed both cases. Tests used temporary fixtures and mocked transport, not live sends. |

## Coverage

- Reviewed `BACKLOG.md`, the original P1 checklist, both prior iteration reports, and historical P1 review/repair evidence. Compared current Git-filtered blob identities to the reports, not the entire dirty diff to the latest repair. The seven differing files versus review #1 are exactly the seven repair-round files. Earlier worktree blobs are not retrievable from the local Git object database by their published IDs; finding attribution is to current behavior, not to any particular latest edit.
- Verified the nonempty-error guard at canonical publication and reread, including the restart with exact binding and sole cursor: no false result or review state. Verified whole-cursor quarantine through `dispatchIncidents` and bound completion classification, store reservation release, startup/explicit delivery restoration/branch acknowledgement, and plan projection including the marker-stripped callback and ordinary sibling. The absent-process/clear-writer fixture leaves the same reservation and plan/outbox unmodified; no notification/send, including explicit same-session retry. Genuine run-bound completion still settles dispatch without parent notification handoff; ordinary pending results still project normally.
- Verified the synchronous final image check remains after committed intent and before terminal transport, and exact run/session/start/plan/cursor checks remain in place. The canonical and delayed journal paths with/without supervisor, duplicate reconcile, bare intent, explicit independent launch and explicit retry after clean repair passed. The `startedAt`-only conflict and memory pin repairs passed: no unrelated pause, exact original retained, conflicting disk bytes intact across rotation, and stale disk-only generation not adopted. Startup journal read/schema errors retain generation and active reconcile pin-write errors pause the store; the live spawn gap above is distinct.
- **130/130** targeted permanent tests on the reviewed files. No full `npm test`, authenticated live Pi/herdr, Linux, P3 or ready-order v2 acceptance claim. Only this report was written; no code/test changes, commit, push, deployment or parent-plan mutation.

## Reviewed version

Working tree on `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. Before/after `git hash-object <path>` matched for the listed source/test files. Repair round 1 has **19/21 literal matches**: its `test/runtime-store.test.ts` row omits `bfc0`, and `test/runtime-recovery.test.ts` has `…cbd04444…` where actual is `…cbd04044…`. Both current hashes match review #1; the discrepancies are in the repair report table, not evidence of test edits.

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` | `fc785fbfa62e2e90ee9c840aba37d0e2eaf4bca3` |
| `pi-extension/subagents/dispatch-recovery.ts` | `4c190eca6aa7492fef71d077290d09307700fb41` |
| `pi-extension/subagents/plan-runtime.ts` | `1879384b0cebb7819d7ea47e7519f2b1fef3888c` |
| `pi-extension/subagents/runtime-recovery.ts` | `28ae3c8579ff84d3dfb80b40e70bcbb0ca8b9fa2` |
| `pi-extension/subagents/delivery.ts` | `a572387b59ead9945f21433bf0a6d84236b5cd9f` |
| `pi-extension/subagents/index.ts` | `8efd6cbce787836b3087e66eb84a6f3e9657bf6e` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` | `71bbe03f4ab392f628644be7a7edec2c7656f5a8` |
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

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=ee8d3fc5-5b3c-46de-bda1-b4ab0c34369b`, `runId=ef47ec8a-9bf5-4935-9527-3902338a275e`.
