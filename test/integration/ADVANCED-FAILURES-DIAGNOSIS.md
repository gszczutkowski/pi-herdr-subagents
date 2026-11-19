# Advanced integration failures: diagnosis — 2026-11-17

Follow-up to [the expansion verification](INTEGRATION-EXPANSION-VERIFICATION.md). This is a diagnosis, **not a production fix or full-suite acceptance**. No production source, global configuration or credentials were changed. Private diagnostic scripts/evidence are under `.git/verification/integration-diagnosis/`.

## Summary

| Original outcome | Finding | Confidence / limit |
| --- | --- | --- |
| Missing second keep-open completion | Child finished and published the correct result. Parent harvested it into history and the durable outbox, but did not hand it to Pi. A pre-dispatch persistence/custody exception that parks delivery is the strongest matching mechanism. The same-runtime recovery gap is reproducible. | Delivery-stage failure confirmed; original exception/errno **not recorded**, so the precise triggering I/O/custody fault remains unknown. |
| Resume rejected after guarded interrupt | Child really aborted and published valid interrupted-idle proof. Parent rejected before reading that proof, while its UI classified the child as `starting`. Production lifecycle reducers reproduce a sampling interleaving that produces this stale classification. | Rejecting guard and inconsistent parent/child state confirmed; reducer/guard flaw reproducible. Exact original intermediate polling sequence was not logged. |
| Same-batch done + bash | Retained assistant response contains only `subagent_done`; there is no bash sibling. The intended settlement path was never exercised. | Failed test-input precondition, not a demonstrated plugin sibling-settlement defect. |
| Same-batch ping + bash | Retained assistant response contains only `caller_ping`; no bash sibling. | Same limitation. Raw provider stream was not recorded, so model choice versus provider normalization cannot be separated retrospectively. |

Seven relevant production source hashes were checked against **all four original runs** and match the current files: `index.ts`, `lifecycle.ts`, `live-continuation.ts`, `subagent-done.ts`, `delivery.ts`, `runtime-store.ts`, `completion.ts`. Machine-readable proof: `source-verification.json` in the private diagnostic directory. The integration harness has subsequently changed; original actions/events, not assumptions about current timing, are authoritative.

## 1. Second completion: publication succeeded, parent handoff did not

Original evidence directory:

`.git/verification/2026-11-16T22-01-20-337Z-owned-audit-draft-rejection-resume-and-close-32f04408-25f0-4660-b204-6b14d0418e8f/`

Confirmed UTC chronology, November 16:

- **22:02:29.521:** `subagent_resume` returns `continued`; the child acknowledgement is accepted.
- **22:02:31.433–31.522:** the same child executes `printf RESUMED > close-resumed.txt` successfully.
- **22:02:33.748–33.767:** child final response confirms the work and the child settles normally.
- **About 22:02:33.814:** immutable completion event 2 is written with `type: done`, `keepOpen: true` and the correct resumed-task summary.
- **22:02:33.965:** the parent's history records result 2.
- The durable manifest ends at **revision 10**, with both completion IDs retained: result 1 is `handedOff`, result 2 is **`pending`**. Only result 1 exists as a parent `subagent_result` message.
- **22:05:32.611:** the test times out waiting for parent delivery 2.

The copied `child-<id>.jsonl` is a first-turn snapshot. The final `session-t1ts-…jsonl` and retained actual child session include both turns. Reading only the first snapshot would incorrectly suggest the child never finished.

Neither child turn called `subagent_done`. This was valid natural keep-open completion: the second artifact actually exists, and the successful comparison run also completes naturally. Changing the task prompt to force another done call would not explain or repair the lost parent handoff.

### Matching production path

- `delivery.ts:68–74`: persist the immutable envelope, register pending delivery, then flush.
- `delivery.ts:117–124`: persist `dispatching` **before** Pi `sendMessage`. A persistence/custody exception sets `parked = true` and retains only an in-memory `persistenceError`.
- `delivery.ts:116,149–153`: parked entries are skipped and receive no retry timer.
- `delivery.ts:90`: restoration skips an already existing pending entry; it does not unpark it.
- `index.ts:1674–1694`: `/subagents-reconcile` eventually flushes delivery but does not resolve this parked entry.

The unchanged revision 10 fits a failure before the dispatching commit; successful two-result comparison reaches revision 12. No parent reload/navigation/shutdown or branch change explains intentional suspension in the retained actions/session. Nevertheless, the old run did not retain its delivery-state error. An actual Windows `rename`, permission, storage, or custody exception **cannot be named as a confirmed cause**.

### Reproduced recovery gap

`delivery-parking-repro.test.ts` uses the actual `RuntimeStore` and delivery implementation, with a deliberately injected exception at the store boundary and a synthetic send boundary:

1. Pre-send exception leaves disk status `pending`; nothing is sent.
2. Restore storage, flush and restore/reconcile the existing delivery state: **still parked, no send**.
3. Restore the known-pending event in a fresh delivery state: one handoff succeeds.
4. Control: a genuinely ambiguous `dispatching` event remains parked and is never blindly replayed.

**2/2 passed.** This proves the recovery mechanism/gap, not the original errno. It is not a real-HC or model test.

**User impact:** a completed child's result can exist safely on disk yet fail to wake its parent, with ordinary same-runtime reconciliation unable to recover that parked delivery.

## 2. Guarded interrupt: stale `starting` wins over real aborted-idle proof

Original evidence directory:

`.git/verification/2026-11-16T22-08-11-950Z-interrupt-live-continuation-8f7f5007-7407-41ac-8b37-daaa013aa9c4/`

Confirmed UTC chronology:

- **22:08:29.152:** the child executes the actual bash gate.
- **22:08:32.383:** interrupt acknowledgement is `interrupt_requested`, settlement initially unconfirmed.
- **22:08:32.854–32.903:** bash aborts, the child session records `stopReason: aborted`, and `agent_settled(aborted: true)` is observed.
- **About 22:08:32.906–32.934:** the child publishes `artifact-v1` / `interrupted-idle` with a valid token, a correlated interrupt settlement, and final waiting activity with all active flags false.
- **22:08:34.462:** the pre-resume terminal inspection reports idle.
- **22:08:40.336–43.153:** actual `subagent_resume` rejects the child as not tracked interrupted/settled idle.
- The parent capture shows **`starting…`**. The continuation directory contains only state: no follow-up request, claim or result was dispatched.

This is not merely a test resuming before the child's settlement. Final proof predates resume submission by about 1.5 seconds and execution by about 7.4 seconds.

### Matching production path and deterministic reproduction

`index.ts:2316–2339` enters the live-owner branch only after finding the registered child. Missing registration is therefore not the explanation for this exact error.

`live-continuation.ts:161–163` rejects turns outside `interrupted | waiting | active` **before** reading the child token at line 179. Its stale-active exception cannot help a child classified `starting`.

The production lifecycle reducers permit this sequence:

```text
HC idle, hasWorked=false
→ local interrupted marker
→ newer active cancellation-drain activity replaces marker
→ final child waiting snapshot clears detail but does not change turn/history
→ HC idle + hasWorked=false becomes starting
→ valid interrupted-idle token is never read by resume
```

Relevant rules: `lifecycle.ts:124–128,164–173,234–274`. `hasWorked` is established by coarse HC working/blocked/done observations, not by activity alone. Sampling can miss a brief coarse working interval. Waiting longer does not repair the resulting classification: subsequent idle observations still produce `starting`.

`interrupt-lifecycle-repro.test.ts` reproduces this with fixed sequences/timestamps and the real continuation guard. It confirms rejection **before inspection and token read**, with no request file. Two controls—observing HC working earlier, or omitting the intermediate active read—pass validation and publish a request. These controls have a synthetic child and return `pending`; **no child acceptance is claimed**.

**4/4 passed** (three scenarios plus evidence-save check). The exact original sampling interleaving remains inferred; its resulting UI/guard mismatch is directly recorded.

**User impact:** a genuinely interrupted, surviving child can be impossible to resume through the public tool because coarse parent presentation state incorrectly outranks the child's own valid proof.

## 3–4. Same-batch cases: distinguish missing precondition from settlement failure

Original evidence directories begin `2026-11-16T22-10-13-722Z-staged-done-…` and `2026-11-16T22-10-34-382Z-staged-ping-…`.

- Done: at **22:10:33.450**, the recorded assistant response contains exactly one tool call, `subagent_done({close:false})`; no bash. The tool stages completion and returns `terminate:true`; normal settlement follows.
- Ping: at **22:10:56.854**, the recorded response contains exactly one `caller_ping`; no bash. It stages the ping and terminates normally.
- The test correctly fails its precondition. It never releases a sibling gate or tests publication while that sibling is running.
- The selected native Codex transport enables `parallel_tool_calls: true` (`node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:405`), so configuration does not intentionally disable parallel output. That source fact is not raw-wire evidence of what the model/provider emitted.
- Completion tools are semantically terminal, and ping explicitly prefers being called alone. A natural-language request for this unusual stress batch does not deterministically produce it.

To exercise the intended branch without depending on model behavior, `native-sibling-repro.test.ts` uses the **actual Pi SDK, production child extension and real bash subprocess**, with an explicitly deterministic provider emitting two sibling calls. Both done+bash and ping+bash:

1. really enter the blocked bash gate;
2. stage the intent without publishing a result or requesting shutdown;
3. release bash and perform Pi's natural next request;
4. publish the actual final post-sibling text only after settlement.

**2/2 passed.** This proves native Pi/extension/bash settlement under controlled batch input, **not authenticated same-batch behavior through HC**. The latter remains unverified; sequential tool calls must not be counted as a substitute.

## Bounded live retest, unchanged functional journeys

The two original lifecycle journeys were rerun with `live-repro.test.ts`. It installs an additional test-only observer in the isolated wrapper, then imports the unchanged journey code. The observer forwards `RuntimeStore.delivery` calls unchanged, logs any actual error, and records lifecycle state at public tool boundaries. It never invokes orchestration tools, alters control state or supplies model responses.

```bash
PI_TEST_HC_TUI=1 PI_TEST_MODEL=openai-codex/gpt-6.1-sol \
  node --test --test-concurrency=1 \
  --test-name-pattern='owned audit draft rejection resume and close|^real HC Pi TUI: interrupt live continuation$' \
  .git/verification/integration-diagnosis/live-repro.test.ts
```

**2/2 passed, zero skips**, with real Pi 1.5.2, HC 0.1.21 and the authenticated model:

- `2026-11-17T06-30-36-846Z-owned-audit-draft-rejection-resume-and-close-ab09dc4d-5296-48c3-bd6e-204f33a36d4b`: both results commit dispatching/handedOff; final verified close is reached; no store delivery error occurs.
- `2026-11-17T06-32-49-828Z-interrupt-live-continuation-e1e6eb7c-c85d-463c-89be-763097521fe5`: parent observes HC working (`hasWorked:true`); it retains interrupted state and the same child successfully resumes.

Both `assertions.json.passed` and `cleanup.json.allMissing` are true, with no unresolved custody; inspected summary is `live-summary.json`. These are **intermittent paths, not repaired by the retest**. Additional observation can affect scheduling, and no failure-frequency inference is made. The full 17-test integration suite was not rerun.

Existing targeted native/control checks also passed **63/63**: settled completion, keep-open state/activity, guarded interruption and live continuation. Full commands/logs and the eight diagnostic checks remain in the private diagnostic directory. Early diagnostic assertion/setup errors were corrected in those private fixtures; they are not product failures or passing proof.

## Recommended fixes, not applied

1. **Interrupt/resume:** reconcile a stale starting label against a fresh run/session-bound interrupted-idle capability, or correct the validated activity/work-history transition. Preserve fail-closed behavior for genuinely unstarted, busy, stale, foreign and uncertain children. Add the intermediate-observation regression and both controls to permanent tests; merely increasing delays is not a fix.
2. **Result delivery:** distinguish pre-send parking from ambiguous post-send dispatch; expose failure stage/error and support explicit bounded reconciliation for proven-unsent `pending` events after writer/branch/storage validation. Never blindly unpark or replay `dispatching` events. Require immutable payload, no extra child turn, and exactly one observed handoff in the regression.
3. **Same-batch verification:** retain the authenticated precondition checks, but report blocked model-input scenarios separately from exercised product assertions. Use a clearly labelled deterministic batch fixture for reliable settlement regression; add controlled HC TUI coverage if terminal-level proof is required.
4. **Diagnostics:** retain actual delivery errors and relevant lifecycle transitions in future failed-run artifacts. The missing old errno and intermediate samples cannot be recovered from successful reruns.

The current evidence points to plugin lifecycle/recovery gaps and model-driven test-input limits. It does **not** establish a general defect in Pi or herdr, nor verify legacy herdr compatibility.
