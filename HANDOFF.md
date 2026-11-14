# Handoff: session audit and verified subagent close

## Current status

- Repository: `E:/Repositories/pi-herdr-subagents`, branch `main`.
- Implementation HEAD before this handoff: `e0101da`.
- Changes are committed locally; no push was performed.
- The original orchestration plan is complete (65/65). The remaining work below concerns the later `subagent_audit` / `subagent_close` follow-up, not unfinished original-plan features.
- **The final parent review of the latest hardening has NOT been performed.** Do not describe worker-reported results as independently accepted.

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

The initial review of `b0b6f03` / `204a9cb` required changes: the installed `dist/bundle/cli.js` was missed, unsaved editor drafts were not protected, and the CLOSE watcher could keep disposed SDK hosts alive. The parent also identified rejection reservations that could lock a healthy child and a race between normal watcher cleanup and close-result validation. The worker reports these are now fixed; review the final implementation, not only the original two commits.

## Remaining work, in order

1. **Review the complete final hardening.** Check installed package-declared CLI bins and aliases; conservative audit uncertainty; self/ancestor and PID-birth protection; live draft safety; watcher unref/lifecycle cleanup; release of only matching definitively rejected requests; mutual exclusion with continuation; and natural watcher removal racing verified exit. Branch/lease/task-binding fences must remain intact, and replacement owners must never be released.
2. **Independently verify the final evidence and source hashes.** Read `test/integration/HC-CLOSE-VERIFICATION.md`, the final journey's `assertions.json` / `cleanup.json`, and `.git/verification/close-hardening/independent-check.json`. Confirm the hashes against the current tree. Private evidence contains paths/session output; do not upload it.
3. **Rerun automated checks:** `npm test`, `npm run lint`, and `git diff --check`. The worker reports **477/477 tests passed**, but the parent has not rerun this final state. The earlier Python/CRLF failures were already fixed; they are not an accepted ongoing exception.
4. If review or evidence requires another live run, use only newly owned background HC terminals and the opt-in command below. Never interact with unrelated user terminals or repeat the legacy cleanup.
5. Fix any findings in separate corrective commits, then give the user a concise final report. If everything is sound, no further feature expansion is required.

## Reported live proof (pending parent acceptance)

Report: `test/integration/HC-CLOSE-VERIFICATION.md`.

The worker reports one authenticated HC Pi TUI journey passed: sole-owner audit, unsent draft rejection without shutdown, continuation after rejection, successful verified close during real watcher cleanup, identical receipt on recheck, no extra child model turn, and cleanup of all 18 owned test terminals across retained attempts.

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
