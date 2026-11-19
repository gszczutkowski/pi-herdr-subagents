# M4 / M5 / M6 verification

Date: 2026-11-16. Base: merged `main` at `75a355c`.
Implementation branch: `fix/plan-read-detach-virtual-models`.
Scope: the three optional audit items in `AUDIT-REPAIR-HANDOFF.md`, not the
remaining context-optimization backlog or a global installation/deployment.

## Changes and regression evidence

| Item | Implementation | Evidence |
| --- | --- | --- |
| M5 | Only a validated abandoned detach exempts rollback detection. Missing/null/malformed source authority or other invalid detached fields preserve the valid selected snapshot as historical/read-only instead of hiding it behind a TypeError. No other branch's snapshot is restored. | `test/plan-branches.test.ts`: seven corrupt variants, native reopen/restore, denied writes, explicit recovery detach, existing valid main/alternative behavior. |
| M4 | Small overview/task reads retain their shape. Larger reads provide collection navigation, bounded valid JSON pages, flattened results/runs with attempt provenance, and plan/revision-pinned next cursors. Oversized single items remain recoverable through complete JSON fragments, without hidden full snapshots or whole-context publication receipts. | `test/plan-read.test.ts`: exhaustive 240 results, 120 evidence records, 60 decisions and other sections; 400-task overview; oversized Unicode decision; unchanged storage; invalid inputs; stale plan cursors; native Pi model-issued pagination. |
| M4 review fix | JSON cursors additionally pin the exact serialized document with SHA-256. Restore/reconcile/access/recovery diagnostics can change without a snapshot revision; an old document cursor then rejects and requires a fresh read. | Native `PlanPersistence.restore()` regression at an unchanged revision; old continuation rejected, restarted fragments reconstruct the exact new view. Reviewer independently reproduced the original 4096-character failure and verified the correction across 42 pages, plus schema/hash/error/access cases. |
| M6 | All proactive guard thresholds, retention/savings budgets and status diagnostics use the effective context usage window. Summaries use public routed `streamSimple(...).result()` with a positive output budget, including unknown virtual limits. The host caps that budget to its routed physical target. | `test/context-guard.test.ts`: idle/turn/status effective-limit cases; actual Pi scheduler and physical, virtual-unknown, virtual-larger and virtual-smaller selections. Virtual `direct` summary routing selects a separate physical target with a 512-token output cap; normal continuation and virtual selection are preserved. Existing abort/cooldown/length/non-shrinking-history guards remain tested. |

## Integrated validation

Final local dependencies: Pi coding-agent/pi-ai/pi-tui **1.5.2**, Node **24.21.0**,
Windows. No dependency or global configuration update was needed.

- Final post-review-fix `npm test`: **747/747 pass**, **64 suites**,
  **0 failures, cancellations, skips or todos**; **197016.5363 ms**.
- Focused `node --test test/plan-read.test.ts test/plan-branches.test.ts test/context-guard.test.ts`:
  **28/28 pass**, no skips.
- `npm run lint`: exit 0.
- `git diff --check`: exit 0.
- `test/plan-read.test.ts` is included in the explicit `npm test` command.
- No standalone typecheck was run; the project has no configured typecheck script.

Earlier full validation before the document-fingerprint review fix passed
746/746 in 272209.9965 ms. The final 747-test run supersedes it; focused and
reviewer counts overlap and must not be added to the full-suite total.
Temporary parent test logs: `/tmp/pi-herdr-m4-m5-m6-full-test.txt` and
`/tmp/pi-herdr-m4-m5-m6-final-test.txt` in the invoking Bash environment.

## Review and implementation ownership

Parent implemented and integrated all changes. An isolated M4 worker process
and its one explicit resume exited with code 1 before receiving task input; the
worktree remained clean and supplied no implementation or acceptance evidence.

Independent read-only review ran 47 focused compatibility/regression tests and
lint, and found one concrete P2 defect: immutable snapshot identity/revision did
not pin mutable PlanView diagnostics across JSON pages. Parent fixed that defect
and added the durable regression. Targeted independent follow-up approved the
fix with no remaining concrete findings, reran 28 tests and lint/diff checks,
and independently validated the original reproduction and negative cursor cases.
The reviewer did not run the final full suite; the 747-test evidence is parent
integration evidence. Review made no file edits.

## Limits

- Native SDK/scheduler tests use isolated scratch sessions and deterministic
  in-process providers, not authenticated remote-model sessions.
- No fresh HC TUI, legacy-herdr, Linux or Kiro end-to-end run is claimed.
  The seven historical HC journeys in `test/integration/HC-WORKFLOW-VERIFICATION.md`
  are separate evidence, not a new acceptance run of these changes.
- Effective usage limits describe the latest physical response, not a prediction
  of every future router choice. Native host overflow recovery still applies.
- JSON fragments must be followed verbatim through `next`, joined and parsed.
  Changes to snapshot identity/revision or serialized diagnostics require restart;
  this is not a cross-process transactional read or process-liveness proof.
- Provider payload warnings remain advisory. These repairs do not add a fail-closed
  final-wire byte gate, deploy the separate Kiro fix or prove billing savings.
- Committing/pushing this implementation does not imply global deployment or
  fresh authenticated live verification.
