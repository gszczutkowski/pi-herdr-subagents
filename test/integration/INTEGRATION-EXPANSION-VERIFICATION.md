# Integration expansion verification — 2026-11-16

## Environment and scope

Working tree based on `2ec70a23955657b6d63637d9402d571064fb0e98`, Node `v24.21.0`, Pi `1.5.2`, herdr-core `0.1.21`, real authenticated model `openai-codex/gpt-6.1-sol`. No production code or global settings changed. Legacy `herdr` CLI/environment were absent: **legacy live compatibility was not verified**.

The backend-aware runner now fails missing prerequisites instead of entering legacy workspace tests through generic HC availability. All new model journeys use the actual Pi TUI and public plugin tools/commands, not RPC substitutes or fabricated model responses.

## Commands and outcomes

| Command | Result |
| --- | --- |
| `npm test` (final full retry) | **756 passed**, zero failures/skips; private log `.git/verification/integration-expansion/unit-final.log` |
| `npm run lint` (after warning cleanup) | clean, exit 0 |
| `node --test test/integration/runner.test.ts test/integration/hc-tui-harness.test.ts` | **13 passed**, zero failures/skips |
| `npm run test:integration:transport` | **3 passed**, zero failures/skips; real terminals, no model requests |
| `PI_TEST_MODEL=openai-codex/gpt-6.1-sol npm run test:integration:plugin` (final) | **4 passed**, zero failures/skips; log `plugin-final.log` in the private directory above |
| `PI_TEST_MODEL=openai-codex/gpt-6.1-sol npm run test:integration` (unfiltered full HC run) | **12 passed, 5 failed**, zero skips; log `full-hc.log` |

The full HC run preceded the final slash-driver correction. Its failing discovery/slash journey was subsequently fixed in the harness and passed in the final four-journey run. **The entire 17-test suite was not rerun after that correction; there is no claim of a fully green integration suite.** Final error-preservation/lint-only edits were followed by targeted deterministic checks.

An initial unit run had one Windows child startup exit `3221225794` (753/754 passed). The isolated affected `runtime-recovery.test.ts` retry passed 8/8, and the later full unit retry passed 756/756. Original failure logs remain private; they were not overwritten by the final results.

## New public journey evidence

All four final directories are under `.git/verification/`:

- `2026-11-16T22-14-11-235Z-project-discovery-and-literal-named-slash-launch-b6186bed-2e0a-4664-a5b6-439c14f18c6c`
- `2026-11-16T22-14-56-367Z-explicit-fork-inherits-context-and-saves-unique-parent-linkage-0c67843d-d274-48b6-8b60-75caae29d675`
- `2026-11-16T22-15-29-314Z-invalid-named-tool-agent-rejects-before-child-work-and-parent-recovers-572bc40d-4688-429b-a6fa-51939006f2a1`
- `2026-11-16T22-16-18-686Z-durable-plan-and-checkpoint-survive-literal-reload-with-revision-guards-4e45464c-3f22-4c57-9577-e63aa3f078c8`

Each was inspected: `assertions.json.passed === true`, `cleanup.json.allMissing === true`, and no unresolved ownership. The long-payload transport run in the full suite has the same successful assertions/cleanup in `65717686-305f-4526-acff-0086e5c28a55-hc-transport`. All fourteen Pi journeys from the unfiltered run, including failed ones, recorded verified terminal cleanup. `integration-expansion/artifact-summary.json` retains the bounded artifact inspection results. Evidence includes private local paths/model output and must not be uploaded without approval.

## Four unresolved advanced outcomes

Follow-up: [advanced failure diagnosis, 2026-11-17](ADVANCED-FAILURES-DIAGNOSIS.md) identifies the failed stages, deterministic lifecycle/recovery reproductions, and a later successful two-journey live retest. It does not replace this original run's outcomes or claim a production fix.

These older scenarios remain enabled; none was weakened, skipped or counted through an alternative path:

1. **Owned audit/draft rejection/resume/close**: the second completion timed out (`Closable delivery 2`). Audit and live-draft rejection were observed; continuation returned `continued`, but the journey did not establish the second result or final graceful close. Evidence starts `2026-11-16T22-01-20-337Z-owned-audit-…`.
2. **Guarded interrupt → live resume**: interrupt acknowledgement and aborted settlement were observed, but the real resume tool rejected the child as not tracked interrupted/settled idle. Evidence starts `2026-11-16T22-08-11-950Z-interrupt-live-continuation-…`.
3. **Same-batch staged done + bash**: the model did not issue the required sibling tool calls in one assistant batch; the test failed its input precondition. This is not evidence for or against correct same-batch plugin settlement. Evidence starts `2026-11-16T22-10-13-722Z-staged-done-…`.
4. **Same-batch staged ping + bash**: same unmet model-input precondition; no sequential substitute was accepted. Evidence starts `2026-11-16T22-10-34-382Z-staged-ping-…`.

Passing older scenarios in this run included parallel children across an instrumented reload window, closed-session resume, keep-open follow-up, literal manual Escape and same-process continuation, `/new` after guarded abort, and OS parent death/recovery. These are bounded observations, not a general reliability/exactly-once guarantee.

## Harness issues exposed and corrected

- A parent before its first launch legitimately has no runtime manifest; missing manifests after a known child launch remain custody failures.
- Cleanup failures now invalidate `assertions.json.passed`; one damaged artifact cannot prevent attempts to clean other verifiable owned terminals.
- Windows canonical session paths must be normalized before joining manifest and observer evidence.
- HC `keys` requires the name `space`, not a literal space argument. On this host it lowercases printable key names and does not turn shifted punctuation into the corresponding character. The literal slash driver therefore rejects unsupported characters and uses a lowercase-safe random token; it does **not** prove arbitrary uppercase/punctuation keystroke fidelity. The production continuation path was not replaced or repaired by this test helper.
- Long launch-script coverage feeds Node source on stdin rather than hitting Windows' argv limit with `node -e`.

These fixes concern test infrastructure. They do not establish that Pi and herdr handle every plugin feature correctly; the unresolved outcomes above are the next diagnostic targets.

## Review

An independent read-only review approved the changes with no actionable introduced issues. It traced backend routing and terminal custody, inspected all four final public-journey assertion/cleanup records, and independently reran the 13 targeted deterministic checks, lint, and `git diff --check`. It did not start terminals/models or rerun the live suites.
