# Current repair backlog

This is the current scope/status entry point. `docs/history/HANDOFF.md` records an earlier,
completed close/audit milestone; its completion is not completion of subsequent
repair or context-optimization plans.

## Current v1 repair: P1 and P3 accepted (Windows, offline)

- Both [review #5](docs/plans/backlog-p1-independent-review-5.md) cases now have permanent filesystem-fault tests. A manifest read `EIO` during marked plan proof and a rename `ENOSPC` during evidence pinning stop recovered supervision and parent delivery. Ordinary completions remain pending rather than being lost or sent while paused. A readable disagreement remains scoped to its run.
- Explicit reconciliation keeps the writer paused through supervisor restoration. If a second storage fault occurs during that wait, an ordinary turn or `/reload` cannot resume imports, delivery or dispatch. A clean explicit retry restores them without replaying the original command.
- An in-flight bound launch that fails before send still records its durable failure. The immediate failure handler and outbox importer now apply the same writer check: neither changes the plan while paused. Two regressions verify zero sends and exactly one failure imported after repair.
- P3: simulated parent processes in `test/runtime-recovery.test.ts` no longer inherit delegated authority markers. In `test/plan-queue.test.ts`, ready-order assertions use checkout roots obtained from real Git worktrees without racing the projection deadline. A separate injected timeout still verifies that an inconclusive check does not mean “no ready task.” Both suites passed with delegated markers set (24/24), independently repeated. P3 accepted.

**Verification:** final `npm test` **939/939** (zero skipped); `npm run typecheck`, `npm run lint` and `git diff --check` passed. Independent review passed the scoped P1 fixes and repeated both dispatch suites (66/66) on the same source and test versions. Earlier full passes (936 and 937 tests) preceded the double-fault and in-flight fixes respectively and were not treated as acceptance. Public ready-order v2 remains disabled. Linux and authenticated live Pi/herdr were not tested in this iteration.

## Previous P1 iteration: blocked after independent review #5

The new backlog iteration completed three repair rounds and five review invocations
(invocation #3 ended with a provider error, without a verdict). P1 is **not accepted**.
The nonempty failure-string guard, whole-cursor marker quarantine, run-local journal
conflicts, disputed-session scoping and journal-read fault latch passed targeted checks.
Independent [review #5](docs/plans/backlog-p1-independent-review-5.md) still reproduced:

- A manifest `EIO` in marked plan-proof custody validation is silently deferred without
  latching the writer pause; incidental import and a fresh explicit launch remain possible.
- Dispatch-evidence pin `ENOSPC` blocks launch initially but leaves delivery enabled;
  same-writer reload can clear that fence without clean explicit reconciliation.

**Work stopped at the three-repair-round limit in `AGENTS.md`.** No fourth repair round
or later backlog point was started. The latest permanent targeted suites passed
**140/140**, independently repeated; these passes do not waive the two diagnostic
reproductions. Parent repeated the four new one-shot journal regressions **4/4** and
verified the changed source/test hashes. Typecheck, lint and whitespace checks pass.
Full `npm test`, authenticated live Pi/herdr and Linux acceptance remain outstanding.
Public ready-order v2 stays disabled. No commits, pushes or deployment were performed.
Implementation evidence: [repair round 3](docs/plans/backlog-p1-repair-round-3.md).
The following section preserves the earlier iteration's outcome, not current acceptance.

## Earlier P1 repair iteration: blocked after independent review #4

Three repair rounds fixed the earlier canonical-conflict, supervisor, notification
and plan-quarantine findings. P1 is **not accepted**: a canonical after-intent
failure with `details.error: ""` is still accepted as unsent proof but imported as
an ordinary result, moving its bound task to review without execution. Require a
nonempty failure string in the shared publication/read validator and permanent
publication/restart regressions before acceptance. See
[review #4](docs/plans/p1-independent-review-4.md) and
[worker verification](docs/plans/p1-repair-verification.md).

The final targeted suites passed **98/98**; the parent repeated dispatch coverage
**44/44**. These passes do not waive the independently reproduced defect. Work
stopped at the repository's three-repair-round limit; P3 and the later backlog
items have not been started in this iteration. Full `npm test`, live Pi/herdr and
Linux acceptance remain outstanding. Public ready-order v2 stays disabled; no
commits, pushes or global deployment were performed.

## Current working-tree review: changes required

See the [review and ordered checklist](docs/plans/working-tree-review-and-next-steps-pl.md)
for the unpublished changes on top of `f74d605`. Fix the confirmed closed-resume
recovery regression first. Coordinator-owned child lifecycle still needs separate
acceptance; public ready-order v2 remains disabled until its execution gates and
whole-tree settlement are ready. The reports below record earlier milestones.

## Interrupted resume and explicit unsent-result recovery repaired (2026-11-17)

- Stale `starting` parent turn labels no longer prevent validation of a
  confirmed-running child's fresh run/session-bound `interrupted-idle` proof.
  Ordinary settled-idle, busy/foreign/stale children and custody failures still
  fail closed. Permanent sampling-interleaving and native Pi regressions added.
- Per-event delivery failure stages/errors are exposed in recovery diagnostics.
  `/subagents-reconcile` now recovers at most 100 proven-unsent pre-send parked
  events under exact store/writer/branch/payload validation. UNKNOWN dispatching
  and post-send failures are never blindly replayed. Storage faults still require
  repair and explicit reconciliation; automatic healing is not promised.
- Integrated `npm test`: **778/778 pass**, zero skips; lint and diff-check pass.
  Independent review approved both fixes. Live HC transport: **3/3 pass**.
- The unfiltered authenticated full HC integration run was **14/17**, zero skips:
  two same-batch model-input preconditions were unmet, and the owned audit journey
  timed out on a retained pending first result without invoking reconciliation.
  A later unchanged audit journey passed; a separate controlled real-HC fault
  probe proved public reconciliation delivers the immutable result once with no
  extra child turn. These passes do **not** erase the original full-run failure.
- **Full integration is not green.** Exact transient fault details and live
  authenticated same-batch coverage remain follow-up work; legacy/Linux are not
  verified. No global deployment or commits were made in this repair session.
- Scope, commands, original failures, review and cleanup evidence:
  [test/integration/LIFECYCLE-DELIVERY-REPAIR-VERIFICATION.md](test/integration/LIFECYCLE-DELIVERY-REPAIR-VERIFICATION.md).

## M5 / M4 / M6 implemented (2026-11-16)

- **M5:** malformed abandoned detach records preserve the valid selected plan;
  writes remain historical/read-only. Only validated independent detaches exempt
  rollback detection.
- **M4:** `plan_read` supports bounded collection pagination, revision-pinned
  cursors and lossless JSON fragments for oversized records. JSON document hashes
  also fence diagnostic changes at an unchanged revision. Small reads remain
  compatible; partial pages never certify whole-plan context publication.
- **M6:** proactive guard budgets use effective Pi context usage. Summary calls
  route registered virtual models through public `streamSimple(...).result()`
  with positive output budgets capped by the host's physical target.
- Integrated local Pi **1.5.2** `npm test`: **747/747 pass**, zero failures,
  skips or cancellations. These are offline deterministic/native SDK tests,
  not a fresh authenticated HC/Kiro/legacy-herdr run or deployment.
- Evidence and remaining limits: [test/M4-M5-M6-VERIFICATION.md](test/M4-M5-M6-VERIFICATION.md).
  Implementation branch: `fix/plan-read-detach-virtual-models`.

## Core HC TUI workflow verified and interrupt repaired (2026-11-16)

- Final precommit local Pi **1.5.2** automated suite: **734/734 pass**, zero failures,
  skips or cancellations; lint passes, `npm audit` reports **0 vulnerabilities**.
- One final serial authenticated HC TUI command: **7/7 pass**, zero skips:
  parallel/reload, closed resume, keep-open, guarded interrupt/resume, idle `/new`
  detachment, parent-death recovery, and owned audit/draft rejection/verified close.
- Repeated HC named-key Escape timeouts are bypassed safely by the tool's new
  child-issued, identity-bound `interrupt-v1` capability using public `ctx.abort()`.
  No Ctrl+C, process signal or terminal fallback. Request acknowledgement remains
  separate from correlated aborted settlement.
- Fresh precommit live testing also exposed an interrupted-resume race: trailing
  `turn_start` activity could mask the parent's interrupt marker. Final settlement
  now clears stale active activity, and only a fresh child `interrupted-idle`
  capability plus idle-pane validation can override an active parent observation.
  The corrected complete seven-journey rerun passed; the initial 6/7 failure is retained.
- Harness now pins the local CLI, isolates exact project-source approvals and
  resolves existing credentials without copying them or changing global settings.
- Final assertions, source hashes and all **17** final-run owned terminal entries
  were independently checked; every terminal was missing, with no unresolved custody.
- **Limits remain:** manual HC Escape transport failed; authenticated same-batch
  completion/ping stress attempts did not produce the required model tool batch.
  Native offline batch regressions pass, but these extra live paths are not accepted.
  No legacy-herdr, Linux, Kiro, final-wire/billing or global deployment claim.
- Report: [test/integration/HC-WORKFLOW-VERIFICATION.md](test/integration/HC-WORKFLOW-VERIFICATION.md).
  Implementation/tests are committed locally as `8f8d53c`; accompanying docs and
  verification skills are committed separately. This milestone was subsequently
  pushed in PR #4 and merged as `75a355c`; global Pi remains unchanged.

## Audit repairs integrated (2026-11-16)

- R1–R6 and M9–M11 from `docs/history/AUDIT-REPAIR-HANDOFF.md` are implemented, including
  settled/session-bound completion, observable I/O pause/retry, literal shell/CLI
  delivery, explicit project-source approvals and bounded historical processing.
- Final local Pi **1.5.2** suite: **712/712 pass**, zero skips/cancellations;
  lint passes, `npm audit` reports **0 vulnerabilities**. Earlier Pi 1.3.0
  baseline passed 707/707 before the final five review regressions.
- Global Pi was not updated. Project approvals require explicit configuration;
  no checkout was granted executable user-level trust by this repair session.
- Scope, evidence, review fixes and verification limits:
  [test/AUDIT-REPAIR-VERIFICATION.md](test/AUDIT-REPAIR-VERIFICATION.md).
- At this audit milestone live herdr/provider e2e was unverified. The subsequent
  bounded HC workflow proof above supersedes that blanket limitation only for its
  seven named journeys. M4/M5/M6 are implemented in the newer milestone above;
  unrelated optional audit/optimization items remain backlog.

## Earlier implementation/review milestone

- Lifecycle repairs 6–10 in `docs/history/SUBAGENT-REPAIR-PLAN.md`: interrupted continuation,
  current-task/active-branch summaries, role delivery, live-message validation,
  and pending-result import ordering.
- Compact plan/checkpoint receipts and stable ordinary context publication;
  50-task mutation fixture is 98.8% smaller. This is not whole-session savings.
- Provider/model-specific UTF-8 JSON payload warnings and offline native serializer
  coverage, without pretending to provide a hard transport gate.
- At that earlier milestone, all regressions were wired into `npm test`; **626/626 passed, zero skips** (historical count, superseded above).
  Independent lifecycle and context reviews approved the integrated changes.
- Current status/docs point here instead of treating the old close/audit handoff
  as completion of later work. Changes were uncommitted at that earlier milestone;
  the subsequent local commits are recorded above.

## Separate source change implemented and reviewed

Kiro normalization and public `onPayload` handling were implemented in
`E:/Repositories/pi-provider-kiro` (base `dd93f2e`, version 0.12.3). Independent source review approved; stock tests pass **828/828 with zero skips**
after test-only clock/usage isolation, with original assertions and timeouts retained.
The source fix is **not globally deployed**. Its report records an initial
synthetic-only outbound-test interception incident; no real credentials/user data
were involved.

## Host/API dependencies (not silently waived)

- Pi 1.3.0 and inspected 1.5.0 do not expose a fail-closed extension payload
  gate or a callback after final Codex full/delta WebSocket-frame selection.
  `before_provider_request` exceptions are reported and swallowed. Calling
  `ctx.abort()` there does not guarantee zero transmission on a cached socket.
  Advisory payload-size warnings are not a hard transport limit.
- Automatic compaction may occur after the last actionable publication boundary.
  Exact current state must remain visible on the first post-compaction request;
  full delta stability for that restoration requires a safe host publication API
  unless a native durable boundary is available. Do not drop state for caching.
- A provider source fix is not a deployed global-provider update. The installed
  Kiro 0.12.3 bundle must not be patched in place.

## Live verification scope

Legacy `herdr`/`HERDR_ENV` remains unavailable. This does not block the separate
HC TUI workflow when `HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET` and `hc` are present;
follow `.pi/skills/verify-pi-herdr-subagents/SKILL.md`. The full legacy integration
suite was not run or claimed passing. Only fresh owned scratch sessions were used;
no historical private session was replayed.

## Detailed scope and evidence

- `SUBAGENT-REPAIR-PLAN.md`: correctness defects and acceptance criteria.
- `docs/history/SUBAGENT-CONTEXT-OPTIMIZATION-PLAN.md`: staged optimization and external scope.
- `test/API-TOKEN-AUDIT.md`: incident findings, not implementation acceptance.
- `test/REPAIR-VERIFICATION.md`: final checks and remaining limits (written after review).

The suspected 1 MiB backend boundary is incident evidence, not a universal
provider constant; arbitrary HTTP 400 errors must not trigger blind compaction.
