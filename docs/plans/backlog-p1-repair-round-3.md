# Backlog P1 — repair round 3

**Worker implementation and targeted checks complete.** This is the final repair round for the new P1 iteration, addressing [independent review #4](backlog-p1-independent-review-4.md). Independent review #5 and coordinator acceptance are pending. Do not treat this report as acceptance or proceed to P3 if that review still finds defects.

## Change and evidence

- **One current-writer journal fault latch.** The startup and explicit supervisor-disposition reads use the same reader as fresh spawn, resume, metadata repair and recovery inspection. It latches read/validation faults on the current writer, stops recovered supervision and pauses delivery retries. A failed disposition read exits before starting/reconciling the supervisor or restoring deliveries. An in-flight restore checks the latch before progressing or installing its supervisor. Successful incidental reads and same-writer reload do not clear it; a clean explicit pass can restore supervision and delivery readiness.
- **Related read audit.** Live after-intent plan proof also uses this reader; a newly observed fault defers marked import and prevents explicit delivery continuation. A later incidental import retry honors the latch. Incident evidence locations now come from the verified journal pass instead of a second location-only open whose failure was suppressed. Startup candidate metadata still reports its own read error and aborts writer rotation before installing a store. Offline proof callers still return false on read errors, and the disabled queue adapter is unchanged. An existing-record read in exclusive journal publication remains a write-side check, not a reconciliation read or a basis for continued dispatch.
- **Four permanent one-shot EIO cases.** At explicit disposition, startup disposition, and read-only recovery, a schema-valid journal has only a `startedAt` disagreement. Exactly one targeted open fails; the pause is reported, no supervisor continuation/delivery occurs, and both independent launch surfaces are refused despite later good reads and reload. Clean explicit reconciliation preserves the conflict and original reservation, yet permits separate explicit spawn and resume (one mocked pane/send and a distinct run ID per launch). The plan-proof case also verifies that a canonical marked import remains deferred after a good incidental retry and projects exactly one failure after explicit repair, with no notification. No journal rewrite, automatic relaunch, replay or false task result was observed.
- Existing regressions for nonempty failure at publication/read, cursor quarantine, exact binding, disputed-session scope, file/memory evidence retention and final dispatch health gates passed unchanged. The ordinary-plan/delivery paths still project bound pending results independently of notification.

## Checks

Windows, Node `v24.21.0`, npm `11.19.0`. The four new cases use mocked terminal transport; existing native fixtures use synthetic local sessions/processes. No Pi API/harness interfaces were changed.

| Exact command | Result |
| --- | --- |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-name-pattern='one-shot journal EIO' test/dispatch-recovery.test.ts` | Before the source fix: expected RED 0/3 (explicit supervisor pass ran; startup omitted EIO; read-only control did not stop the installed supervisor). Final: 4/4 pass, including plan proof. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | 61/61 pass. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/runtime-recovery.test.ts test/runtime-store.test.ts` | 20/20 pass. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/delivery.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts` | 35/35 pass. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test test/settled-completion.test.ts` | 24/24 pass. |
| `npm run typecheck && npm run lint && git diff --check` | Pass; existing Git LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| `git diff --no-index --check -- /dev/null pi-extension/subagents/dispatch-recovery.ts`; same command for `test/dispatch-recovery.test.ts` and `docs/plans/backlog-p1-repair-round-3.md` | No whitespace diagnostics; exit 1 for differences from `/dev/null`, with LF/CRLF warnings. |

**140/140 targeted tests passed**, zero skips or cancellations; focused tests already counted in that total. No full `npm test`, authenticated/live Pi-herdr or Linux test; no P3, public ready-order v2, commit, push, deployment, or parent-plan mutation.

## Version for independent review #5

Base `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. SHA-256 comparison to the pre-round dirty/untracked snapshot identified only the four marked paths as modified; this report is new. Git-filtered `git hash-object <path>` IDs for the tested source/test snapshot:

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` | `fc785fbfa62e2e90ee9c840aba37d0e2eaf4bca3` |
| `pi-extension/subagents/dispatch-recovery.ts` (changed, pre-existing untracked file) | `b66261a474e387d5746f9a8451fcf5be08de3a6a` |
| `pi-extension/subagents/plan-runtime.ts` (changed) | `684ce7ff36c553b643137119467c4ff61e618afe` |
| `pi-extension/subagents/runtime-recovery.ts` | `28ae3c8579ff84d3dfb80b40e70bcbb0ca8b9fa2` |
| `pi-extension/subagents/delivery.ts` | `a572387b59ead9945f21433bf0a6d84236b5cd9f` |
| `pi-extension/subagents/index.ts` (changed) | `db1349fa2f5809a9e8fb1ec3e28621f21f4cb1f4` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` (changed, pre-existing untracked file) | `05daf0976c8e587e52d534b6a886b1a03cfa55d3` |
| `test/dispatch-failure.test.ts` | `f9ca1589e29dddd4932ff40010ebe2c44416f6d6` |
| `test/runtime-store.test.ts` | `e745f9345043f0bfc0fda9578c491845bf1156d5` |
| `test/runtime-recovery.test.ts` | `ba6d999763ba0151766e2d50cbd04044a6ddcb46` |
| `test/plan-runtime.test.ts` | `f6e4aa05f75241097b4ed0aef460020cbf4d0a84` |
| `test/delivery.test.ts` | `b7b2ce4652b89e35c8d9fe60c787cc3ac555dd1a` |
| `test/architecture-authority.test.ts` | `ddad6a284dc15db242368f22611e5d5cceda6167` |
| `test/automated-plan-boundary.test.ts` | `0508de157fd4c80e0a1bab293a8b8f1975046c17` |
| `test/automated-state-boundary.test.ts` | `39de3ddae2ea8c4afc17beffb8fe040975665c61` |
| `test/plan-import-publication.test.ts` | `dd8a5733e06079be6779ce538d96cd8a3fffc204` |
| `test/settled-completion.test.ts` | `4c304c6fd4e9025d36dbb631b33ac08fcac4daf2` |

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=f48e2c48-2713-4a6f-bd27-2f91c4259cf6`, `runId=d578a724-d81e-4523-8002-258d2724a5e7`.
