import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { RuntimeStore, readRuntimeManifest } from "../pi-extension/subagents/runtime-store.ts";
import { createDeliveryState, enqueueDelivery, flushDeliveries } from "../pi-extension/subagents/delivery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

const parent = { sessionFile: "parent.jsonl", headerId: "parent", branchToken: "branch", checkpoint: "checkpoint" };
const run = { id: "run", sessionFile: "child.jsonl", name: "child", task: "task", startTime: 1 };
function fixture(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-store-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("small selectors avoid manifest snapshots, expose immutable membership, and retain evidence across reopen", () => fixture((dir) => {
  let store = new RuntimeStore(dir, parent); store.prepare(run);
  const id = "subagent:run:completion:first";
  store.enqueue(id, run.id, { message: { customType: "subagent_result", content: "immutable", details: { eventId: id } },
    options: { triggerTurn: true, deliverAs: "steer" } });
  const snapshot = store.snapshot.bind(store);
  store.snapshot = () => { throw new Error("selector cloned full manifest"); };
  const membership = store.committedEventIds(run.id);
  assert.equal(membership.size, 1); assert.equal(membership.has(id), true);
  assert.equal((membership as any).add, undefined);
  const selected = store.getRun(run.id)!; selected.task = "mutated";
  assert.equal(store.getRun(run.id)!.task, run.task);
  assert.equal(store.runBinding(run.id), undefined);
  const event = store.getEvent(id)!; event.envelope.message.content = "mutated";
  assert.equal(store.getEvent(id)!.envelope.message.content, "immutable");
  assert.deepEqual(store.outboxIds(), [id]); assert.equal(store.listRuns().length, 1);
  store.snapshot = snapshot; store.close(); store = new RuntimeStore(dir, parent);
  assert.equal(store.committedEventIds(run.id).has(id), true); store.close();
}));

test("append-only outbox selector slices cached IDs without enumerating/cloning history and advances only after durable commits", () => fixture((dir) => {
  let store = new RuntimeStore(dir, parent); store.prepare(run);
  const manifest = store.snapshot(); store.close();
  const envelope = (id: string) => ({ message: { customType: "subagent_result", content: id, details: { eventId: id } },
    options: { triggerTurn: true as const, deliverAs: "steer" as const } });
  for (let n = 0; n < 1000; n++) {
    const id = `historical-${n}`;
    manifest.runs.run.eventCursor.push(id);
    manifest.outbox[id] = { runId: run.id, envelope: envelope(id), status: "handedOff" };
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  store = new RuntimeStore(dir, parent);
  const keys = Object.keys, clone = globalThis.structuredClone;
  try {
    Object.keys = () => { throw new Error("enumerated historical outbox"); };
    globalThis.structuredClone = () => { throw new Error("cloned historical outbox"); };
    assert.deepEqual(store.outboxIdsSince(1000), []);
    assert.deepEqual(store.outboxIdsSince(999), ["historical-999"]);
    const selected = store.outboxIdsSince() as string[]; selected.push("external mutation");
    assert.equal(store.outboxIdsSince().length, 1000);
  } finally { Object.keys = keys; globalThis.structuredClone = clone; }
  for (const invalid of [-1, 0.5, NaN, Infinity]) assert.throws(() => store.outboxIdsSince(invalid), /offset/i);
  store.enqueue("new", run.id, envelope("new")); store.enqueue("new", run.id, envelope("new"));
  assert.deepEqual(store.outboxIdsSince(1000), ["new"]);
  store.isCurrent = () => false;
  assert.throws(() => store.enqueue("failed-enqueue", run.id, envelope("failed-enqueue")), /custody/);
  assert.deepEqual(store.outboxIdsSince(1001), []);
  const failure = { ...run, id: "failed-dispatch", sessionFile: "failed.jsonl" };
  store.recordDispatchFailure(failure, envelope("dispatch-failure"));
  store.recordDispatchFailure(failure, envelope("dispatch-failure"));
  assert.deepEqual(store.outboxIdsSince(1001), ["dispatch-failure"]);
  store.close();
  assert.throws(() => store.recordDispatchFailure(failure, envelope("failed-write")), /custody/);
  assert.deepEqual(store.outboxIdsSince(1002), []);
  store = new RuntimeStore(dir, parent);
  assert.deepEqual(store.outboxIdsSince(1000), ["new", "dispatch-failure"]);
  assert.equal(store.getEvent("dispatch-failure")!.status, "handedOff"); store.close();
}));

test("versioned run and immutable multi-turn envelopes survive a fresh process", () => fixture((dir) => {
  const store = new RuntimeStore(dir, parent);
  store.prepare(run);
  store.phase("run", "dispatch-intent");
  store.phase("run", "supervised");
  const state = createDeliveryState(); state.store = store;
  for (const turn of ["first", "second"]) {
    enqueueDelivery(state, { id: "run", lifecycle: createLifecycle(1) },
      { customType: "subagent_result", content: turn, display: true }, () => {}, turn);
  }
  assert.equal(Object.keys(store.snapshot().outbox).length, 2);
  store.close();
  const url = pathToFileURL(resolve("pi-extension/subagents/runtime-store.ts")).href;
  const code = `import {RuntimeStore} from ${JSON.stringify(url)}; const s=new RuntimeStore(${JSON.stringify(dir)},${JSON.stringify(parent)}); const m=s.snapshot(); if(Object.keys(m.outbox).length!==2 || m.runs.run.eventCursor.length!==2) process.exit(2); s.close();`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
}));

test("dispatch intent precedes void API; tombstone precedes callbacks", () => fixture((dir) => {
  const store = new RuntimeStore(dir, parent); store.prepare(run);
  const state = createDeliveryState(); state.store = store;
  state.api = { sendMessage() { assert.equal(Object.values(readRuntimeManifest(dir)!.outbox)[0].status, "dispatching"); } };
  let called = false;
  enqueueDelivery(state, { id: "run", lifecycle: createLifecycle(1) },
    { customType: "subagent_result", content: "result", display: true }, () => {
      assert.equal(Object.values(readRuntimeManifest(dir)!.outbox)[0].status, "handedOff"); called = true;
    });
  assert.equal(called, true); assert.equal(state.pending.size, 0); store.close();
}));

test("write failure parks delivery without sending or acknowledging", () => fixture((dir) => {
  const store = new RuntimeStore(dir, parent); store.prepare(run);
  const state = createDeliveryState(); state.store = store;
  enqueueDelivery(state, { id: "run", lifecycle: createLifecycle(1) },
    { customType: "subagent_result", content: "result", display: true }, () => assert.fail("ack"));
  store.delivery = () => { throw new Error("disk full"); };
  state.api = { sendMessage() { assert.fail("send"); } };
  flushDeliveries(state); assert.equal(state.pending.size, 1); assert.match(state.persistenceError!, /disk full/);
  assert.equal(state.timer, undefined); store.close();
}));

test("a post-send tombstone write failure never resends or acknowledges", () => fixture((dir) => {
  const store = new RuntimeStore(dir, parent); store.prepare(run);
  const state = createDeliveryState(); state.store = store;
  const original = store.delivery.bind(store);
  store.delivery = (id, status) => { if (status === "handedOff") throw new Error("disk failure after send"); original(id, status); };
  let sends = 0;
  state.api = { sendMessage() { sends++; } };
  enqueueDelivery(state, { id: "run", lifecycle: createLifecycle(1) },
    { customType: "subagent_result", content: "result", display: true }, () => assert.fail("ack"));
  flushDeliveries(state);
  assert.equal(sends, 1); assert.equal(state.pending.size, 1);
  assert.equal(Object.values(store.snapshot().outbox)[0].status, "dispatching"); store.close();
}));

test("unknown dispatch survives reopen; tombstones cannot be replayed", () => fixture((dir) => {
  let store = new RuntimeStore(dir, parent); store.prepare(run);
  const state = createDeliveryState(); state.store = store;
  enqueueDelivery(state, { id: "run", lifecycle: createLifecycle(1) },
    { customType: "subagent_result", content: "result", display: true }, () => {});
  const id = Object.keys(store.snapshot().outbox)[0];
  store.delivery(id, "dispatching"); store.close(); store = new RuntimeStore(dir, parent);
  assert.equal(store.snapshot().outbox[id].status, "dispatching");
  store.delivery(id, "handedOff"); assert.throws(() => store.delivery(id, "pending"), /tombstone/); store.close();
}));

test("confirmed lineage loss can persist revocation but never bypass writer fencing", () => fixture((dir) => {
  const store = new RuntimeStore(dir, parent); store.prepare(run);
  store.isCurrent = () => false;
  assert.throws(() => store.phase(run.id, "supervised"), /branch lost custody/);
  store.pauseCustody("confirmed lineage change");
  assert.equal(readRuntimeManifest(dir)!.custodyPaused, "confirmed lineage change");
  assert.throws(() => store.phase(run.id, "supervised"), /branch lost custody/);
  const file = join(dir, "manifest.json");
  const valid = readFileSync(file, "utf8");
  const stale = JSON.parse(valid); stale.revision++;
  writeFileSync(file, JSON.stringify(stale));
  assert.throws(() => store.pauseCustody("stale writer"), /Stale/);
  writeFileSync(file, valid); store.close();
  assert.throws(() => store.pauseCustody("closed writer"), /lost custody/);
}));

test("unchanged custody checks avoid payload rereads but ctime detects same-size same-revision corruption", () => fixture((dir) => {
  const url = pathToFileURL(resolve("pi-extension/subagents/runtime-store.ts")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    let reads=0;const read=fs.readFileSync;fs.readFileSync=(...args)=>{reads++;return read(...args)};syncBuiltinESMExports();
    const {RuntimeStore}=await import(${JSON.stringify(url)});
    const dir=${JSON.stringify(dir)},s=new RuntimeStore(dir,${JSON.stringify(parent)});s.prepare(${JSON.stringify(run)});
    s.assertCustody();reads=0;for(let n=0;n<100;n++)s.assertCustody();assert.equal(reads,0,'unchanged custody checks need metadata only');
    const file=dir+'/manifest.json',original=read(file,'utf8'),before=fs.statSync(file);
    fs.writeFileSync(file,original.replace('"task":"task"','"task":"EDIT"'));fs.utimesSync(file,before.atime,before.mtime);
    assert.throws(()=>s.assertCustody(),/changed|Stale|corrupt/i);
    fs.writeFileSync(file,'{');assert.throws(()=>s.assertCustody());
    fs.writeFileSync(file,original);s.assertCustody();s.close();
  `], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
}));

test("manifest replacement retries only the same closed temp, with bounded Windows backoff and fresh custody", () => fixture((dir) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    const {RuntimeStore}=await import(${JSON.stringify(pathToFileURL(resolve("pi-extension/subagents/runtime-store.ts")).href)});
    const root=${JSON.stringify(dir)},parent=${JSON.stringify(parent)},run=${JSON.stringify(run)};
    const rename=fs.renameSync,open=fs.openSync,close=fs.closeSync,remove=fs.rmSync;
    let fault,paths=[],waits=[],opened=0,closed=0,hook=()=>{},cleanupFails=false;
    fs.openSync=(...args)=>{if(String(args[0]).endsWith('.tmp'))opened++;return open(...args)};
    fs.closeSync=(...args)=>{closed++;return close(...args)};
    fs.rmSync=(path,...args)=>{if(cleanupFails&&String(path).endsWith('.tmp'))throw new Error('cleanup failure');return remove(path,...args)};
    fs.renameSync=(from,to)=>{
      if(fault&&String(to).endsWith('manifest.json')){
        assert.equal(opened,1);assert.equal(closed,1,'temp must be closed before rename');
        paths.push(String(from));assert.ok(fs.existsSync(from));
        if(paths.length<=fault.count)throw Object.assign(new Error('rename blocked'),{code:fault.code});
      }
      return rename(from,to);
    };syncBuiltinESMExports();
    Atomics.wait=(_a,_i,_v,ms)=>{waits.push(ms);hook();return 'timed-out'};
    let serial=0;const platform=process.platform;
    for(const mode of ['prepare','failure'])for(const scenario of ['transient','busy','permanent','linux','darwin','denied','space','branch','writer','revision','generation','changed','missing','corrupt','cleanup']){
      Object.defineProperty(process,'platform',{value:platform,configurable:true});
      // Construct using the real platform; only the replacement policy is simulated.
      fault=undefined;const dir=root+'/'+serial++;const s=new RuntimeStore(dir,parent);
      const file=dir+'/manifest.json',before=fs.readFileSync(file,'utf8'),snapshot=s.snapshot();
      const owner=dir+'/writer/owner.json',ownerBefore=fs.readFileSync(owner,'utf8');
      paths=[];waits=[];opened=0;closed=0;hook=()=>{};
      Object.defineProperty(process,'platform',{value:scenario==='linux'?'linux':scenario==='darwin'?'darwin':'win32',configurable:true});
      fault={count:['transient','busy'].includes(scenario)?2:99,code:scenario==='busy'?'EBUSY':scenario==='denied'?'EACCES':scenario==='space'?'ENOSPC':'EPERM'};
      if(scenario==='branch')hook=()=>{s.isCurrent=()=>false};
      if(scenario==='writer')hook=()=>fs.writeFileSync(owner,JSON.stringify({generation:'other'}));
      if(['revision','generation','changed','missing','corrupt'].includes(scenario))hook=()=>{
        const disk=JSON.parse(before);
        if(scenario==='revision')disk.revision++;
        if(scenario==='generation')disk.generation='other';
        if(scenario==='changed')disk.custodyPaused='external';
        if(scenario==='missing')fs.rmSync(file);else fs.writeFileSync(file,scenario==='corrupt'?'{':JSON.stringify(disk));
      };
      cleanupFails=scenario==='cleanup';
      const operation=()=>mode==='prepare'?s.prepare(run):s.recordDispatchFailure(run,{message:{customType:'subagent_result',content:'failed',details:{eventId:'failure'}},options:{triggerTurn:true,deliverAs:'steer'}});
      const succeeds=['transient','busy'].includes(scenario)||(scenario==='branch'&&mode==='failure');
      // Failure evidence deliberately uses writer custody, not active-branch custody.
      if(scenario==='branch'&&mode==='failure')fault.count=2;
      if(succeeds){operation();assert.equal(s.snapshot().revision,snapshot.revision+1);assert.equal(paths.length,3);assert.deepEqual(waits,[10,30]);}
      else {
        assert.throws(operation,scenario==='cleanup'?/rename blocked/:undefined);
        assert.deepEqual(s.snapshot(),snapshot,'failed publication cannot update memory');assert.deepEqual(s.outboxIds(),[]);
        if(!['revision','generation','changed','missing','corrupt'].includes(scenario))assert.equal(fs.readFileSync(file,'utf8'),before);
        const immediate=['linux','darwin','denied','space'].includes(scenario);
        const fenced=['branch','writer','revision','generation','changed','missing','corrupt'].includes(scenario);
        assert.equal(paths.length,immediate||fenced?1:4);assert.deepEqual(waits,immediate?[]:fenced?[10]:[10,30,60]);
      }
      assert.equal(new Set(paths).size,1,'must retry identical temporary file');
      cleanupFails=false;fault=undefined;hook=()=>{};s.isCurrent=undefined;
      fs.writeFileSync(owner,ownerBefore);
      if(!succeeds)fs.writeFileSync(file,before);
      s.close();
      if(scenario!=='cleanup')assert.equal(fs.readdirSync(dir).filter(f=>f.endsWith('.tmp')).length,0);
    }
  `], { encoding: "utf8", timeout: 90000 });
  assert.equal(result.status, 0, result.stderr);
}));

test("lease, stale revisions, corruption and future schemas fail closed", () => fixture((dir) => {
  const store = new RuntimeStore(dir, parent);
  assert.throws(() => new RuntimeStore(dir, parent));
  const file = join(dir, "manifest.json");
  const valid = readFileSync(file, "utf8");
  const changed = JSON.parse(valid); changed.revision++;
  writeFileSync(file, JSON.stringify(changed)); assert.throws(() => store.prepare(run), /Stale/);
  writeFileSync(file, valid); store.close();
  for (const bad of ["{", JSON.stringify({ ...JSON.parse(valid), schema: 99 })]) {
    writeFileSync(file, bad); assert.throws(() => new RuntimeStore(dir, parent));
    assert.equal(readFileSync(file, "utf8"), bad);
  }
}));
