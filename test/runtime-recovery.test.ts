import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeStore, atomicRuntimeWrite } from "../pi-extension/subagents/runtime-store.ts";
import { probeProcess } from "../pi-extension/subagents/process-identity.ts";
import { verifyRecoveryChild } from "../pi-extension/subagents/recovery-identity.ts";
import { reconcileRuntime } from "../pi-extension/subagents/runtime-recovery.ts";
import { canonicalSessionPath, releaseSession, sessionOwners } from "../pi-extension/subagents/ownership.ts";
import { runCompletionFile } from "../pi-extension/subagents/run-artifacts.ts";

const moduleURL = (file: string) => pathToFileURL(resolve(`pi-extension/subagents/${file}.ts`)).href;
const pause = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "fresh process startup timed out"); await pause(); }
}
const processSupported = probeProcess(process.pid).kind === "present";

function hostCode(dir: string, branch: string, file = "parent.jsonl", headerId = "parent") {
  return `import extension from ${JSON.stringify(moduleURL("index"))};
    import fs from 'node:fs';
    const handlers=new Map(); const delivered=[]; const notices=[];
    const branch=${branch};
    const pi=new Proxy({}, {get:(_,key)=>key==='on'?(name,fn)=>handlers.set(name,fn):key==='getAllTools'?()=>[]:
      key==='sendMessage'?(message)=>delivered.push(message.details.eventId):()=>{}});
    const ctx={hasUI:true,scopedModels:[],modelRegistry:{getAvailable:()=>[]},ui:{notify:(m)=>notices.push(m)},
      sessionManager:{getHeader:()=>({id:${JSON.stringify(headerId)}}),getSessionFile:()=>${JSON.stringify(join(dir, file))},getSessionDir:()=>${JSON.stringify(dir)},getBranch:()=>branch}};
    extension(pi); await handlers.get('session_start')({reason:'startup'},ctx);
    await handlers.get('session_start')({reason:'startup'},ctx);
    const runtime=globalThis[Symbol.for('pi-subagents/runtime')];
    fs.writeFileSync(${JSON.stringify(join(dir, "observed.json"))},JSON.stringify({delivered,notices,error:runtime.recoveryError,runs:runtime.runningSubagents.size,owners:[...((await import(${JSON.stringify(moduleURL("ownership"))})).sessionOwners.values())]}));
    handlers.get('session_shutdown')({reason:'quit'},ctx);`;
}
function execute(code: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

test("fresh parent processes recover pending outbox, park UNKNOWN, honor tombstones and never launch", { skip: !processSupported }, () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-restart-"));
  try {
    const parent = { sessionFile: canonicalSessionPath(join(dir, "parent.jsonl")), headerId: "parent", branchToken: "token", checkpoint: "checkpoint" };
    writeFileSync(parent.sessionFile, JSON.stringify({ type: "session", id: "parent" }) + "\n");
    const branch = [{ id: "checkpoint", type: "custom", customType: "subagent-custody", data: { branchToken: "token" } }];
    const directory = join(dir, "artifacts", "parent", "subagent-runtime");
    // Actual process exits without releasing its lease: this is not module reload.
    execute(`import {RuntimeStore} from ${JSON.stringify(moduleURL("runtime-store"))};
      const s=new RuntimeStore(${JSON.stringify(directory)},${JSON.stringify(parent)});
      s.prepare({id:'run',sessionFile:${JSON.stringify(join(dir, "child.jsonl"))},name:'child',task:'work',startTime:1,cli:'pi',surface:'reused-pane'});
      s.phase('run','dispatch-intent');
      for(const status of ['pending','dispatching','handedOff']){const id='subagent:run:completion:'+status;s.enqueue(id,'run',{message:{customType:'subagent_result',content:status,details:{eventId:id}},options:{triggerTurn:true,deliverAs:'steer'}});if(status!=='pending')s.delivery(id,status);}`);
    execute(hostCode(dir, JSON.stringify(branch)));
    let observed = JSON.parse(readFileSync(join(dir, "observed.json"), "utf8"));
    assert.deepEqual(observed.delivered, ["subagent:run:completion:pending"]);
    assert.equal(observed.runs, 0, "recovered terminal controls are not installed");
    assert.equal(observed.owners[0].surface, undefined, "old pane is not authoritative");
    assert.equal(observed.owners[0].dispatched, true);
    assert.equal(observed.error, undefined);
    execute(hostCode(dir, JSON.stringify(branch)));
    observed = JSON.parse(readFileSync(join(dir, "observed.json"), "utf8"));
    assert.deepEqual(observed.delivered, [], "repeated startup cannot replay tombstones or UNKNOWN");
    // A matching message on the active branch is positive handoff evidence.
    branch.push({ type: "custom_message", customType: "subagent_result", content: "dispatching", details: { eventId: "subagent:run:completion:dispatching" } } as any);
    execute(hostCode(dir, JSON.stringify(branch)));
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.outbox["subagent:run:completion:dispatching"].status, "handedOff");
    for (const [file, header] of [["copied.jsonl", "parent"], ["parent.jsonl", "foreign"]]) {
      execute(hostCode(dir, JSON.stringify(branch), file, header));
      observed = JSON.parse(readFileSync(join(dir, "observed.json"), "utf8"));
      if (header === "parent") assert.match(observed.error, /mismatch/);
      assert.deepEqual(observed.delivered, []);
    }
    execute(hostCode(dir, "[]"));
    observed = JSON.parse(readFileSync(join(dir, "observed.json"), "utf8"));
    assert.match(observed.error, /active branch mismatch/); assert.deepEqual(observed.delivered, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real child process answers fresh generation challenges; stale nonce/PID and custody loss fail closed", { skip: !processSupported }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-child-"));
  const session = canonicalSessionPath(join(dir, "child.jsonl"));
  writeFileSync(session, JSON.stringify({ type: "session", id: "child" }) + "\n");
  const base = runCompletionFile(session, "run");
  const code = `import {registerRecoveryIdentity} from ${JSON.stringify(moduleURL("recovery-identity"))};
    process.env.PI_SUBAGENT_ID='run';process.env.PI_SUBAGENT_SESSION=${JSON.stringify(session)};
    const handlers=new Map();registerRecoveryIdentity({on:(name,fn)=>handlers.set(name,fn)});
    handlers.get('session_start')({}, {sessionManager:{getHeader:()=>({id:'child'}),getSessionFile:()=>${JSON.stringify(session)}}});
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  try {
    await until(() => existsSync(`${base}.identity.json`));
    assert.equal(await verifyRecoveryChild(session, "run", "generation-a", () => true), "verified-live");
    const stale = JSON.parse(readFileSync(`${base}.response.json`, "utf8"));
    assert.equal(stale.generation, "generation-a");
    assert.equal(await verifyRecoveryChild(session, "run", "generation-b", () => true), "verified-live");
    const fresh = JSON.parse(readFileSync(`${base}.response.json`, "utf8"));
    assert.notEqual(fresh.challenge, stale.challenge);
    let current = true;
    const pending = verifyRecoveryChild(session, "run", "lost-generation", () => current);
    current = false;
    assert.equal(await pending, "unverified");
    const identity = JSON.parse(readFileSync(`${base}.identity.json`, "utf8"));
    atomicRuntimeWrite(`${base}.identity.json`, { ...identity, process: { ...identity.process, birth: "reused-pid" } });
    assert.equal(await verifyRecoveryChild(session, "run", "reused", () => true), "exited");
    atomicRuntimeWrite(`${base}.identity.json`, { ...identity, nonce: "stale-process-nonce" });
    assert.equal(await verifyRecoveryChild(session, "run", "stale", () => true, 150), "unverified");
    atomicRuntimeWrite(`${base}.identity.json`, identity);
    const store = new RuntimeStore(join(dir, "runtime"), { sessionFile: "parent", headerId: "parent", branchToken: "branch", checkpoint: "checkpoint" });
    store.prepare({ id: "run", sessionFile: session, cli: "pi", surface: "reused-pane", name: "child", task: "task", startTime: 1 });
    const recovering = reconcileRuntime(store, (run, event) => {
      const id = `subagent:${run.id}:completion:${event.eventId}`;
      store.enqueue(id, run.id, { message: { customType: "subagent_result", content: event.summary!, details: { eventId: id } },
        options: { triggerTurn: true, deliverAs: "steer" } });
    }, () => true);
    assert.equal(sessionOwners.get(session)?.runId, "run", "reservation is synchronous before probing");
    assert.equal(sessionOwners.get(session)?.surface, undefined);
    const stop = await recovering;
    assert.match(store.snapshot().runs.run.reconciliation!, /verified-live: artifact-only/);
    mkdirSync(`${base}.events`, { recursive: true });
    for (const eventId of ["one", "two"]) {
      writeFileSync(`${base}.events/${eventId}.json`, JSON.stringify({ type: "done", runId: "run", eventId, summary: eventId, keepOpen: true }));
    }
    await until(() => store.snapshot().runs.run.eventCursor.length === 2);
    assert.equal(Object.keys(store.snapshot().outbox).length, 2, "authenticated artifact-only supervisor harvests later turns");
    stop(); store.close(); releaseSession(session, "run");
  } finally {
    child.kill(); await new Promise((r) => child.once("exit", r));
    releaseSession(session, "run"); rmSync(dir, { recursive: true, force: true });
  }
});

test("live/legacy lease and stale cursor cannot be replaced by a second parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-lease-"));
  const parent = { sessionFile: "parent", headerId: "parent", branchToken: "branch", checkpoint: "checkpoint" };
  try {
    const store = new RuntimeStore(dir, parent);
    execute(`import {RuntimeStore} from ${JSON.stringify(moduleURL("runtime-store"))};let failed=false;try{new RuntimeStore(${JSON.stringify(dir)},${JSON.stringify(parent)})}catch{failed=true}if(!failed)process.exit(2);`);
    store.prepare({ id: "run", sessionFile: "child", name: "child", task: "task", startTime: 1 });
    const file = join(dir, "manifest.json"); const manifest = store.snapshot();
    manifest.runs.run.eventCursor.push("missing-event"); atomicRuntimeWrite(file, manifest);
    assert.throws(() => store.assertCustody(), /cursor/);
    manifest.runs.run.eventCursor = []; atomicRuntimeWrite(file, manifest); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
