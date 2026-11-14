# Section 9 — automated verification evidence

These are automated regression claims, not live-terminal or restart acceptance.
No model or live herdr calls are needed. Each checked bullet has its own commit.

- [x] Unit state / canonical dedup / artifact and path contracts.
  New seam: `automated-state-boundary.test.ts` composes native task binding,
  durable outbox canonical event IDs, replay, and actual shared-path run artifacts;
  wrong-run payloads remain unread and success never accepts a task.
  Existing production regressions: `runtime-store.test.ts`, `plan-store.test.ts`,
  `contracts.test.ts` (15 tests passed with the new seam).
- [x] Plan restore / retry / dependencies / blockers / branches.
  New seam: `automated-plan-boundary.test.ts` carries a canonical ping through
  native disk restore, parent retry, late result import, fork/detach fencing and
  evidence-backed acceptance. Dependency waiting clears only on prerequisite
  acceptance; dependency display is not asserted to be a hard scheduling gate.
  Retry/restore create no run IDs. Existing production regressions:
  `plan-persistence.test.ts`, `plan-branches.test.ts`, `plan-preflight.test.ts`,
  `plan-runtime.test.ts` (15 tests passed with the new seam).
- [ ] Long / narrow / history rendering.
- [ ] Supported harnesses and explicit rejection.

Logs are local temporary artifacts, not committed fixtures. Full-suite green is
not claimed: known environment Python-hook / CRLF failures are outside this scope.
