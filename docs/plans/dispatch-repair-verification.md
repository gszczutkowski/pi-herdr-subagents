# Dispatch repair verification

- A restarted bare dispatch intent reports `dispatch-unknown` and blocks the registered `subagent_resume` tool before terminal send. The regression checks unrelated completion in the same session, launch-failure envelopes at each handoff stage, and same-run completion while delivery is still pending. Fresh generation-bound child challenges separately verify that historical dispatch proof survives a later inconclusive liveness observation.
- A run-specific `BINDING_MISMATCH` no longer pauses unrelated unbound launches. The registered `subagent` tool crosses the mocked transport once in this case. Restart tests verify that only the exact accepted record survives multiple writer generations; modified and unadopted records fail closed, and restoring the original binding allows one canonical publication. Journal and adoption I/O faults still prevent rotation.
- `node --test test/dispatch-failure.test.ts test/dispatch-recovery.test.ts test/runtime-recovery.test.ts test/runtime-store.test.ts test/runtime-manifest-windows.test.ts test/recovery-report.test.ts test/resume-safety.test.ts test/ownership-execute.test.ts test/live-continuation.test.ts test/architecture-authority.test.ts test/architecture-presentation.test.ts` — PASS, 103 tests.
- `npm run typecheck`, `npm run lint`, `git diff --check` — PASS.
- Independent reviewer: PASS, no confirmed P1/P2 defects. The reviewer checked the dispatch proof and resume guards, retained-evidence rotation and publication, custody, and error classification. They independently reran the same 103 targeted tests, typecheck, lint, and `git diff --check` successfully. Review run: `5c8c963a-35ac-42e8-9d39-101af7864334`.
- Parent verification: `npm run typecheck && npm run lint && git diff --check && npm test` — PASS, 822 passed, 0 skipped, 0 failed (Git line-ending advisory only). Live herdr terminal E2E was not run.

Git blob IDs for the reviewed implementation and main regression files (`git hash-object`):

| File | Blob ID |
| --- | --- |
| `pi-extension/subagents/dispatch-recovery.ts` | `efd11af79ffe5adc81d7674e24c292d6d35382c4` |
| `pi-extension/subagents/index.ts` | `aefe23db07ffbf33ca8cd96dd7c265590650390e` |
| `pi-extension/subagents/runtime-store.ts` | `dce4de0a0c439af916d74bb5820944f60f59e234` |
| `pi-extension/subagents/runtime-recovery.ts` | `cd883f8a8cbc3e1b6c8da9f9ba5bc70f744f2dae` |
| `test/dispatch-failure.test.ts` | `541b02871f7b3192aea01121aa239900f3d3ed86` |
| `test/dispatch-recovery.test.ts` | `e38bada678b90eb12ce844178c03431fd85c831b` |
| `test/runtime-recovery.test.ts` | `ba6d999763ba0151766e2d50cbd04044a6ddcb46` |
| `test/recovery-report.test.ts` | `1a368fe47450d96a625bb4a855d6939f0fbacd8e` |
