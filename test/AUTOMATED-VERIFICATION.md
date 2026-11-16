# Section 9 — automated verification evidence

These are automated regression claims, not live-terminal or restart acceptance.
No model or live herdr calls are needed. This document records evidence, not a
second checklist; status is tracked in `.pi/plans/2026-11-14-subagent-orchestration/plan.md`.

- Unit state / canonical dedup / artifact and path contracts.
  New seam: `automated-state-boundary.test.ts` composes native task binding,
  durable outbox canonical event IDs, replay, and actual shared-path run artifacts;
  wrong-run payloads remain unread and success never accepts a task.
  Existing production regressions: `runtime-store.test.ts`, `plan-store.test.ts`,
  `contracts.test.ts` (15 tests passed with the new seam).
- Plan restore / retry / dependencies / blockers / branches.
  New seam: `automated-plan-boundary.test.ts` carries a canonical ping through
  native disk restore, parent retry, late result import, fork/detach fencing and
  evidence-backed acceptance. Dependency waiting clears only on prerequisite
  acceptance; dependency display is not asserted to be a hard scheduling gate.
  Retry/restore create no run IDs. Existing production regressions:
  `plan-persistence.test.ts`, `plan-branches.test.ts`, `plan-preflight.test.ts`,
  `plan-runtime.test.ts` (15 tests passed with the new seam).
- Long / narrow / history rendering.
  `automated-render-boundary.test.ts` composes native task/history widgets and
  registered result cards at 1–160 columns, Unicode, 36 tasks, truncated task
  details, cyclic/orphan history, theme changes and historical branch clearing.
  Expanded structured proposals remain bounded and separate from the assistant
  response. Rendering neither persists data nor wakes the model. These string
  assertions are not screenshots or live visual acceptance.
- Supported harnesses and explicit rejection.
  New seam: `automated-harness-boundary.test.ts` exercises actual launch rejection
  with a text assignment contract before terminal/artifact/task side effects,
  then standalone Codex command construction and real durable artifact recovery
  into a review-only native task. Foreign recovery is explicitly unverified and
  never controls/relaunches a terminal; tracked continuation remains Pi-only.
  Existing matrix/command validation: `harness-capabilities.test.ts`,
  `harness-drivers.test.ts`, `contract-compatibility.test.ts`,
  `launch-profile.test.ts`, `live-continuation.test.ts`, `runtime-recovery.test.ts`
  (72 tests passed with the new seam). This is mocked transport/command and
  artifact validation, not a claim that foreign CLIs ran live.

Logs are local temporary artifacts, not committed fixtures. The initial evidence
recorded 19 Python-hook / CRLF baseline failures. Follow-up commits `635d284` and
`be4c163` fix interpreter selection, UTF-8/LF hook I/O, native transcript basename
handling, and checkout-independent workflow assertions. Parent verification after
those fixes: `npm test` **454 passed, 0 failed, 0 skipped**; lint and diff checks
passed. The portability review also passed. Earlier live-HC evidence remains an
immutable record of its tested source snapshot; no live Claude CLI run is claimed.
