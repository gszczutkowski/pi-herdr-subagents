# API rejection and token-overhead audit

Date: 2026-11-15. Audited branch: `fix/subagent-repair-sequence`, committed HEAD `d226f33`.

## Scope and confidence

Read-only investigation of the preceding parent session and current parent-context code. Existing uncommitted repair-6 changes in `live-continuation.ts` and its test were preserved. No production fixes, external API calls, credentials, raw transcripts, or full request bodies were added to this repository.

Local diagnostic scripts and aggregate outputs are under `.git/diagnostics/` (not tracked). They use the saved session ending `01a1e0ef-8ea9-7055-87b9-bf38a0036bcc.jsonl`. These artifacts are machine-local and will not accompany a clone.

Runtime inspected: installed Pi/pi-ai **1.5.0**, repository Pi/pi-ai **1.3.0**, Kiro provider **0.12.3**. Historical dependency installation state is not fully preserved. A recorded historical request-size diagnostic exactly matches the reconstruction, providing an independent calibration point.

**Conclusion:** subagents has a confirmed request-construction/continuation problem and significant avoidable context overhead. The persistent Codex 400 strongly correlates with crossing 1 MiB; the server did not explicitly identify a size limit. Independently, the Kiro adapter demonstrably emits a conversation violating its own alternating-message invariant. These are distinct findings, not a single proven server-side root cause.

## 1. Confirmed: ephemeral tail projections defeat Codex incremental continuation

Relevant code:

- `pi-extension/subagents/plan-context.ts:48`: appends a request-time `custom` message on every context event, including when no plan exists.
- `pi-extension/subagents/context-checkpoint.ts:106`: appends another request-time `custom` message when notes exist.
- `pi-extension/subagents/recovery-report.ts:60`: uses the same pattern when recovery information exists; not needed to reproduce this incident.
- Native Pi `core/messages.js`, `convertToLlm`: converts these custom messages to **user messages**.
- Native pi-ai `api/openai-codex-responses.js`, `getCachedWebSocketInputDelta`: incremental continuation requires the new input to start with the previous input plus the previous response items.

The projected user messages exist in a request but not in the durable conversation. On the next tool turn they disappear from their former position, and fresh projections appear after the new tool result. Therefore the new request is not an extension of the previous request, even when plan/checkpoint content has not changed.

Six adjacent request transitions were reconstructed using the actual adapter's delta-selection function:

| Variant | Incremental continuation eligible | Incremental input size |
| --- | ---: | ---: |
| Without plan/checkpoint projections | 6/6 | 162–3,466 bytes |
| With production plan/checkpoint projections | 0/6 | Full bodies of 1,024,184–1,051,271 bytes |

These are **delta input-array sizes**, not complete request-frame sizes. Eligibility assumes a usable connection and previous response; it is not proof that an actual historical request used a particular transport path. However, loss of eligibility from the projections is deterministic and reproduced.

This also does not prove a particular provider prompt-cache discount would be restored. WebSocket incremental continuation, server prompt caching, and token billing are related but different mechanisms.

## 2. Strong Codex size-limit evidence, not a confirmed backend limit

Native session projection, saved system/tool declarations, model compatibility metadata, and production plan/checkpoint projection functions were used to reconstruct requests. Capture occurred in `onPayload`, with a dummy credential and networking disabled.

| Boundary | Observed historical outcome | Reconstructed JSON body bytes |
| --- | --- | ---: |
| 21:02:36 UTC | Temporary WebSocket close 1000 | 937,653 |
| 21:05:43 UTC | Successful model response | 1,039,347 |
| 21:06:01 UTC | Last successful model response | 1,041,028 |
| 21:06:02 UTC | First persistent `Bad Request` | **1,051,271** |

The historical transport diagnostic explicitly records **937,653 bytes** at the first row, exactly matching the reconstruction. The temporary WebSocket failure recovered, so it should not be conflated with the later persistent failure.

**1 MiB = 1,048,576 bytes.** The first persistent failure falls 2,695 bytes above that boundary, while the last successful request falls 7,548 bytes below it. These measurements exclude the small WebSocket `response.create` wrapper; including it does not change which side of the boundary these requests occupy.

Without the two projections, the first failing body reconstructs to 1,045,983 bytes and becomes eligible for incremental continuation. This is a counterfactual structural measurement, **not** a claim that removing projections was tested successfully against the live server.

No unpaired tool calls/results or duplicate tool-call IDs were found. There were no compactions. Last successful input usage was 192,114 tokens including cached input; the model catalog advertises 500,000 context tokens. Current guard defaults trigger at 400,000 tokens for that model and have **no serialized-byte budget**. A byte-size limit can therefore be reached well before token-based protection acts. Encrypted reasoning payloads and JSON overhead also consume transport bytes; a token-only heuristic cannot cover them reliably.

Remaining uncertainty: no HTTP request ID/body diagnostic or explicit size-limit reason was saved for the persistent 400, and no controlled live boundary test was performed. Backend validation, encrypted response-item handling, or another transport limit cannot be categorically excluded.

## 3. Confirmed Kiro adapter invariant failure

The installed Kiro provider was invoked offline with dummy credentials, an isolated home directory, catalog refresh disabled, and a fetch interceptor. Real request construction and provider validation ran, but no request reached a network.

### Minimal reproduction

1. Native user message: `Reply OK`.
2. Run production `projectPlanContext` with no active plan.
3. Run native `convertToLlm` and the installed Kiro provider.

Without step 2, the provider's `validateKiroConversation` passes. With step 2 it fails:

```text
ALTERNATING_MESSAGES @ 1
Between every two user messages there must be an assistant message
```

The provider merges adjacent user messages inside history but does not merge the final history user message with the separate `currentMessage`. Its repair pass fixes tool structure and empty content, but leaves this alternating-message failure in place and still builds the request.

### Historical reconstruction

Both historical Kiro attempts reconstruct to a tail of:

```text
... user -> assistant -> user -> current user
```

For the first Kiro attempt, validation fails at index 329. There are no missing tool declarations or empty assistant messages. Reconstructed bodies are approximately 0.80 MB, so the Codex 1 MiB hypothesis should **not** be applied to Kiro.

Offline coalescing of adjacent user carriers, preserving content and tool results/catalog, makes the same validator pass. This is a diagnostic experiment, not an installed fix.

Importantly, the historical Kiro attempt remains invalid **without subagents projections** because several user prompts were submitted after failed assistant responses; the provider removes those failed assistant messages. Subagents is a sufficient trigger for this adapter bug but is not its only trigger. Consecutive user messages are valid in Pi's provider-neutral conversation; the Kiro adapter is responsible for converting them into its stricter wire format.

This is a concrete malformed-request candidate consistent with `REQUEST_BODY_INVALID`, but no live replay was performed to prove it was the server's only objection.

## 4. Token accounting

### Observed session usage

These totals are sums of saved successful assistant `usage` fields, not tokenizer estimates:

| Metric | Value |
| --- | ---: |
| Successful assistant requests | 164 |
| Total input, including cached input | **20,957,686 tokens** |
| Uncached input | 17,912,438 |
| Cached input | 3,045,248 (**14.53%**) |
| Output | 28,929 |
| Tool calls | 181 |
| `plan_read` requests | 41 |
| `plan_read` returning the same text as the preceding plan read | **32** |
| Input used by those 32 requests | **5,280,467 tokens (25.20% of total input)** |

The 32 same-result reads are not all consecutive; some reads may legitimately recheck authority before mutation. Their usage is the cost **associated with those requests**, not a guaranteed savings estimate or proof every read was unnecessary. There are nevertheless runs of up to five consecutive assistant turns doing only `plan_read` with unchanged output.

`plan-context.ts:20` tells the model to "Read plan_read({})", and `context-checkpoint.ts:111` tells it to re-read the plan. Both arrive repeatedly as the newest user messages. This is a plausible reinforcement mechanism for the observed read loops, but causation would require an A/B model experiment.

Pi's saved monetary estimate is about $36.42 for the successful session, including about $9.17 associated with those 32 same-result reads. These are **Pi-calculated estimates**, not provider invoices or actual subscription charges.

### Structural text overhead

The following are `o200k_base` text/JSON-token estimates, not exact model billing:

| Extension material | Estimated tokens |
| --- | ---: |
| Ten subagents/planning tool declarations | 4,303 |
| Extension rules, agent/model catalogs | 1,577 |
| Extension tool-list snippets | 493 |
| Plan projection at failure | 315 |
| Checkpoint projection at failure | 973 |
| **Combined declared/prompt/projection material at failure** | **7,661** |

This overhead exists even when no child has been launched. Serialized tool-schema tokenization differs from a provider's internal tool representation, so 7,661 is a comparative estimate rather than an exact additive billing charge.

`plan_update` alone contributes about 1,830 schema tokens; `subagent` about 1,164. The empty-plan projection still adds about 75 text tokens per request. Plan/checkpoint projections total approximately 161,978 text tokens across the successful requests in this session.

Historical tool-result text also stays in the conversation:

| Tool result source | Text tokens present by the end |
| --- | ---: |
| `read` | 95,067 |
| `bash` | 29,373 |
| `plan_read` | 14,691 |
| `plan_update` | 10,152 |
| `context_checkpoint` | 2,712 |

Thus extension bookkeeping is material, but **not the only or largest source of historical text**: file reads dominate. The three bookkeeping tools alone add roughly 27,555 historical result-text tokens before counting call arguments. `plan_update` returns complete task snapshots even for small mutations (`plan-tools.ts:96`). Each later request replays these older results until compaction.

The checkpoint projects a saved `planSummary` in addition to the current plan projection. At failure the saved checkpoint references plan revision 9 while the current plan is revision 10; the saved summary alone is about 313 tokens. It is labeled advisory, but still duplicates information and may reinforce stale context.

There is **no unbounded accumulation of new projection messages inside a single context call**: each projection replaces its own previous projection, and relevant tests pass. The problems are repeated request overhead, historical tool outputs, ephemeral placement, and induced extra model requests.

## 5. Recommended changes, in priority order

### P0 — Correctness and transport stability

1. **Stop ephemeral tail injection on every request.** Keep plan/checkpoint durability and UI. Provide model-visible state at well-defined changes/restoration/compaction boundaries using a stable, append-compatible representation; do not rewrite already-sent history, manufacture user instructions after every tool result, or trigger extra model turns. Test unchanged-state continuation and changed-state behavior against actual provider serializers. Simply moving a mutable block into the beginning/system prompt is not automatically cache-safe.
2. **Fix Kiro current/history normalization in the provider package.** Merge consecutive user carriers across the split, preserving tool results, tool declarations, images, and ordering. Validate the complete outgoing conversation. Tests must include user+projection, tool result+projection, repeated user prompts after failed responses, and both one/multiple projections. Disabling subagents alone does not repair the historical repeated-user case.
3. **Add transport-size protection/diagnostics alongside token protection.** Measure actual serialized requests where possible, distinguish full vs delta requests, and retain headroom. The suspected 1 MiB boundary is incident evidence, not a universal documented provider constant. Do not blindly classify every 400 as overflow, and never truncate an orphaned tool-result/reasoning dependency. Expose actual byte size and whether incremental continuation was available.

### P1 — Avoidable token use

4. Replace unconditional "Read plan_read" instructions with conditional guidance: read when task detail is missing, authority/revision must be checked, or a write conflicts. Preserve concurrency/authority checks. Do not reread the same summary merely because it was projected again.
5. Return compact mutation receipts (`planId`, revision, changed task ID/status, new evidence/attempt IDs) from `plan_update`; retain an explicit detailed read path and full persisted state. Preserve every ID required by the next command.
6. Return a compact acknowledgement on checkpoint saves. Project only relevant working-state notes; avoid routinely replaying the saved plan summary alongside the current plan. Surface stale revision explicitly or omit the duplicate summary from the prompt.
7. Do not project "No readable active plan" into every ordinary conversation. Keep discovery/recovery notices conditional on actual state, errors, or an explicit request.
8. Add long-session policies for large file reads and old bookkeeping output. Prefer bounded targeted reads and safe native compaction rather than silent message deletion. Token and byte triggers should consider the cost of the compaction request itself.

### P2 — Fixed prompt/schema cost and coverage

9. Reduce repeated async-tool prose and catalog verbosity; consider on-demand model/agent catalogs and advanced tools where host/provider behavior supports them. Do not sacrifice exact model IDs, ownership guards, or historical tool declarations merely to shorten schemas.
10. Align/explicitly test the supported host versions. The repository depends on Pi 1.3.x while the installed CLI is 1.5.0; local tests against only 1.3.x are insufficient evidence for production provider behavior. The version difference is a risk, not an independently established cause here.

## Verification and artifacts

- **29/29** focused existing tests passed: `plan-context`, `context-checkpoint`, `context-guard`, `context-protection`, `recovery-report`.
- Existing tests verify projection bounds, persistence, and compaction behavior, but do not catch the cross-request Codex delta invalidation or Kiro final-message boundary failure.
- Offline Codex capture: `session-audit.mjs`, `request-metrics.json`; exact historical 937,653-byte anchor; six delta A/B comparisons; zero network calls.
- Offline Kiro capture: `kiro-audit.mjs`, `kiro-metrics.json`; eight historical variants and two minimal variants; zero external requests.
- Token accounting: `token-audit.mjs`, `token-metrics.json`.
- Focused test output: `context-tests.log`.

All local diagnostic artifacts above are under `.git/diagnostics/`. No herdr integration tests, live provider replay, or complete repository test suite were run for this audit. No production behavior was changed.
