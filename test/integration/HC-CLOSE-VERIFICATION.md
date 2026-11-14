# Owned Pi audit / close hardening — 2026-11-14

## Final evidence

On MAIN, the opt-in authenticated TUI journey passed **1/1, zero skips**, with exact model `openai-codex/gpt-6.1-sol` and installed global Pi 1.5.0. This is an additional journey, not a rerun of all the older HC lifecycle journeys.

```bash
PI_TEST_HC_TUI=1 node --test --test-reporter=tap --test-concurrency=1 \
  --test-name-pattern='owned audit draft rejection resume and close' \
  test/integration/hc-tui.test.ts
```

Private evidence is under root `.git/verification/2026-11-14T23-05-07-754Z-owned-audit-draft-rejection-resume-and-close-f73ef761-cbc9-48a5-a347-2c7719ec5f34/`. `assertions.json` has `passed: true`; `cleanup.json` has `allMissing: true`.

The real parent invoked production tools, with no model-response or OS-probe substitution:

- Spawned one non-auto-exit child, observed keep-open completion, and audited a sole owner matching its real PID/birth (PID 35440).
- Typed an unsent draft into that **owned** child's live TUI after its idle CLOSE proof existed. The parent tool returned `rejected`; there was no claim, shutdown, or child transcript change. The matching active intent cleared while immutable acknowledgement history remained.
- Cleared only that owned draft, then successfully continued the same run/process/session. The child executed another bash marker and produced its second keep-open result, without a second startup.
- Explicitly closed with a fresh request ID. Normal supervision removed both original ownership records. The observer captured those missing records **inside production `validateClosed`**, not merely after the tool-result event. The actual tool returned `closed`, original PID was OS-absent, remaining owner count was zero, and the child transcript was byte-identical across CLOSE (no extra model turn).
- Rechecked the same ID and received the identical receipt, without another shutdown dispatch. The owned parent then quit gracefully.

The test-only observer temporarily forwards the run map's `get` method unchanged to record missing-map reads from production closure validation. It also records ordinary custody transitions. It does not delete records, synthesize process death, invoke orchestration tools, or provide model responses. This distinguishes real cleanup during validation from cleanup that happens only after a tool has returned.

## Corrected boundaries

- Audit resolves real entrypoint aliases, finds the owning Pi package, verifies its declared `pi` bin and exact shipped CLI companion, and supports both `dist/cli.js` and `dist/bundle/cli.js`. The installed-bin process test starts two real global Pi RPC fixtures selecting canonical aliases of the same file; both are counted. Fixtures use graceful RPC EOF cleanup, not legacy/user process cleanup.
- Complete argv without any explicit session selector is outside this explicit-owner audit. Missing/denied argv and ambiguous potential explicit selectors remain uncertain. Unknown Node VM flags on a clearly unrelated script do not globally contaminate the audit. Pi 1.5 does not support `--session=path`; the audit reports that spelling uncertain rather than falsely clear.
- CLOSE checks the current live editor immediately before claiming shutdown. RPC's default editor getter cannot prove draft safety and now fails closed. RPC fixture coverage is not TUI proof. Its UI-focused close test injects only the ancestry transport verdict for its exact direct spawn handle; registered-tool boundary tests and the real HC journey cover production ancestry.
- CLOSE's FSWatcher is unreferenced and closes on lifecycle shutdown/reload/error. A separate scrubbed-environment SDK subprocess publishes real idle support, disposes its AgentSession without a shutdown event, and exits naturally, without `process.exit()`.
- Only a fully matching definite non-dispatch rejection with no claim clears its own close request/intent. Wrong process/run/nonce/header/request/token records, requested acknowledgements, claims and uncertainty retain the reservation. Immutable request/ack history and process ownership remain. Tests cover busy/draft races, continuation, fresh close and reload replay.
- Live ownership checks remain exact before dispatch and while the original process is present/unverified. Only original PID/birth death enters closure validation; branch, lease and binding checks remain mandatory. Replacement owners are never adopted or released. After death, the registered tool gives the existing supervisor a bounded drain window before its receipt; cleanup is never itself exit evidence.
- Windows ancestry gaps caused by exited HC/MSYS launchers can use independently probed strict creation ordering: a target born after this parent cannot be its ancestor. Self/parent/observed ancestors remain protected; equal/older/denied births fail closed.

## Automated checks and retained attempts

Final `npm test`: **477 passed, zero failed/skipped**. Targeted audit/close/registered-tool suite: **33 passed, zero failed/skipped**. `npm run lint`: exit 0. Logs and summarized results are private under `.git/verification/close-hardening/`; no new dependencies or lockfile edits were needed.

Nine owned HC attempts are retained. Earlier failures include conservative audit contamination, an unsupported literal underscore key in the test driver, missing-launcher ancestry, and stronger cleanup-timing assertions. An earlier weaker end-event observation passed but is **not** the final race evidence. A full-suite retry also hit a load-sensitive global CIM ancestry refusal in the UI-focused RPC fixture; that failure is retained, and the fixture now scopes its ancestry transport verdict to its exact owned direct spawn handle. None of those attempts is reclassified as a passing final-source run. The final strict journey above observes the actual closure-validation read.

Independent read-only verification in `.git/verification/close-hardening/independent-check.json` found all **18 owned terminals across all nine attempts missing**, the final original PID absent, and all six recorded production source hashes matching the checked tree. Earlier logs and evidence remain private; do not upload session contents or credentials.

## Limits

This closes one owned run, not every writer of a session. Remaining/uncertain writers are reported; duplicate-owner/PID-reuse fixtures test that distinction. The audit is point-in-time and covers explicit CLI session selection, not manual in-process session switches or a global cross-process lock. No automatic legacy cleanup, force-close production API, terminal typing for CLOSE, or user-pane interaction was added. Authentication stayed in its existing configuration; no credentials, global settings or personal knowledge-base content were copied. Terminal captures are text, not layout/color screenshots. Other HC journeys, platforms and providers were not rerun by this close-specific live command. Results remain subject to parent review, not child acceptance of a plan.
