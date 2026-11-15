# Parent context protection verification

## Automated evidence

- `npm test`: **540 passed, 0 failed, 0 skipped** (all files enumerated in the package test script).
- `npm run lint`: passed.
- `git diff --check`: passed.
- `PI_SUBAGENT_ID=test-child PI_SUBAGENT_SESSION=test-session node --test test/context-guard.test.ts test/context-checkpoint.test.ts test/context-protection.test.ts test/result-budget.test.ts`: **42 passed**. Parent-role fixtures explicitly isolate inherited child-role environment.

## Boundaries exercised

- `context-guard.test.ts`: model-sized reserve and retention budgets, strict configuration validation, native/per-model settings, disabled/unknown/aborted/length states, cancellation, generation/branch invalidation, abort propagation, checkpoint failure, ineffective summaries and failure cooldown. An actual Pi `AgentSession` with a deterministic configured provider executes a tool, persists a compaction draft, and makes its naturally required next response without manual abort or an extra continuation.
- `context-checkpoint.test.ts`: real native session persistence, retain-none compaction, reload/reopen, historical branch selection, fork inheritance, child/ephemeral/setup restrictions, strict schemas, UTF-8 and JSON-escaping limits, deduplication, pure projections and a real disk append failure. A model-issued checkpoint save and actual Pi lifecycle compaction are exercised.
- `result-budget.test.ts`: UTF-8-safe aggregate report bounds, full immutable artifacts, short-message identity, multipart/images, structured proposals, pings/errors, storage/serialization failures, conflicting archives and immutable retry. Pi's actual `convertToLlm` verifies that full UI details do not reach model content.
- `context-protection.test.ts`: production `index.ts` registration, plan and explicit working state restored after retain-none compaction/reopen, all four result/help/error paths bounded before durable outbox persistence, archive references, failed handoff/retry and zero projection-triggered sends or storage mutations.
- Existing plan authority, delivery, resume, ownership, branch recovery, guidance and rendering regression tests are included in the full suite.

## Verification limits and operational behavior

The deterministic model tests are real Pi lifecycle/session integrations, not live provider or herdr-terminal end-to-end verification. Native and custom compaction remain fallible, estimates are heuristic, and one giant incoming message or indivisible tool batch can exceed a reserve. Summaries intentionally do not replace authoritative plans or explicit working-state notes.

The proactive running-turn path uses Pi's supported native boundary drafts, because manual `ctx.compact()` aborts an active run. Boundary drafts do not invoke native compaction notification/custom-summary hooks; checkpoint capture is explicitly performed first. Native/manual/overflow paths still invoke their ordinary hooks. Proactive compaction can be disabled independently of bounded reports and explicit checkpointing. See the README's **Parent context protection** section for configuration, limitations and recovery behavior.
