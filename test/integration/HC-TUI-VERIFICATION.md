# Final MAIN authenticated HC TUI verification — 2026-11-14

For the later owned audit/draft-rejection/verified-close journey and its full automated suite, see [HC-CLOSE-VERIFICATION.md](HC-CLOSE-VERIFICATION.md). The five-journey results below are historical evidence, not a claim that every journey was rerun for close hardening.

Final complete confirmation command: **5 passed, 0 failed, 0 skipped, exit 0**. Across all three complete commands: 13 passes and 2 failures; the earlier failures below are retained, not reclassified. No production changes or weakened journey assertions.

## Original plan live criterion (T4): evidence for parent review

All four lifecycle journeys passed against the final production/live-harness source on MAIN. This report supplies evidence for the original live criterion in `.pi/plans/2026-11-14-subagent-orchestration/plan.md`; it is not a second status checklist or child acceptance of the parent's plan.

```bash
PI_TEST_HC_TUI=1 PI_TEST_MODEL=openai-codex/gpt-6.1-sol node --test --test-concurrency=1 test/integration/hc-tui.test.ts
```

The final confirmation command redirected all output to private root `.git/verification/2026-11-14-final-main-confirmation/live.log` and recorded its exit code beside that log. Authenticated readiness required an exact generated assistant reply and observed Pi `mode: tui`, not an open shell. Parent launch requested thinking off; the existing compatible worker profile used minimal. No credentials were copied, global settings changed, or user terminal focused.

| Journey | Run ID | Assertions proved |
| --- | --- | --- |
| Parallel and reload | `b90718ea-d4a7-472a-8e09-3d255b793b32` | Two overlapping child bash gates, distinct run/session IDs, actual child completion inside the instrumented reload shutdown/start interval, both exact markers and two successful correlated parent results without duplicates at the settled observation boundary. |
| Closed resume | `d9dbd8a5-e9ae-48a5-b078-1c89701f23a7` | Original terminal gone, same saved session with prior history and follow-up, new run ID, actual child bash copying the original marker and successful resumed result. |
| keepOpen follow-up | `fff615de-7d4e-4d47-8146-e445e89615cb` | Two real child bash turns and distinct completion event IDs, two parent results, same run/session/terminal and single child startup, surviving Pi after both results; production artifact continuation accepted. |
| Interrupt/live continuation | `51a1509b-5f91-49e0-accf-dae740bdfe79` | Actual active bash gate, explicit `interrupt_requested`, aborted settlement, surviving child and no abort-only result or finished gate marker, accepted production continuation, same run and single startup, follow-up bash marker and result. |

Each run has `assertions.json` with `passed: true` and `cleanup.json` with `allMissing: true`. Full timestamped directory names and owned terminal IDs are in the private summary. The former HC private-command transport and stale coarse-status continuation blockers were corrected by `24632da`/`1b91084`; historical failures remain evidence, not current blockers or passing attempts. See `HC-CONTINUATION-VERIFICATION.md` for that separate correction history.

## Original plan restart criterion (T5): evidence for parent review

Final confirmation run `77825fa4-b701-4afc-8985-00c73133490d` passed:

- The recorded parent Pi PID was present before SIGKILL and absent before restarting the exact saved parent session. The independently owned child terminal survived.
- A new parent process/terminal authenticated again. Generation changed from `17a9e1f4-1e3c-422d-a10a-59c66dd93c69` to `922ed4bd-1c35-4537-b913-53ac879ddbcf`.
- The fresh challenge and child response matched exactly, including the new generation and original child PID `20020`, for child run `86f6d042-d2b6-4ada-a40b-c14b2bef0712`. Recovery was `verified-live: artifact-only supervision; terminal controls disabled`.
- The original single subagent launch and single child startup remained the only ones: recovery did not auto-launch another child. The recovered parent rejected interrupt rather than acknowledging dispatch, and the child's terminal remained present.
- Releasing the original child gate produced its marker/result; a follow-up through the test driver's independent terminal custody produced a second real bash marker and distinct retained completion event. This is not recovered orchestrator control or terminal adoption.
- `assertions.json` passed, `cleanup.json` confirmed all owned terminals missing, and scratch removal completed. All five final journeys matched the complete final source manifest with zero hash mismatches.

A final independent read-only inspection of all 81 recorded owned terminal IDs across this task's 15 journeys and the 16 preserved earlier journeys found every terminal missing. Proof: private `2026-11-14-final-main-confirmation/independent-owned-terminal-cleanup.json`.

These are worker evidence proposals for the original T4/T5 criteria. Parent verification and original plan checkbox/status changes remain parent-owned; this child did not edit an ancestor plan or create a parallel execution checklist.

## Source identity and evidence retention

Initial MAIN commit: `7a7297961ffeb3d8bc9a5950981a80b88a1a2d7e`. During the first attempt, HEAD advanced to `9617c8e288e5c7964fb3b0015b60ce82646302a6` for a concurrent test-fixture-only change to `test/harness-drivers.test.ts`, then documentation-only changes. Both the retry and final confirmation recorded `90bc173079aef1d14775242add7838ea12e21e3b` before its evidence commit was amended, plus an explicitly recorded uncommitted test-only cleanup retry (see below). Production source and behavioral assertions stayed unchanged. Every journey records branch `main`, repository root `E:\Repositories\pi-herdr-subagents`, and identical core SHA-256 values:

| Source | SHA-256 |
| --- | --- |
| `pi-extension/subagents/index.ts` | `5d07baa323908d89a86393086ea5f8817247db556ea581861ef63b3ec790cd3d` |
| `pi-extension/subagents/subagent-done.ts` | `5143896cf851e56c2eabcc3b4231b9bba96c08b339f5cd4587b8df47b70fc120` |
| `pi-extension/subagents/live-continuation.ts` | `094c335b2b1f148d878001d5f1c621282261c0a433d2b4e36999bca1e8ec942b` |

Private root `.git/verification/2026-11-14-final-main-confirmation/` contains final `summary.json`, `source-manifest.json` (all tracked production files plus the three live-harness files) and command logs. `.git/verification/2026-11-14-final-main-retry/` preserves the second attempt and its source manifest. The first attempt remains in `.git/verification/2026-11-14-final-main/`, including its logs, summary, original source manifest, `prior-archive-copy.json` and subsequent scratch cleanup proof. Actual per-journey artifacts are sibling timestamped directories under root `.git/verification/`, with environment/source hashes, launches, actions, observer events, real sessions, terminal text, markers, assertions and cleanup. Do not publish these private artifacts.

All 16 earlier run archives, including failures, were copied from `.git/worktrees/pi-herdr-subagents-live-hc-verification/verification/` to root `.git/verification/prior-live-hc-verification/`: 548 files, 2,195,220 bytes, verified byte-identical. They survive removal of the earlier worktree and are not counted as final-source passes.

## Preserved failed attempts

The first complete command reported **4 passed, 1 failed, 0 skipped**. All five behavioral assertion records and all five terminal cleanup records were successful, but parallel/reload threw Windows `EPERM` deleting its owned scratch directory after terminal removal. That is a failed test, not a pass. Its run ID was `efb68605-64d3-45fc-8138-5623668ca602`; the original log/error and all other first-attempt artifacts remain private. The scratch was subsequently removed with bounded retries and separately recorded. The second complete command also reported **4 passed, 1 failed, 0 skipped**: scratch cleanup succeeded, but HC timed out sending Escape (`hc.exe ETIMEDOUT`) in interrupt run `79f3c765-e76d-4475-8e2d-20ba446cfade`. Its strict `interrupt_requested` assertion correctly failed; all owned terminals were removed. No assertion or production transport was weakened. Both failed commands and all their independent successes remain preserved. Final acceptance must use the complete confirmation command, not reinterpret these failures or mix journeys across attempts.

## Additional checks and limits

- Adopted only missing verification skill recipes and `test/integration/hc-tui-harness.test.ts` from `ec94015`; did not replace MAIN's improved observer, live harness or journey tests with older versions. The only additional test-harness edit adds Node's bounded `rmSync` retries (`maxRetries: 20`, `retryDelay: 100`) for transient Windows scratch-directory handles; no production or assertion changes.
- Filesystem-observation harness regression: 1 passed, 0 failed, 0 skipped; `npm run lint`: exit 0.
- Default opt-out: 5 skipped, 0 failed, no model journeys requested. Those skips are safety verification, not acceptance evidence.
- Reload shutdown is deliberately held open for 20 seconds by the test-only observer; this proves delivery across an instrumented real reload window, not its natural race frequency.
- Keep-open and interrupt use a non-auto-exit Pi role. Legacy auto-exit interrupt, manual/slash spawn/resume, alternate providers/harnesses, hostile-text live prompts, child reload and outside-HC operation are not additional covered journeys.
- Text terminal captures are not screenshots or proof of layout/colors. Local filesystem/OS trust applies. No exactly-once processing, cross-process storage CAS, automatic relaunch or recovered terminal adoption is promised.
- Full `npm test` was not run for this task and is not claimed green; existing Python/Claude and CRLF failures remain separately documented. Parent verification is required before changing original plan acceptance.
