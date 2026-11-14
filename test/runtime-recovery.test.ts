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
    const onEvidence = (run: any, event: any) => {
      const id = `subagent:${run.id}:completion:${event.eventId}`;
      store.enqueue(id, run.id, { message: { customType: "subagent_result", content: event.summary!, details: { eventId: id } },
        options: { triggerTurn: true, deliverAs: "steer" } });
    };
    const recovering = reconcileRuntime(store, onEvidence, () => true);
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
    stop();
    const resumed = await reconcileRuntime(store, onEvidence, () => true);
    assert.match(store.snapshot().runs.run.reconciliation!, /verified-live: artifact-only/);
    writeFileSync(`${base}.events/three.json`, JSON.stringify({ type: "done", runId: "run", eventId: "three", summary: "after suspension", keepOpen: true }));
    await until(() => store.snapshot().runs.run.eventCursor.length === 3);
    assert.equal(Object.keys(store.snapshot().outbox).length, 3, "same-run reservation resumes authenticated artifact supervision");
    resumed(); store.close(); releaseSession(session, "run");
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

test("durable observer preserves original settlements across reload gaps and reconciles existing store artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-reload-"));
  try {
    execute(`import extension,{observeSubagentCompletion} from ${JSON.stringify(moduleURL("index"))};
      import {RuntimeStore} from ${JSON.stringify(moduleURL("runtime-store"))};
      import {createLifecycle} from ${JSON.stringify(moduleURL("lifecycle"))};
      import {runCompletionFile} from ${JSON.stringify(moduleURL("run-artifacts"))};
      import {canonicalSessionPath} from ${JSON.stringify(moduleURL("ownership"))};
      import assert from 'node:assert/strict';import fs from 'node:fs';
      const directory=${JSON.stringify(dir)};
      const parent={sessionFile:canonicalSessionPath(directory+'/parent.jsonl'),headerId:'parent',branchToken:'token',checkpoint:'checkpoint'};
      const branch=[{id:'checkpoint',type:'custom',customType:'subagent-custody',data:{branchToken:'token'}}];
      const ctx={hasUI:false,scopedModels:[],modelRegistry:{getAvailable:()=>[]},sessionManager:{
        getHeader:()=>({id:'parent'}),getSessionFile:()=>parent.sessionFile,getSessionDir:()=>directory,getBranch:()=>branch}};
      const delivered=[];const stale=[];
      function host(messages){const handlers=new Map();extension(new Proxy({}, {get:(_,key)=>key==='on'?(n,f)=>handlers.set(n,f):key==='getAllTools'?()=>[]:key==='sendMessage'?m=>messages.push(m):()=>{}}));return handlers;}
      const old=host(stale);await old.get('session_start')({},ctx);
      const runtime=globalThis[Symbol.for('pi-subagents/runtime')];
      const store=new RuntimeStore(directory+'/artifacts/parent/subagent-runtime',parent);
      runtime.store=store;runtime.delivery.store=store;store.isCurrent=()=>!!runtime.latestCtx;
      const children=['shutdown','factory','artifact'].map(id=>({id,name:id,task:'task',sessionFile:directory+'/'+id+'.jsonl',startTime:1,
        durableStore:store,lifecycle:createLifecycle(1),interactive:false}));
      for(const child of children)store.prepare({id:child.id,name:child.name,task:child.task,sessionFile:child.sessionFile,startTime:child.startTime});
      old.get('session_shutdown')({reason:'reload'},ctx);
      const output=child=>({name:child.name,task:'task',sessionFile:child.sessionFile,summary:'original '+child.id,elapsed:2,exitCode:0,eventId:child.id+'-event'});
      await observeSubagentCompletion(children[0],Promise.resolve(output(children[0])));
      const fresh=host(delivered);
      await observeSubagentCompletion(children[1],Promise.resolve(output(children[1])));
      const base=runCompletionFile(children[2].sessionFile,'artifact');fs.mkdirSync(base+'.events',{recursive:true});
      fs.writeFileSync(base+'.events/evidence.json',JSON.stringify({type:'done',runId:'artifact',eventId:'evidence',summary:'retained original'}));
      assert.equal(delivered.length,0);assert.equal(stale.length,0);
      await fresh.get('session_start')({reason:'reload'},ctx);
      await fresh.get('session_start')({reason:'reload'},ctx);
      assert.equal(runtime.recoveryError,undefined);assert.equal(delivered.length,3);
      for(const child of children.slice(0,2)){
        const messages=delivered.filter(m=>m.details.eventId==='subagent:'+child.id+':completion:'+child.id+'-event');
        assert.equal(messages.length,1);assert.equal(messages[0].details.response,'original '+child.id);
      }
      assert.equal(delivered.find(m=>m.details.eventId==='subagent:artifact:completion:evidence').details.response,'retained original');
      // A real branch mismatch still fences both observer enqueue and fallback;
      // neither callback may produce an unhandled rejected observer promise.
      runtime.latestCtx={...ctx,sessionManager:{...ctx.sessionManager,getBranch:()=>[]}};
      await observeSubagentCompletion(children[0],Promise.resolve({...output(children[0]),eventId:'foreign'}));
      await observeSubagentCompletion(children[0],Promise.reject(new Error('observer failure')));
      assert.equal(delivered.length,3);
      fresh.get('session_shutdown')({reason:'quit'},ctx);`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real Pi tree cancellation, summary abort/error resume original custody; changed lineage fences old runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-tree-"));
  try {
    execute(`import extension,{observeSubagentCompletion} from ${JSON.stringify(moduleURL("index"))};
      import {RuntimeStore} from ${JSON.stringify(moduleURL("runtime-store"))};
      import {createLifecycle} from ${JSON.stringify(moduleURL("lifecycle"))};
      import {canonicalSessionPath} from ${JSON.stringify(moduleURL("ownership"))};
      import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime} from '@earendil-works/pi-coding-agent';
      import {getModel} from '@earendil-works/pi-ai/compat';
      import assert from 'node:assert/strict';
      const directory=${JSON.stringify(dir)};const delivered=[];const errors=[];
      let mode='cancel',release,entered=false,summaryStarted=false;
      const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
      const modelRuntime=await ModelRuntime.create({authPath:directory+'/auth.json',modelsPath:directory+'/models.json',refreshOnCreate:false});
      const sm=SessionManager.create(directory,directory+'/sessions');
      const target=sm.appendCustomEntry('root',{});
      const checkpoint=sm.appendCustomEntry('subagent-custody',{branchToken:'token'});
      sm.appendMessage({role:'user',content:'Work worth summarizing',timestamp:Date.now()});
      const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,
        noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
        extensionFactories:[pi=>extension(new Proxy(pi,{get:(api,key)=>key==='sendMessage'?message=>delivered.push(message):api[key]})),
          pi=>pi.on('session_before_tree',async()=>{entered=true;await new Promise(r=>release=r);if(mode==='cancel')return {cancel:true};})]});
      await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
      const {session}=await createAgentSession({cwd:directory,agentDir:directory,sessionManager:sm,settingsManager,modelRuntime,
        model:getModel('anthropic','claude-sonnet-4-5'),resourceLoader:loader,tools:[]});
      await session.bindExtensions({onError:error=>errors.push(error)});
      const runtime=globalThis[Symbol.for('pi-subagents/runtime')];
      const parent={sessionFile:canonicalSessionPath(sm.getSessionFile()),headerId:sm.getHeader().id,checkpoint,branchToken:'token'};
      const store=new RuntimeStore(directory+'/artifacts/'+parent.headerId+'/subagent-runtime',parent);
      runtime.store=store;runtime.delivery.store=store;
      store.isCurrent=()=>!!runtime.latestCtx&&sm.getBranch().some(entry=>entry.id===checkpoint);
      const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'boundary timed out');await new Promise(r=>setTimeout(r,10));}};
      // Keep a live supervised run through all cancelled/failed operations.
      const child={id:'live',name:'live',task:'task',sessionFile:directory+'/child.jsonl',startTime:1,
        durableStore:store,lifecycle:createLifecycle(1),interactive:false,terminalActionsAllowed:true};
      runtime.runningSubagents.set(child.id,child);
      store.prepare({id:child.id,name:child.name,task:child.task,sessionFile:child.sessionFile,startTime:1});
      session._getSummarizationRequestAuth=async()=>({model:session.model,apiKey:'test-only'});
      session.agent.streamFunction=(_model,_context,options)=>({result:async()=>{
        summaryStarted=true;
        if(mode==='abort')await new Promise(r=>options.signal.addEventListener('abort',r,{once:true}));
        return {role:'assistant',content:[],api:'anthropic-messages',provider:'anthropic',model:session.model.id,
          usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
          stopReason:mode==='abort'?'aborted':'error',errorMessage:'test summary failure',timestamp:Date.now()};
      }});
      for(mode of ['cancel','abort','error']){
        entered=false;summaryStarted=false;
        const oldLeaf=sm.getLeafId();
        const navigation=session.navigateTree(target,{summarize:mode!=='cancel'});
        // Attach the expected error immediately so rejection is always observed.
        const outcome=navigation.then(value=>({value}),error=>({error}));
        await wait(()=>entered);
        assert.equal(session.isIdle,false);assert.throws(()=>store.assertCustody(),/branch/);
        assert.equal(store.snapshot().custodyPaused,undefined);
        await observeSubagentCompletion(child,Promise.resolve({name:'live',task:'task',sessionFile:child.sessionFile,
          summary:'original '+mode,eventId:mode,elapsed:1,exitCode:0,keepOpen:true}));
        assert.equal(delivered.length,['cancel','abort','error'].indexOf(mode),'no publication while navigation awaits a handler');
        release();
        if(mode==='abort'){await wait(()=>summaryStarted);session.abortBranchSummary();}
        const result=await outcome;
        if(mode==='error')assert.match(result.error.message,/test summary failure/);
        else assert.equal(result.value.cancelled,true);
        assert.equal(sm.getLeafId(),oldLeaf);
        await wait(()=>runtime.latestCtx&&delivered.length===['cancel','abort','error'].indexOf(mode)+1);
        assert.equal(runtime.recoveryError,undefined);assert.equal(store.snapshot().custodyPaused,undefined);
        store.assertCustody();assert.equal(child.terminalActionsAllowed,true);
        assert.equal(runtime.runningSubagents.get('live'),child);
        assert.equal(delivered.at(-1).details.eventId,'subagent:live:completion:'+mode);
        assert.equal(delivered.at(-1).details.response,'original '+mode);
      }
      mode='change';entered=false;
      const navigation=session.navigateTree(target);await wait(()=>entered);release();await navigation;
      assert.match(store.snapshot().custodyPaused,/changed active lineage/);
      assert.equal(child.terminalActionsAllowed,false);assert.equal(runtime.runningSubagents.size,0);
      assert.match(runtime.recoveryError,/explicit branch decision/);
      await observeSubagentCompletion(child,Promise.resolve({name:'live',task:'task',summary:'foreign',elapsed:1,exitCode:0,eventId:'foreign'}));
      assert.equal(delivered.length,3);assert.deepEqual(errors,[]);
      session.dispose();`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
