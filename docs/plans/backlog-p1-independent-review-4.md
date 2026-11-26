# Backlog P1 — independent review #4 (after repair round 2)

**VERDICT: CHANGES_REQUIRED.** The empty-error publication/restart regressions and the session-binding fix pass. Fresh spawn detects a live journal read failure at both requested transport gates, but an authoritative reread inside explicit reconciliation can still lose the observed storage fault. No acceptance or plan change made.

## Finding

**Medium — the reconciliation supervisor’s journal reread drops a live `EIO` instead of latching it.** [`index.ts:574–583,608–618,1983–1996`](../../pi-extension/subagents/index.ts#L574); the same disposition reader is used during [startup restoration](../../pi-extension/subagents/index.ts#L788).

- **Trigger:** With a current owned store and recovered supervisor, retain a schema-valid side journal for a committed intent whose `startedAt` disagrees with the durable run. Run `subagents_reconcile`. The initial metadata pass reads the journal and reports the logical conflict. Inject a single `EIO` opening that same journal on the next read, when `readDispatchDisposition` builds the supervisor input; all earlier and later reads succeed.
- **Evidence:** In an independent mocked probe, the read failed exactly once; the public report omitted `EIO`, and `runtime.dispatchRepair.storeError` remained unset. The original journal bytes, reservation, plan and outbox were unchanged; reconciliation itself used zero panes/sends. With no further reconcile, the next explicit independent spawn created one pane, sent once and recorded a distinct `supervised` run. The control moved the identical one-shot fault to `readRecoveryView`: it reported `EIO`, latched the writer, and the same spawn was refused with zero panes/sends. This is not replay of the original run or a claim that a still-unreadable journal escapes the fresh gate.
- **Cause/impact:** `readDispatchDisposition` calls the raw reader and uses its `storeError` only to empty the unsent set. It loses the store-wide error before the caller’s `assertStorageAvailable`, so the already-observed failure does not require a clean explicit reconciliation before new transport. The later recovery view cannot restore a one-shot error it never saw. An ordinary readable per-run mismatch should still remain local; it is the independently observed read fault that must latch.
- **Smallest correction:** Route this reread through the current-writer fault latch and check the result before restoring/reconciling the supervisor and resuming delivery. Alternatively, eliminate the second read and derive the disposition from one verified reconciliation view. Add a one-shot fault test at this boundary: report a storage pause and refuse independent spawn and resume until a clean explicit reconciliation, while continuing to allow both under a readable run-local mismatch alone.

## Verified behavior

- The shared `isAfterIntentFailure` predicate rejects empty `details.error` for both canonical publication and recovery. The publication fixture leaves manifest bytes and plan unchanged and accepts a nonempty control. The previously persisted malformed sole tombstone is quarantined at restart and through direct/callback/turn/explicit imports; it creates no result or review state, does not notify the parent, and retains the original reservation. Pending/dispatching/mixed markers and malformed cursors with ordinary siblings remain quarantined. Ordinary bound pending results still project independently of notification.
- Both live and startup tests vary only the disputed journal `sessionFile`: the committed run’s original session remains blocked and reserved, the unrelated session named solely in the journal resumes once on explicit request, and the journal survives rotation without being adopted by the new writer. The ownerless control remains blocked; independent fresh spawn under the readable run-local conflict also passes.
- The original persistent `EIO` cases pass: before fresh spawn, after saved-session preflight discovers it, and during pane setup. The preflight cases create no pane; the setup case sends nothing and leaves no committed intent. A same-writer reload does not clear these observed faults. Explicit clean repair imports only the original failure once and allows a distinct explicit launch. The finding concerns the separate supervisor-disposition read, not these gates.
- The final synchronous profile/transcript check remains after committed intent and before terminal transport. Tested canonical and delayed journal recovery with/without a supervisor, exact binding and generations, bare intent remaining unknown, duplicate reconcile, contradictory evidence retention, no notification/replay, and separate explicit launches. Reviewed durable cursor/reservation logic, startup and explicit supervisor paths, plan projection and delivery restoration. Native Pi tests exercised local session behavior with synthetic inputs; dispatch probes used mocked terminal calls.

## Independent checks

Windows, Node `v24.21.0`, npm `11.19.0`. These are this review’s checks, not the worker’s results.

| Exact command | Result |
| --- | --- |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | **57/57 pass**. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/runtime-recovery.test.ts test/runtime-store.test.ts test/delivery.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts test/settled-completion.test.ts` | **79/79 pass**. |
| `npm run typecheck && npm run lint && git diff --check` | Pass; existing `test/dispatch-failure.test.ts` LF/CRLF warning. |
| `git diff --no-index --check -- /dev/null pi-extension/subagents/dispatch-recovery.ts` and `git diff --no-index --check -- /dev/null test/dispatch-recovery.test.ts` | No whitespace diagnostics; exit 1 for new-file differences, with LF/CRLF warnings. |
| Stdin probe below | **2/2 diagnostic assertions passed**: reproduced the finding and confirmed the read-only control. An exploratory run failed its control assertion due to incorrectly escaped literal parentheses; corrected probe below. |

**136/136 permanent tests passed**, zero skips/cancellations. These passes do not cover the new read timing. No full `npm test`, authenticated Pi/herdr, Linux, or public ready-order v2 verification; no P3 work. Existing dirty/untracked changes were preserved. Only this report was written to the worktree.

## Reviewed version

Base `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. Before/after `git hash-object <path>` matches all 21 source/test blobs in the repair round 2 report. Only `index.ts` and `test/dispatch-recovery.test.ts` differ versus the hashes in review #2. This attributes the observation to the reviewed snapshot; it does not reconstruct or assign changes from the older uncommitted P1 worktree.

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` | `fc785fbfa62e2e90ee9c840aba37d0e2eaf4bca3` |
| `pi-extension/subagents/dispatch-recovery.ts` | `4c190eca6aa7492fef71d077290d09307700fb41` |
| `pi-extension/subagents/plan-runtime.ts` | `1879384b0cebb7819d7ea47e7519f2b1fef3888c` |
| `pi-extension/subagents/runtime-recovery.ts` | `28ae3c8579ff84d3dfb80b40e70bcbb0ca8b9fa2` |
| `pi-extension/subagents/delivery.ts` | `a572387b59ead9945f21433bf0a6d84236b5cd9f` |
| `pi-extension/subagents/index.ts` | `c58aac4c78ad2fc2f4cd2ab22ef18795780ebb91` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` | `1d4fa0bbabf6cb0255cb6f34b47078a659c340eb` |
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

## Reproduction command

This diagnostic asserts the observed behavior, not the desired behavior; after a repair, its disposition branch should be updated to expect the fence.

```bash
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const fixture = readFileSync('test/dispatch-recovery.test.ts', 'utf8').split('for (const supervisor of [false, true])')[0].replaceAll('../pi-extension/', './pi-extension/');
const probe = String.raw`
for (const site of ['readDispatchDisposition', 'readRecoveryView']) test(site, async t => {
  const f = fixture(), id = randomUUID(), launched = [];
  const terminal = mockResumeTerminal(t, f.dir);
  const path = join(f.directory, 'dispatch-evidence', id + '.json');
  const open = fs.openSync;
  let armed = false, hits = 0;
  const fault = t.mock.method(fs, 'openSync', (...args) => {
    if (armed && args[0] === path && new Error().stack.includes(site)) {
      armed = false; ++hits; throw errno('EIO');
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    const binding = f.attach(id), sessionFile = savedSession(f.dir, 'probe', binding);
    const run = {...f.run(id, binding), sessionFile, cli: 'pi'};
    const previous = new RuntimeStore(f.directory, f.parent);
    previous.prepare(run); previous.commitFreshDispatch(id, sessionFile, binding); previous.close();
    await f.emit('session_start', {reason: 'startup'});
    const store = f.runtime.store, plan = f.current();
    const {record, retained} = captureDispatchEvidence(new Map(), store, {runId: id, sessionFile, binding,
      startedAt: run.startTime + 1, operation: verifyResumeImages, dispatched: false}, errno('EPERM'), errno('ENOSPC'));
    assert.equal(retained, 'file');
    armed = true;
    const report = await f.execute(site === 'readRecoveryView' ? 'subagents_recovery' : 'subagents_reconcile');
    assert.equal(hits, 1);
    assert.equal(store.getEvent(record.eventId), undefined);
    assert.equal(sessionOwners.get(sessionFile)?.runId, id);
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(record));
    assert.deepEqual(f.current(), plan);
    assert.deepEqual(terminal.counts, {panes: 0, sends: 0});
    const spawn = () => f.execute('subagent', {name: 'Independent', task: 'Synthetic work'});
    if (site === 'readRecoveryView') {
      assert.match(report.content[0].text, /EIO/);
      await assert.rejects(spawn, /Dispatch metadata write paused \(EIO\)/);
      assert.deepEqual(terminal.counts, {panes: 0, sends: 0});
    } else {
      assert.doesNotMatch(report.content[0].text, /EIO/);
      assert.equal(f.runtime.dispatchRepair?.storeError, undefined);
      const result = await spawn(); launched.push(result.details.id);
      assert.equal(store.getRun(launched[0])?.phase, 'supervised');
      assert.deepEqual(terminal.counts, {panes: 1, sends: 1});
    }
  } finally {
    fault.mock.restore(); syncBuiltinESMExports();
    try { await f.clean(id, ...launched); } finally { terminal.restore(); }
  }
});`;
const result = spawnSync(process.execPath, ['--input-type=module-typescript', '-'], {input: fixture + probe, stdio: ['pipe', 'inherit', 'inherit']});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
NODE
```

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=924a91d5-e319-4fb5-8e2b-a6d4a1069dde`, `runId=68cf769a-3b1a-4115-96f3-dcfe6fd03e1c`.
