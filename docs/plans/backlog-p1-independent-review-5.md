# Backlog P1 — independent review #5 (after final repair round)

**VERDICT: CHANGES_REQUIRED — not APPROVE.** The reported one-shot **journal** read defects are fixed on the reviewed version. Two other current-writer P1 storage faults still permit delivery, incidental plan import, or new transport without clean explicit reconciliation. Stop at the final repair-round limit; this is not plan acceptance.

## Findings

1. **Medium — the marked plan-proof path silently drops a manifest read failure.** [`dispatch-recovery.ts:419–430`](../../pi-extension/subagents/dispatch-recovery.ts#L419), [`runtime-store.ts:362–387`](../../pi-extension/subagents/runtime-store.ts#L362), [`index.ts:596–603,1936–1944,2051–2052`](../../pi-extension/subagents/index.ts#L596).
   - **Trigger:** In a started parent with an installed supervisor, publish a valid marked tombstone for a bound committed intent but do not project it yet. The commit invalidates the cached manifest stamp. During the next real `turn_end` import, inject exactly one `EIO` reading `manifest.json` from `canImportAfterIntentFailure`'s custody check. No journal or later read fails.
   - **Observed:** The first turn deferred the marked import and did not change manifest bytes or plan. The fault was not reported by `subagents_recovery`; no writer pause was latched, the supervisor stayed installed and delivery remained enabled. The next ordinary turn imported exactly one `failure` with no parent notification. With no explicit reconcile, a new independent spawn created one mocked pane, sent once, and persisted a distinct `supervised` run. The probe did not produce a false success or replay the original run.
   - **Cause / smallest correction:** `try { store.assertCustody(); } catch { return false; }` runs before the live evidence reader; it makes a physical read error indistinguishable from an ordinary deferred proof. Give the live proof caller a way to latch and report the custody I/O failure on the current writer before returning false. Keep offline proof fail-closed and readable per-run disagreement local. Regress the manifest-read variant alongside the now-passing journal-read variant.

2. **Medium — an observed dispatch-evidence pin write failure leaves delivery running and same-writer reload clears the launch fence.** [`dispatch-recovery.ts:282–295,323–329`](../../pi-extension/subagents/dispatch-recovery.ts#L282), [`index.ts:576–593,766–773,1998–2026`](../../pi-extension/subagents/index.ts#L576), [`delivery.ts:74–79,165–198`](../../pi-extension/subagents/delivery.ts#L74).
   - **Trigger:** Use a readable, schema-valid journal whose `startedAt` differs from the independently retained in-memory original. Reconcile with an existing writer/supervisor. Fail the actual `manifest.json` rename once with `ENOSPC` while pinning the exact memory copy. This is the same pin path covered at [`test/dispatch-recovery.test.ts:737–746`](../../test/dispatch-recovery.test.ts#L737), but with a real filesystem-call injection and different follow-up.
   - **Observed:** Reconciliation reported `ENOSPC` and immediately blocked a fresh spawn with zero panes/sends. The supervisor was not stopped (its timer current-check is guarded by the latch). The existing delivery API was still enabled: a synthetic ordinary completion on a separate supervised run was handed off once to the mock parent API while `storeError` still equaled `ENOSPC`. Without another explicit reconcile, `/reload` retained the same store, retried the pin, cleared the pause and allowed one independent pane/send. The original journal and reservation survived; no original result was projected or original command replayed. The failure is the delivery/launch fence, not the successful pin's evidence binding or ordinary result classification.
   - **Cause / smallest correction:** A write-side `storeError` is assigned without calling the common pause function; only `journalReadFault` prevents the same-writer startup path from clearing the fence automatically. Apply the writer pause and explicit-clear rule to actual dispatch-evidence mutation failures as well, including a successful incidental retry if that retry is retained. A clean explicit pass must restore supervision and delivery readiness; a readable conflict by itself must not pause unrelated work.

## Verified behavior and coverage

- Read the backlog and P1 checklist, historical outcome, this iteration's reviews #1, #2 and #4 and the final repair report. Reviewed the current lifecycle/terminal, runtime writer, journal, disposition, delivery and plan import paths; did not attribute earlier dirty changes to the final worker. The four changed blobs versus review #4 match the final worker's snapshot. All other listed blobs match both reviews.
- Latest repair: all four permanent one-shot journal `EIO` cases passed (explicit disposition, startup disposition, read-only recovery, and live marked plan proof). The disposition reader now latches before supervisor continuation/installation and delivery restoration; later good reads do not clear the journal pause. Verified evidence-location reporting uses the same read pass, rather than reopening to determine the location. Writer rotation remains fail-closed on startup candidate journal read/schema failures. The findings concern a separate manifest read and pin write, not regressions in those journal tests.
- Preservation: the final synchronous image gate remains after committed intent and before transport ([`index.ts:3082–3097`](../../pi-extension/subagents/index.ts#L3082), [`terminal.ts:94–98`](../../pi-extension/subagents/terminal.ts#L94)). Canonical publication and recovery share the nonempty-error predicate. The exact binding/cursor and restart tests, including empty-error, malformed marker with ordinary sibling, canonical and delayed journal, generation/custody, with and without supervisor, and bare-intent unknown all passed. So did readable conflict locality (including disputed `sessionFile`), original reservation/evidence retention, repeat reconcile with no replay, and separate explicit launch after clean repair. Genuine bound pending results still enter review independently of notification. No false result from the malformed proof was observed.
- No full `npm test`, live/authenticated terminal/provider or Linux acceptance, P3 or public ready-order v2 work. Terminal dispatch in the probes was mocked; related native test fixtures exercise offline Pi session/process behavior. No source/test edits, dependency changes, commit, push, deployment, or parent-plan mutation. Only this report was written to the worktree.

## Independent checks

Windows, Node `v24.21.0`, npm `11.19.0`. These are independently run checks, not copied worker results.

| Exact command | Result |
| --- | --- |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=1 test/dispatch-recovery.test.ts test/dispatch-failure.test.ts` | **61/61 pass** in 118.167 s on completed rerun. Initial invocation timed out at the 90 s tool limit; rerun used 300 s. |
| `env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test --test-concurrency=2 test/runtime-recovery.test.ts test/runtime-store.test.ts test/delivery.test.ts test/plan-runtime.test.ts test/architecture-authority.test.ts test/automated-plan-boundary.test.ts test/automated-state-boundary.test.ts test/plan-import-publication.test.ts test/settled-completion.test.ts` | **79/79 pass** in 126.214 s on completed rerun. Initial invocation timed out at 90 s; rerun used 300 s. |
| `npm run typecheck && npm run lint && git diff --check` | Pass; pre-existing Git LF/CRLF warning for `test/dispatch-failure.test.ts`. |
| `git diff --no-index --check -- /dev/null pi-extension/subagents/dispatch-recovery.ts`; `git diff --no-index --check -- /dev/null test/dispatch-recovery.test.ts` | No whitespace diagnostics; both exit 1 for differences from `/dev/null`, with LF/CRLF warnings. |
| Stdin reproduction below | **2/2 diagnostic probes reproduced the defects** (also 2/2 on an initial equivalent callback-based probe). These assert the observed defects, not expected product behavior. |

**140/140 permanent tests passed**, zero skips/cancellations on the completed runs. Their success does not cover the two reproduced failures.

## Reviewed version

Base `f74d605cdf2027c4c0540b33ac4eb3430bb489ce`. Before/after `git hash-object <path>` matches all 21 source/test blobs in repair round 3.

| Path | Git blob |
| --- | --- |
| `pi-extension/subagents/runtime-store.ts` | `fc785fbfa62e2e90ee9c840aba37d0e2eaf4bca3` |
| `pi-extension/subagents/dispatch-recovery.ts` | `b66261a474e387d5746f9a8451fcf5be08de3a6a` |
| `pi-extension/subagents/plan-runtime.ts` | `684ce7ff36c553b643137119467c4ff61e618afe` |
| `pi-extension/subagents/runtime-recovery.ts` | `28ae3c8579ff84d3dfb80b40e70bcbb0ca8b9fa2` |
| `pi-extension/subagents/delivery.ts` | `a572387b59ead9945f21433bf0a6d84236b5cd9f` |
| `pi-extension/subagents/index.ts` | `db1349fa2f5809a9e8fb1ec3e28621f21f4cb1f4` |
| `pi-extension/subagents/plan-store.ts` | `3990a9d75446273641661fb466622329c33c69b0` |
| `pi-extension/subagents/plan-persistence.ts` | `58fb188e5d47c8705663e96641c5db71bf6a1dd1` |
| `pi-extension/subagents/terminal.ts` | `e767fa42e2e1ca684cf4fab30d1dec0ca3f2748b` |
| `pi-extension/subagents/recovery-identity.ts` | `b257a8ce24a5b771d623a0e72ef723a93e2d3443` |
| `test/dispatch-recovery.test.ts` | `05daf0976c8e587e52d534b6a886b1a03cfa55d3` |
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

Temporary fixtures and mocked notification/terminal sinks only. Assertions describe current behavior.

```bash
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --input-type=module - <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const src = readFileSync('test/dispatch-recovery.test.ts', 'utf8');
const prefix = src.split('for (const supervisor of [false, true])')[0].replaceAll('../pi-extension/', './pi-extension/');
const envelope = src.slice(src.indexOf('function resumeIntentFailure('), src.indexOf('test("canonical after-intent publication'));
const probe = String.raw`
import { enqueueDelivery } from './pi-extension/subagents/delivery.ts';
import { createLifecycle } from './pi-extension/subagents/lifecycle.ts';
for (const pin of [false, true]) test(pin ? 'pin rename ENOSPC' : 'plan proof manifest read EIO', async t => {
  const f = fixture(), id = randomUUID(), ordinary = randomUUID(), launched = [];
  const terminal = mockResumeTerminal(t, f.dir);
  const manifest = join(f.directory, 'manifest.json');
  const site = pin ? 'retainDispatchEvidence' : 'canImportAfterIntentFailure';
  const method = pin ? 'renameSync' : 'readFileSync', original = fs[method];
  let armed = false, hits = 0;
  const fault = t.mock.method(fs, method, (...args) => {
    if (armed && args[pin ? 1 : 0] === manifest && new Error().stack.includes(site)) {
      armed = false; ++hits; throw errno(pin ? 'ENOSPC' : 'EIO');
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const binding = f.attach(id), sessionFile = savedSession(f.dir, 'original', binding);
    const run = {...f.run(id, binding), sessionFile};
    const other = {...run, id: ordinary, planTask: undefined, sessionFile: savedSession(f.dir, 'ordinary')};
    const previous = new RuntimeStore(f.directory, f.parent);
    for (const r of [run, other]) { previous.prepare(r); previous.commitFreshDispatch(r.id, r.sessionFile, r.planTask); }
    previous.phase(ordinary, 'supervised'); previous.close();
    await f.emit('session_start', {reason: 'startup'});
    const store = f.runtime.store, plan = f.current();
    const spawn = () => f.execute('subagent', {name: 'Independent', task: 'Synthetic work'});
    if (pin) {
      const {record, retained} = captureDispatchEvidence(f.runtime.dispatchEvidence ??= new Map(), store,
        {runId: id, sessionFile, binding, startedAt: run.startTime, dispatched: false, operation: verifyResumeImages}, errno('EPERM'), errno('ENOSPC'));
      assert.equal(retained, 'file');
      const path = join(f.directory, 'dispatch-evidence', id + '.json');
      const mismatch = JSON.stringify({...record, startedAt: record.startedAt + 1});
      writeFileSync(path, mismatch); armed = true;
      assert.match((await f.execute('subagents_reconcile')).content[0].text, /Storage\/custody:[\s\S]*ENOSPC/);
      assert.ok(f.runtime.stopRecovery);
      await assert.rejects(spawn, /Dispatch metadata write paused \(ENOSPC\)/);
      enqueueDelivery(f.runtime.delivery, {id: ordinary, lifecycle: createLifecycle(1)},
        {customType: 'subagent_result', display: true, content: 'Ordinary completion', details: {exitCode: 0, sessionFile: other.sessionFile}}, () => {}, 'probe');
      assert.equal(f.messages.length, 1);
      assert.equal(store.getEvent('subagent:' + ordinary + ':completion:probe')?.status, 'handedOff');
      assert.equal(f.runtime.dispatchRepair.storeError, 'ENOSPC');
      await f.reload();
      assert.equal(f.runtime.store, store);
      assert.deepEqual(store.snapshot().retainedDispatchEvidence[id], record);
      assert.equal(readFileSync(path, 'utf8'), mismatch);
      assert.equal(store.getEvent(record.eventId), undefined);
      assert.equal(sessionOwners.get(sessionFile)?.runId, id);
      assert.deepEqual(f.current(), plan);
    } else {
      const failure = resumeIntentFailure(run);
      store.recordDispatchFailure(run, failure); // invalidates the manifest stamp
      const bytes = readFileSync(manifest, 'utf8'); armed = true;
      await f.endTurn();
      assert.deepEqual(f.current(), plan);
      assert.equal(readFileSync(manifest, 'utf8'), bytes);
      assert.ok(f.runtime.stopRecovery);
      assert.ok(f.runtime.delivery.api);
      assert.doesNotMatch((await f.execute('subagents_recovery')).content[0].text, /EIO|Storage\/custody:/);
      await f.endTurn();
      assert.deepEqual(f.current().tasks[0].attempts[0].results.map(r => [r.eventId, r.kind]), [[failure.message.details.eventId, 'failure']]);
      assert.deepEqual(f.messages, []);
    }
    assert.equal(hits, 1);
    assert.equal(f.runtime.dispatchRepair?.storeError, undefined);
    assert.deepEqual(terminal.counts, {panes: 0, sends: 0});
    const result = await spawn(); launched.push(result.details.id);
    assert.notEqual(result.details.id, id);
    assert.equal(store.getRun(result.details.id)?.phase, 'supervised');
    assert.deepEqual(terminal.counts, {panes: 1, sends: 1});
  } finally {
    fault.mock.restore(); syncBuiltinESMExports();
    try { await f.clean(id, ordinary, ...launched); } finally { terminal.restore(); }
  }
});`;
const result = spawnSync(process.execPath, ['--input-type=module-typescript', '-'], {input: prefix + envelope + probe, stdio: ['pipe', 'inherit', 'inherit']});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
NODE
```

Correlation: `planId=2a44ab76-3ef1-4a92-accd-7dfe29645480`, `taskId=937a3543-7d10-4820-b950-6bb021955220`, `attemptId=f48e2c48-2713-4a6f-bd27-2f91c4259cf6`, `runId=5a02dcc7-4ebb-4d98-b562-9c55ebaae180`.
