# P1 independent review #1

**VERDICT: CHANGES REQUIRED** (P1 criterion `758d9721-b6bf-46a2-971d-d5245f5d1351`). Parent retains acceptance.

## Findings

1. **Medium — contradictory canonical metadata resolves as unsent and permits a replacement send.** [`dispatch-recovery.ts:54–64,349–372`](../../pi-extension/subagents/dispatch-recovery.ts#L54), [`runtime-store.ts:437–454`](../../pi-extension/subagents/runtime-store.ts#L437). The after-intent predicate requires a matching marker, a handed-off result/error, and a sole cursor, but ignores `details.dispatch` even when it explicitly records a possible transport send. Reproduction: commit a Pi intent, start recovery, then use `recordDispatchFailure` with the correct `beforeSendAfterIntent: resumeIntentBinding(run)`, event ID and result/error, plus valid `details.dispatch` fields with `source: "dispatch-failure-v1"`, `phase: "send-possible"`, `operation: "send-to-terminal"`. The store accepts and persists this contradictory envelope. With a clean mocked writer audit, `subagents_reconcile` reported `resolved / before-send`, released the reservation, and an explicit `subagent_resume` started a new run (one mocked transport call). No normal producer was observed generating this mixed shape; the defect is acceptance of contradictory persisted input, not automatic replay. **Fix:** use the same strict after-intent shape checks at canonical publication and read. If structured journal metadata is present, require the valid `before-send` / `verify-resume-images` variant; reject mixed send-possible claims (including already persisted ones). Add a regression that proves no ownership clearance or transport with such a persisted conflict.
2. **Low — a contradictory side journal is reported as blocked but its same-run artifact reservation is still cleared.** [`runtime-recovery.ts:65–69,145–156`](../../pi-extension/subagents/runtime-recovery.ts#L65), [`index.ts:1921–1935`](../../pi-extension/subagents/index.ts#L1921). `confirmedUnsent` checks just the outbox/run. The metadata layer correctly returns a per-run `EVIDENCE_CONFLICT` without a global store error when canonical evidence exists, but both supervisor checks can ignore that outcome. Reproduction: start a supervisor tracking a bare Pi intent, publish the exact after-intent outbox tombstone, then retain a same-run `send-possible` journal record (`send-to-terminal`, same parent/generation/path/time). `subagents_reconcile` returned `still-blocked / EVIDENCE_CONFLICT`, yet `sessionOwners` lost the old reservation. The explicit retry was still refused and the mocked transport count stayed zero while the conflicting record was present. **Fix:** carry a per-run, conflict-aware unsent disposition from metadata verification into startup and explicit supervisor reconciliation; skip supervision or clear an artifact reservation only when that disposition is clean. Keep the existing same-run/no-surface/no-pending-control checks and don't impose a global pause for a run-local conflict. Cover conflict retention and release after verified resolution.

## Independent checks

- Windows, Node `v24.21.0`. `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test test/dispatch-recovery.test.ts`: **29/29 passed**. The matching command with `test/dispatch-failure.test.ts`: **2/2 passed**.
- `npm run typecheck && npm run lint && git diff --check`: passed, with the existing LF/CRLF warning for `test/dispatch-failure.test.ts`.
- Two stdin probes using the existing fake-Pi/terminal fixture (no test files changed) reproduced the findings: canonical contradiction → resolved, reservation cleared, explicit retry `panes=1/sends=1`; side journal contradiction → still-blocked, reservation nevertheless cleared, explicit retry refused, `panes=0/sends=0`. Lower-level `RuntimeStore` and supervisor probes independently reproduced the underlying classifications.
- The six blob IDs below matched `p1-repair-verification.md` before the test run and after the probes. The worker's wider run was **21/22** due to a Windows identity-file rename `EPERM`; its isolated rerun passed. I did not independently repeat that wider run or claim full `npm test`, live Pi/herdr, or Linux verification.

| File | Git blob |
| --- | --- |
| `pi-extension/subagents/dispatch-recovery.ts` | `893ad3592a6ac081d28243a9da32ea87e30c8861` |
| `pi-extension/subagents/index.ts` | `1dca6a0096a7495998e69bbef4a1a7f2cd0fffa5` |
| `pi-extension/subagents/plan-runtime.ts` | `60b6f5077ba4102cb9a8699c4de1d98918f4ef0a` |
| `pi-extension/subagents/runtime-recovery.ts` | `f2bb807d40095767470c38977053f2097139b1a0` |
| `pi-extension/subagents/runtime-store.ts` | `4543477afa6db5f508ad45c754a25f78e976307d` |
| `test/dispatch-recovery.test.ts` | `c933e4d2a80991022082297eed098cbbdfb39816` |

## Coverage

Reviewed the six scoped files and related terminal callback ordering, plan import/authority, and ownership call sites, using the initial P1 description to separate the repair from the broader uncommitted backlog. The final image check is still synchronous and after committed intent but before `sendHerdrCommand`. Ordinary matching canonical/journal paths preserve original run binding and the sole cursor, don't replay or wake a model, and delayed import is idempotent. Journal parent/generation/retained-record and writable-plan guards remain in place; the existing valid-path tests cover reservation release, explicit new runs, an independent resume after storage repair, and no-send on bare intent. No attempted change to plan retry/rebind policy, P3, or public v2 was reviewed or recommended. Only this report was written; no source/test edits, commits, or pushes.

Correlation: `planId=c860a4c2-151b-416f-8eb2-84fb2d7ddd88`, `taskId=c9afb479-c9db-49b1-a6ac-df8c071a9aea`, `attemptId=635d2cf8-63eb-4c50-a390-13a023b3ffc3`, `runId=307a962a-f89e-4a75-b1ad-2be7da8a170d`.
