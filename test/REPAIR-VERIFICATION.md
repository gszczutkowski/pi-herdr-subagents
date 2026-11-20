# Repair and context stabilization verification

Historical milestone. The subsequent audit repairs and current test/dependency
baseline are recorded in [AUDIT-REPAIR-VERIFICATION.md](AUDIT-REPAIR-VERIFICATION.md).

Date: 2026-11-15. Parent branch: `fix/subagent-repair-sequence`, base `d226f33`.
Changes are uncommitted; initial working-tree continuation changes were retained.
Current scope/status: [../BACKLOG.md](../BACKLOG.md).

## Implemented in this repository

- Repairs 6–9: manual/idle interruption reconciliation with child-issued idle
  tokens; current-task/active-branch completion summaries; additive named-role +
  explicit instructions across Pi modes; raw live-message validation before
  contract enrichment. Textless tasks cannot trigger legacy previous-task scans.
- Repair 10: import pending immutable result references before publication.
  Publication does not re-deliver results or accept worker proposals.
- Append-only model-context publication through public `before_agent_start` and
  structural `turn_end` boundaries; visible native context controls deduplication,
  including edited/omitted messages and receipt/call matching. No routine empty
  plan/checkpoint injection and no model turn solely to announce state.
- Compact plan mutation/checkpoint-save receipts. Full UI details and explicit
  reads remain available. Revision, authority, original-result identity and
  parent-only evidence/acceptance checks are unchanged.
- Provider/model-specific advisory UTF-8 JSON payload thresholds, numeric-only
  `/context-bytes`, and offline native Codex serialization tests.
- Test runner includes all new regressions. The stale fork fixture now supplies
  native branch access. The Windows recovery fixture supplies deterministic,
  verified empty writer enumeration for its synthetic no-writer scenario, while
  retaining real process identity probes and its custody/concurrent-resume checks.
  Production writer-audit behavior is unchanged and separately tested.

## Automated evidence

- Parent integrated `npm test`: **626/626 passed**, zero failures/skips/cancellations
  (174.6 seconds). Log: `.git/context-lifecycle-integrated-tests.log`.
  Final parent rerun after documentation integration: **626/626**, zero skips,
  147.2 seconds, `.git/repair-final-tests.log`; lint and `git diff --check` passed
  (Git CRLF-conversion notices only).
- Parent recovery + payload regression rerun: **12/12 passed**, zero skips.
  Log: `.git/recovery-payload-fixed.log`.
- Lifecycle worker: 181 focused tests passed. Independent lifecycle review:
  approved, 166 focused tests passed plus a native retain-none completion-summary
  check. These counts overlap and are **not** summed with the full suite.
- Context worker: 86 focused tests passed; 12 focused native context/serializer
  tests also passed against explicitly selected installed Pi/pi-ai 1.5.0.
- Receipt benchmark: a 50-task single mutation is **27,206 → 333 UTF-8 bytes**,
  98.8% smaller. This is a structural fixture result, not whole-session savings.
- Native Codex serializer + version-scoped real pure delta-selector fixtures:
  six unchanged transitions qualify in each empty/plan/checkpoint/recovery/combined
  variant. An identical ephemeral-tail negative control invalidates all six.
  Synthetic response items stand in for server replies; eligibility is not proof
  of historical transport choice, a live cache hit, billing or a discount.
- Independent context review approved, independently rerunning all 626 tests,
  47 focused tests and the 12-case Pi 1.5.0 matrix, plus lint/diff checks.
- Independent payload review found the new test absent from `npm test`; fixed.
  Added direct headless/child suppression coverage as well.

Worker evidence retained locally:
`E:/Repositories/pi-herdr-subagents-lifecycle-result.md` and
`E:/Repositories/pi-herdr-subagents-context-results/REPORT.md`.
No private historical session/body was copied into regression fixtures.

## Version contract

| Component | Evidence | Support claim |
|---|---|---|
| Locked local Pi/pi-ai 1.3.0 | Integrated suite | Existing `~1.3.0` peer/dev range retained |
| Installed Pi/pi-ai 1.5.0 | API inspection + 12 focused native tests | Focused compatibility only; not full release-matrix acceptance |
| Installed Kiro 0.12.3 | Inspected separate installed bundle | Not modified or upgraded |
| Kiro source at `dd93f2e884b60cecd85c7fb4a818fb6d64ba3dba` | Separate dirty source clone | Source fix, not deployment |

Production uses public Pi APIs. The pure native Codex selector extraction is a
version-restricted offline test fixture only, not a production private API.

## Explicit host/API blockers

**Automatic-compaction restoration:** Pi 1.3.0 and inspected 1.5.0 have no
public actionable post-compaction/pre-request append/draft boundary.
`session_compact` is notification-only; non-triggering messages defer during a
run and steering can create an otherwise unnecessary turn. A narrow read-only
post-compaction fallback therefore preserves exact current state until the next
persistent boundary. Tests expect a continuation reset here. Full optimization
stage 3 is **not** accepted as solved for this path.

**Final-wire byte enforcement:** the extension hook observes the provider JSON
payload at its own position, before later hooks and Codex full/delta/compression
selection. Its exceptions are swallowed; abort does not guarantee no send on a
cached socket. No hard transport gate, universal 1 MiB cap, blanket HTTP-400
compaction or protocol truncation is implemented or claimed. A host/provider
pre-send gate with final frame visibility is an external dependency.

## Separate Kiro source result

Source clone: `E:/Repositories/pi-provider-kiro`, main, package 0.12.3, base
`dd93f2e884b60cecd85c7fb4a818fb6d64ba3dba`. Normalization covers the entire
history/current boundary, preserves merged text/images/tool results/catalogs,
rejects irreparable conflicts, and honors/validates public `onPayload` replacement.
No global installation, publication or commit was performed.

Worker check/build/changed-file Biome passed. The final test-only reliability
follow-up passed stock **`npm test`: 828/828, zero skips**, 34 files, 180.84 seconds.
Five echo-diagnostic cases now use fake timers, assert four attempts and exact
1/2/4-second backoff boundaries, preserve all original assertions/30-second limits,
and supply normal modeled usage instead of unrelated repeated BPE fallback.
Production source is unchanged by this follow-up. Parent inspected the changes
and stock log and independently passed the five cases with a non-loopback blocker
(207 unrelated cases excluded by that focused filter, not by the stock run).
Independent source review approved with no actionable findings, independently
passing 826 tests (two deliberately excluded before the timing follow-up) and 34
focused checks. Earlier timeout/exclusion logs remain historical evidence only.
Full source report: `.agents/verification/normalization-20261115/REPORT.md` there.

Verification-boundary incident: the first synthetic runtime probe's preload
fetch shim was replaced by Pi's dispatcher and **may have sent synthetic-only
requests to Kiro with a dummy key**. No real credentials or user data were read
or sent. Corrected successful loopback probes used a hard non-loopback socket
blocker. Do not claim guaranteed zero external attempts for that worker session.
The corrected loopback proof used Pi 0.80.10, not a live authenticated Kiro service.

## Live verification not performed

Parent integration preflight: `HERDR_ENV` unset, `herdr` missing, `hc` available.
Per `.pi/skills/run-integration-tests/SKILL.md`, the integration suite is blocked
until Pi runs inside herdr; skipped tests would not be acceptance. No fresh real
terminal Escape round trip, authenticated provider test, Linux live behavior,
Codex→Kiro switch or token/billing A/B is claimed. Earlier `docs/history/HANDOFF.md` live
close/audit evidence applies to its recorded milestone only, not these changes.
