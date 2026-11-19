---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Run from the repository root inside **the backend being verified**: legacy herdr or herdr-core (HC). Read `test/integration/README.md` for the test matrix and evidence rules. No other terminal backend is supported.

## Preflight and transport

```bash
node --version
npm test
npm run lint
npm run test:integration:transport
```

Node 24+ and installed dependencies are required. The runner detects HC from `HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET`, or legacy herdr from `HERDR_ENV=1` + `HERDR_WORKSPACE_ID`. It checks the CLI/server and local Pi installation, and fails instead of silently reporting all-skipped success when prerequisites are absent. Never fabricate environment variables to force another backend. Transport scope starts no model.

## Real Pi journeys

Choose an **exact authenticated provider/model-id** from the host's available models. The example below works only where that model's credentials are configured:

```bash
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration:plugin
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration
```

These commands make real, potentially billable requests. The model is pinned for both parent and seeded child sessions. `plugin` runs public feature journeys; default `all` adds transport and existing lifecycle/recovery/control journeys. `test:integration:pi` omits transport. Use `-- --backend=hc` or `-- --backend=legacy` to require a specific backend; HC cannot count as legacy proof. Legacy waits default to `PI_TEST_TIMEOUT=180000` ms; HC uses bounded per-step waits and a ten-minute journey deadline.

The harness loads the extension from the working tree, seeds isolated test agents, and targets only owned terminals. HC TUI journeys retain source hashes, actions, real sessions, observer events and captures under `.git/verification/`. Inspect **both** `assertions.json` and `cleanup.json`: require `passed: true` and `allMissing: true`. Cleanup failure or unresolved custody is not acceptance. Keep evidence private; never copy credential files.

Report passing, failing, skipped and blocked tests, and the exact backend/model/command. A filter, missing provider, failed model-input precondition, or skipped journey is not full verification. Existing advanced journeys retain their strong assertions and may reveal unresolved behavior; do not silently exclude them to obtain green results. Direct `node --test` HC invocations still require opt-in environment flags and otherwise skip. For targeted manual journeys, load `../verify-pi-herdr-subagents/SKILL.md`.
