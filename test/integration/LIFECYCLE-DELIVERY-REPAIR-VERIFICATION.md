# Interrupted resume and unsent delivery repair — 2026-11-17

## Implemented scope

- `live-continuation.ts`: a confirmed-running child with a stale `starting` turn observation can reach capability validation. Both `starting` and `active` still require a matching run/session-bound **interrupted-idle** capability; ordinary settled-idle cannot override them. Pane-idle, current token, child busy/pending-message, custody, reservation and durable-claim guards remain intact. Coarse lifecycle presentation was not rewritten.
- `delivery.ts` / `index.ts`: retain per-event persistence failure stage/error and expose it through recovery diagnostics. Explicit `/subagents-reconcile` can unpark at most 100 **before-send** failures per call, only with the original RuntimeStore instance, current writer/branch custody, unpaused manifest, pending owner and durable event, unchanged immutable envelope, and no suppression/in-flight dispatch. It does not start another child turn.
- `dispatching` (UNKNOWN), post-send and retry-reset persistence failures remain parked. No blind replay or exactly-once/Pi-persistence guarantee was introduced.
- Permanent regressions cover the cancellation-drain sampling interleaving and controls, actual native Pi abort/continuation, unsafe child states, immutable single handoff, custody/store/payload checks, bounded recovery, and the registered public reconciliation command.

**Important operating boundary:** storage/custody faults still deliberately stop automatic delivery. After fixing the fault, use `/subagents-recovery` to inspect it and `/subagents-reconcile` for eligible proven-unsent results. This repair adds safe same-runtime recovery; it does not promise that all transient filesystem faults heal automatically or that every live journey is green.

Pre-existing dirty integration runner/harness/skills/package/docs changes were preserved. No commits, global deployment, provider changes, copied credentials or global trust changes were made.

## Environment

Windows, Node `v24.21.0`, local Pi `1.5.2`, HC `0.1.21`, authenticated model `openai-codex/gpt-6.1-sol`. All live runs were serial and used fresh owned scratch sessions. Legacy herdr was unavailable; Linux and legacy live compatibility were not tested.

## Commands and results

| Command / scope | Outcome |
| --- | --- |
| `npm test` | **778/778 pass**, zero failed/cancelled/skipped |
| `npm run lint` and `git diff --check` | pass (Git emits line-ending warnings only) |
| `npm audit --omit=dev` | zero vulnerabilities in that scope |
| `node --test --test-concurrency=1 test/delivery.test.ts test/runtime-store.test.ts test/runtime-recovery.test.ts test/recovery-report.test.ts` | **50/50 pass**, zero skips |
| Worker's broader continuation/interrupt/close regression selection | **280/280 pass**, zero skips; includes three real offline native Pi continuation tests |
| Independent reviewer: delivery/store and pure continuation selections | **38/38** and **28/28 pass**, scoped lint/diff-check pass |
| `npm run test:integration:transport` | **3/3 pass**, zero skips, no model requests |
| `PI_TEST_MODEL=openai-codex/gpt-6.1-sol npm run test:integration` | **14 passed, 3 failed**, zero skipped; unfiltered full 17-test HC run |
| Additional real HC public recovery probe, injected pre-send store fault | **1/1 pass**, zero skips; actual public diagnostics, literal `/subagents-reconcile`, one immutable handoff, no extra child prompt/tool/model turn |
| Unchanged owned audit/draft/resume/close journey retest with forwarding-only observer | **1/1 pass**, zero skips |

An initial four-file concurrent targeted run was terminated at its 120-second command deadline and contained subprocess startup timeouts. Its original log remains retained; it is not a passing run. The later serial targeted run and full `npm test` passed without weakening assertions or timeouts.

## Full integration failures — not waived by later passes

1. **Owned audit/draft/resume/close:** timed out at the *first* parent result (`Closable delivery 1`). The child did perform the bash marker and finish; the durable manifest retained the correct immutable completion with status `pending` at revision 5, and the parent had no `subagent_result`. The failed run did not invoke reconciliation. Its exact original I/O/custody error was not captured, so no original errno is claimed. It is consistent with the conservative pre-send parking boundary, not evidence that explicit recovery was attempted and failed. The later unchanged journey passed both completions, audit, draft rejection, continuation and verified close, but does not erase this failure or prove the intermittent trigger repaired.
2. **Same-batch done + bash:** authenticated model settled without emitting the required sibling assistant batch. Unmet input precondition; the intended product assertion was not exercised.
3. **Same-batch ping + bash:** same unmet input precondition. No sequential substitution or filtered-green full-suite claim.

Guarded interrupt/live continuation, manual Escape/live continuation, parallel/reload, closed resume, keep-open follow-up, idle `/new`, parent-death recovery and all four public plugin journeys passed in the full run. The guard-specific sampling race is proven deterministically/native; a passing live journey alone does not prove HC selected that exact scheduling interleaving.

**The integration suite is not fully green.** There was no second unfiltered full run; the additional two passing journeys are separately bounded evidence.

## Additional public recovery proof

Command:

```bash
PI_TEST_HC_TUI=1 PI_TEST_MODEL=openai-codex/gpt-6.1-sol \
  node --test --test-concurrency=1 \
  .git/verification/lifecycle-delivery-repair/live-recovery.test.ts
```

The test injects one clearly labelled exception at the actual parent's RuntimeStore pre-send transition. Everything else is real Pi TUI, authenticated model, production extension, child bash and public user entry points. It verifies the child result is durably pending, public recovery diagnostics contain the failure stage/error, literal `/subagents-reconcile` hands off exactly the original payload, and a second command does not duplicate it. The child session file is unchanged across reconciliation. This is **controlled fault injection**, not proof of an actual Windows errno or recovery of the already-cleaned failed full-run session.

Unchanged journey retest:

```bash
PI_TEST_HC_TUI=1 PI_TEST_MODEL=openai-codex/gpt-6.1-sol \
  node --test --test-concurrency=1 \
  --test-name-pattern='owned audit draft rejection resume and close' \
  .git/verification/integration-diagnosis/live-repro.test.ts
```

That older wrapper adds only a forwarding/error-recording observer; it does not supply model replies or invoke orchestration tools. Successful additional observation can change timing; no failure-frequency inference is made.

## Evidence and review

Private logs, controlled probe source and machine-readable artifact inspection are under `.git/verification/lifecycle-delivery-repair/`; do not upload private sessions/prompts or credentials.

Key evidence directories under `.git/verification/`:

- Full-run timeout: `2026-11-17T11-00-45-510Z-owned-audit-draft-rejection-resume-and-close-80cd3971-9583-4903-a6f5-621b8375960c`.
- Full-run guarded interrupt pass: `2026-11-17T11-07-27-327Z-interrupt-live-continuation-e94e1638-ade0-4955-9bcc-1c22b3766ede`.
- Controlled public recovery pass: `2026-11-17T11-15-03-326Z-proven-unsent-public-reconciliation-99b651e5-e3fe-43ad-8c52-7be11fa7b49d`.
- Unchanged audit journey retest pass: `2026-11-17T11-15-59-573Z-owned-audit-draft-rejection-resume-and-close-99ec8927-1237-482d-a8c8-80b6bf1e90a3`.

All 18 retained assertion/cleanup artifact pairs from the transport selection, full run and two extra probes were inspected: cleanup reports `allMissing: true`, no unresolved custody. The 16 Pi journey environments match the final production source hashes for `index.ts`, `delivery.ts` and `live-continuation.ts`. Failed assertions remain false; successful cleanup does not convert them into passes.

Independent read-only review approved both production fixes with no actionable correctness/security findings. It also checked a non-permanent module-reload/reentrant reconciliation probe without duplicate sends. Review did not independently rerun the full/native/live suites. Follow-up risks are the documented conservative manual recovery boundary, missing original transient fault details, and authenticated same-batch model-input coverage—not a claimed general Pi/HC defect.
