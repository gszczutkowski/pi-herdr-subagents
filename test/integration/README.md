# Pi + herdr integration tests

Run from the repository root on Node.js 24+. `npm test` is the deterministic suite; it does not start HC TUI journeys. `npm run lint` checks both production and tests.

## Entry points

```bash
npm run test:integration:transport
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration:plugin
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration:pi
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration
```

In PowerShell set `$env:PI_TEST_MODEL = 'openai-codex/gpt-6.1-sol'` first. Choose an **exact authenticated provider/model-id** available on your host, not necessarily this example. Pi scopes make real, potentially billable model requests. The same model is applied to the parent and isolated seeded agents. No model is requested by transport scope.

| Scope | HC (herdr-core) | Legacy herdr |
| --- | --- | --- |
| `transport` | `test/hc-live.test.ts`, `hc-transport.test.ts`: actual script/Pi PATH execution, inspection/reads/removal; concurrent exact-address scripts with Unicode/quotes/long payloads; tab/right/down requests as distinct terminals; on Windows/Linux, closing an idle terminal must end its original Bash process (PID + birth) and release its working directory | `mux-surface.test.ts`: existing pane/tab transport suite |
| `plugin` | `hc-plugin.test.ts`: four public Pi journeys below | `subagent-lifecycle.test.ts`: existing seven public/lifecycle scenarios |
| `pi` | `plugin` plus `hc-tui.test.ts`: existing ten lifecycle/recovery/control journeys | lifecycle plus `claude-completion.test.ts` (synthetic Claude adapter boundary, not a real Claude service) |
| `all` (default) | transport + plugin + lifecycle | transport + both Pi fixtures |

The runner requires `HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET`, or `HERDR_ENV=1` + `HERDR_WORKSPACE_ID`. It verifies the selected CLI/server and the same local Node/Pi used to launch the parent TUI before starting tests. Missing/incompatible environments are **preflight failures**, not all-skipped passes. HC takes precedence when both environments are set; explicitly requesting legacy while HC routing is active is rejected. Verification of one backend says nothing about the other.

```bash
PI_TEST_MODEL="provider/exact-id" npm run test:integration -- --backend=hc
PI_TEST_MODEL="provider/exact-id" npm run test:integration -- --backend=legacy
PI_TEST_MODEL="provider/exact-id" npm run test:integration:plugin -- --test-name-pattern="fork"
npm run test:integration -- --help
```

Filtering is diagnostic, not full-suite acceptance. Unknown/duplicate flags are rejected, and the runner exits nonzero if no case executes (including zero name matches or all skipped). `PI_TEST_TIMEOUT` is the legacy per-wait timeout in milliseconds (default `180000`); HC steps have bounded waits, usually 180 seconds, and each Pi journey has a ten-minute overall deadline. Tests run sequentially to avoid competing terminal input drivers. Do not run two live suites simultaneously.

## New public Pi journeys

Each starts a fresh real Pi TUI with the working-tree extension, a unique scratch project/profile, seeded `verify-worker` / `verify-open`, an authenticated readiness token, and owned terminal IDs. No production tools or model responses are mocked.

1. **Project discovery and literal named slash launch**: actual `subagents_list` result includes source/model/auto-exit metadata for both project agents. Literal HC named keys execute `/subagent verify-worker <task>` (not provenance-tagged `hc send`). The driver uses a lowercase-safe alphabet and rejects uppercase/shifted punctuation, which HC 0.1.21 does not deliver losslessly. Correlate the real child startup, parent manifest and session, exact bash marker, and parent completion response.
2. **Explicit fork**: a random token exists only in an earlier parent conversation turn. `subagent(fork: true)` creates a distinct saved child session linked to the actual parent, inheriting the original context entry. The child must use that token in real bash and return a successful result.
3. **Invalid named tool agent**: the actual `subagent` tool error identifies the unavailable agent; the owned parent's durable runs/outbox/launch scripts and observer events show no child work. A subsequent valid child succeeds. This is not coverage of invalid `/subagent` UI notifications.
4. **Durable plan/checkpoint reload**: actual `plan_update`, `plan_read`, and `context_checkpoint` results match native saved entries. Literal `/reload` preserves plan identity, revision, authority, checkpoint and entry IDs. A stale revision fails without an append; a current revision write succeeds.

The observer records events; it does not launch children, call orchestration tools, or supply model replies. The test auth bridge uses the original credential store without copying credentials or changing global settings. HC's split fallback is tested as terminal creation, **not** a visual split/layout guarantee. Text captures are not screenshots.

## Evidence and teardown

HC TUI journeys print unique `.git/verification/<timestamp>-<journey>-<id>/` paths containing source hashes, versions, actions, launch scripts, actual sessions, observer events, captures, `assertions.json` and `cleanup.json`. The long-payload transport test also retains its scripts/results/cleanup there. Keep evidence private: it can include paths, prompts and responses. Never upload credentials or auth files.

Require both `assertions.json.passed === true` and `cleanup.json.allMissing === true`. Cleanup targets only exact owned terminals, attempts every independently verifiable child even after one failure, and fails on unresolved custody. Scratch remains on failure. A no-child parent legitimately has no runtime manifest; a missing manifest after a known child launch is a custody failure. Cleanup failure cannot leave passing assertions. Early constructor/preflight failures may have only partial evidence.

The existing advanced HC suite deliberately keeps its stronger assertions enabled. Earlier verification records are bounded selections, not proof of every current journey; see `HC-WORKFLOW-VERIFICATION.md`, `HC-CLOSE-VERIFICATION.md` and [the expansion run report](INTEGRATION-EXPANSION-VERIFICATION.md). Provider/model deviations fail preconditions rather than being replaced by internal calls, sequential tools, or another transport.

Direct low-level invocations still use opt-in gates:

```bash
PI_TEST_HC_LIVE=1 node --test --test-concurrency=1 test/hc-live.test.ts test/integration/hc-transport.test.ts
PI_TEST_HC_TUI=1 PI_TEST_MODEL="provider/exact-id" node --test --test-concurrency=1 test/integration/hc-plugin.test.ts test/integration/hc-tui.test.ts
```

Without these flags the low-level files **skip**; that is not live proof. Prefer the runner, which selects and enables only the matching backend. Legacy still uses the older harness/provider-extension isolation behavior documented in `.pi/skills/verify-pi-herdr-subagents/SKILL.md`; missing extension-backed providers are failures, not evidence of plugin success.
