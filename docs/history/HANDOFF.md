# Handoff: session audit and verified subagent close

> Historical milestone, not the current backlog. Subsequent lifecycle/context
> repairs are tracked in [BACKLOG.md](../../BACKLOG.md) and
> [test/REPAIR-VERIFICATION.md](../../test/REPAIR-VERIFICATION.md). Their current
> integrated automated suite passes 626/626; host/API and live-verification
> dependencies remain explicit. The legacy cleanup below must not be repeated.

## Current status

- Repository: `E:/Repositories/pi-herdr-subagents`, branch `main`.
- Implementation HEAD before this handoff: `e0101da`.
- Original implementation and handoff were committed locally; no push was performed.
- The original orchestration plan is complete (65/65).
- **Final parent review completed on 2026-11-15:** no actionable safety findings. All six recorded production source hashes match the retained strict HC journey; its assertions and cleanup were independently read. All 18 retained owned test terminals were independently confirmed missing, and the original child PID is absent.
- The parent's first full test run exposed two Windows load-sensitive RPC startup/process-probe failures (475/477). Limiting test-file concurrency to four resolved contention without changing production code, safety assertions or timeouts. Both worker and parent reruns passed **477/477, zero skips**; parent lint and diff checks passed.
- Private final review: `.git/verification/parent-close-final-review.json`; parent test log: `.git/verification/parent-final-tests-concurrency4.log`. No fresh live HC journey was required because production source hashes are unchanged.

## Already completed: the user's legacy session

The user authorized investigating and closing session `01a1d76e-b48b-70a6-b042-85eb79e91456` in `E:/Repositories/escape`.

Its physical session file was:
`C:/Users/grzeg/.pi/agent/sessions/--E--Repositories-escape--/2026-11-14T00-21-56-705Z_fbbe9058-96e5cf95-9bea41ed-c074.jsonl`.

Old resume operations had left three concurrent Pi processes writing this file, following explicit `subagent_done({ close: false })` calls. The parent independently closed all three with graceful Ctrl+D after checking PID/birth, exact session argument, saved terminal identity, and MSYS console association. Empty verified terminals were removed afterward. No force termination was used. Subsequent OS checks found all three original processes absent and no remaining Pi/Node process selecting that session.

Private proof: `.git/verification/escape-session-close-01a1d76e/result-1794692459185.json`.

**Do not repeat cleanup using old PID numbers: they may be reused. No further operations on the escape repository or its processes are needed for this handoff.**

## Implemented follow-up

- `b0b6f03`: read-only `subagent_audit`, canonical session writer detection, and pre-resume guards.
- `204a9cb`: `subagent_close` for an owned, tracked, idle Pi child; run-bound shutdown requests and OS PID/birth exit verification.
- Ten corrective commits from `9b26b49` through `e0101da` address review findings and real HC TUI failures.

Key production files:

- `pi-extension/subagents/session-audit.ts`
- `pi-extension/subagents/close-control.ts`
- `pi-extension/subagents/process-identity.ts`
- `pi-extension/subagents/index.ts`
- `pi-extension/subagents/recovery-identity.ts`
- `pi-extension/subagents/live-continuation.ts`

The initial review of `b0b6f03` / `204a9cb` required changes: the installed `dist/bundle/cli.js` was missed, unsaved editor drafts were not protected, and the CLOSE watcher could keep disposed SDK hosts alive. The parent also identified rejection reservations that could lock a healthy child and a race between normal watcher cleanup and close-result validation. The final implementation, not only the original two commits, has now been reviewed; no actionable findings remain.

## Final verification checklist (completed)

1. **Completed: review the complete final hardening.** Check installed package-declared CLI bins and aliases; conservative audit uncertainty; self/ancestor and PID-birth protection; live draft safety; watcher unref/lifecycle cleanup; release of only matching definitively rejected requests; mutual exclusion with continuation; and natural watcher removal racing verified exit. Branch/lease/task-binding fences must remain intact, and replacement owners must never be released.
2. **Completed: independently verify the final evidence and source hashes.** Read `test/integration/HC-CLOSE-VERIFICATION.md`, the final journey's `assertions.json` / `cleanup.json`, and `.git/verification/close-hardening/independent-check.json`. Confirm the hashes against the current tree. Private evidence contains paths/session output; do not upload it.
3. **Completed: rerun automated checks:** `npm test` (**477/477**, zero skips), `npm run lint`, and `git diff --check`. Test concurrency is capped at four to avoid Windows OS-probe/startup contention. The initial failing run remains retained; no ongoing exception is accepted.
4. No additional live run was required. Future live checks must use only newly owned background HC terminals and the opt-in command below. Never interact with unrelated user terminals or repeat the legacy cleanup.
5. No production safety correction or feature expansion is required. The test-runner reliability change and generic long-session guidance are follow-up changes.

## Retained live proof (independently accepted within stated limits)

Report: `test/integration/HC-CLOSE-VERIFICATION.md`.

The independently inspected retained evidence records one authenticated HC Pi TUI journey passing: sole-owner audit, unsent draft rejection without shutdown, continuation after rejection, successful verified close during real watcher cleanup, identical receipt on recheck, no extra child model turn, and cleanup of all 18 owned test terminals across retained attempts.

```bash
PI_TEST_HC_TUI=1 node --test --test-reporter=tap --test-concurrency=1 \
  --test-name-pattern='owned audit draft rejection resume and close' \
  test/integration/hc-tui.test.ts
```

Read `.pi/skills/verify-pi-herdr-subagents/SKILL.md` and the linked HC recipes before live testing. Keep existing credentials in place; do not copy authentication files or change global settings.

## Intentional limits

- CLOSE is graceful and targets one tracked, owned Pi run, not every writer of a session. Remaining or uncertain owners must be reported honestly.
- No automatic legacy cleanup, force-close API, terminal typing for CLOSE, or recovered unverified-pane control.
- An acknowledgement or completion artifact is not proof of process exit.
- Audit is point-in-time and covers explicit CLI session selection, not all manual in-process session switches or a global cross-process lock.
- Tracked `close: false` collaboration remains intentional; do not replace it with an idle timeout or silently force auto-exit.
- Linux and other platform/provider live behavior was not proven by the reported HC/Windows run.
- Reload/restart Pi after active old-version agents finish to expose the new tool registrations; do not assume this conversation's already-loaded tools have updated.
