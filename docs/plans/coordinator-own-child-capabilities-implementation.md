# Coordinator-owned child lifecycle — implementation report

## Proposed result

- `pi-extension/subagents/index.ts`: audit and resume in delegated Pi require the calling coordinator's current branch custody and a durable run with the exact canonical target and immediate-parent lineage. The launch-session marker prevents using another session's manifest after a session switch. The tool checks this before audit enumeration, launch-profile reads, or transcript reads and rechecks custody across resume's asynchronous boundaries. Profile lineage must match the authorized run, and a redirected profile sidecar is rejected. Root audit and existing saved-profile resume remain unchanged in scope.
- Closed-child authorization survives retirement of the live map entry because the manifest retains the original dispatch record. Recovered ownership remains artifact-only: the existing guarded release still requires verified original-process death and a clear writer audit. The authorization adds no terminal authority or retry path and leaves close, interrupt, and the live continuation transport intact.
- `.pi/agents/coordinator.md` (already untracked before this change) and `agents/feature-coordinator.md`: explicitly allow audit, resume, and interrupt alongside spawn and close. Repair the original worker locally, recheck and review the same code version, and escalate only actionable blockers or scope decisions; otherwise report the concise final evidence. Saved allowlists remain immutable on resume, so an already-launched coordinator missing the tools needs a fresh launch.
- `test/ownership-execute.test.ts` covers role allowlists, root arbitrary audit, sibling/ancestor/self/foreign and case/path alias denials before profile/transcript reads or OS enumeration, lost branch custody, uncertain process audit, closed repair after store restoration, live keep-open continuation and receipt fencing, and immediate-parent handoff without publishing a coordinator completion to root. `docs/REFERENCE.md` describes usage and limits.

## Verification (Windows, current working tree)

Root role fixtures were run with inherited delegated-session markers removed. The fixtures explicitly set their simulated nested roles when needed.

```sh
npm run typecheck
npm run lint
git diff --check
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_MODE -u PI_DENY_TOOLS node --test --test-reporter=spec test/ownership-execute.test.ts test/session-audit.test.ts test/resume-safety.test.ts test/close-control.test.ts test/interrupt-control.test.ts test/caller-ping-loop.test.ts test/settled-completion.test.ts test/runtime-recovery.test.ts test/launch-profile.test.ts
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_MODE -u PI_DENY_TOOLS npm test
```

Typecheck, lint, and diff check passed. Focused: 112 passed. Full: 839 passed, zero failed/skipped. The pre-edit broad run hit the command timeout and did not establish a clean baseline. The first post-edit full run inherited the coordinator launch markers: three root-only fixtures exercised delegated authorization and failed; all three passed when run in the intended root environment.

## Repair round 1 — proposed for independent re-review

- A durable record and its launch sidecar alone no longer authorize the file at the recorded path. After the current branch and direct-child manifest checks, audit and resume read at most 64 KiB to validate the first physical Pi JSONL header against the recorded child ID. Missing, unreadable, wrong-ID, malformed and overlong headers fail closed before profile or full transcript reads and writer enumeration. Resume repeats this check after asynchronous preparation/inspection and before both closed and live dispatch. Unsent cleanup releases the exact reserved key if the path changed.
- Canonical aliases to an owned child remain valid; retargeting an alias to a foreign path fails even if that transcript carries the same header ID. The role test always verifies the distributed `agents/feature-coordinator.md` and checks the project-local coordinator only if present. Root audit, saved-profile resume and custody/process guards remain in place.
- The ownership tests cover both legacy `.exit` and settled `.exit.events/*.json` destinations. A native Pi SDK repair scenario installs a real run-scoped completion observer on the coordinator's root-facing channel. The coordinator wakes on the initial and repaired worker results, remains silent during repair, and sends only its explicit final proposal to the observer. The existing explicit ping scenario still covers actionable escalation.
- RED (before the header guard): all five new header cases failed with missing rejection: replaced retired session, malformed first line, overlong first line, replacement during awaited pane inspection, replacement during terminal script preparation. GREEN (after the guard): all five passed. Reproduction command:

```sh
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_MODE -u PI_DENY_TOOLS node --test --test-reporter=spec --test-name-pattern='invalid child header' test/ownership-execute.test.ts
```

Re-ran the focused and full commands above on the repair tree (Windows): **118/118 focused**, **845/845 full**, zero failures/skips; `npm run typecheck`, `npm run lint`, and `git diff --check` passed. No live herdr run; terminal/process boundaries are simulated in the native repair test. This is an extension-tool authorization check, not a same-user filesystem or shell sandbox or an OS lock. Pre-existing dirty files were preserved. The earlier plan-bound worker resume remained rejected by the original task-binding/current retry conflict; this round used the explicitly authorized replacement worker and does not change plan-binding semantics.

## Parent verification and review blocker

The parent independently reran the repaired tree: **845 passed, zero failed/skipped**, plus typecheck, lint and `git diff --check` passed. Initial independent review required the R1 changes above. The resumed independent reviewer returned no R1 verdict because the provider rejected the request; this is **not a passing re-review**. Acceptance remains blocked pending independent human review. No live herdr verification, external configuration rollout, commit or push was performed. Already-running coordinators retain their saved tool allowlist and require a fresh launch with an updated profile. The plan-bound retry/resume conflict remains a separate unresolved limitation.

## Independent review focus

Check authority before target reads, branch/owner changes during awaits, and that recovery never confers live controls. Delivery uses the existing per-parent watcher and outbox; root history visibility is not a wakeup.
