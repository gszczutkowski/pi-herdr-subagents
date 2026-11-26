import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
    process.env.PI_CODING_AGENT_DIR=${JSON.stringify(dir)};
    const handlers=new Map(); const delivered=[]; const notices=[]; const tools=new Map();
    const emit=async(name,event={})=>{const messages=[];for(const fn of handlers.get(name)??[]){const result=await fn(event,ctx);if(result?.message)messages.push(result.message);}return {messages};};
    const branch=${branch};
    const pi=new Proxy({}, {get:(_,key)=>key==='on'?(name,fn)=>handlers.set(name,[...(handlers.get(name)??[]),fn]):key==='getAllTools'?()=>[]:
      key==='registerTool'?(tool)=>tools.set(tool.name,tool):
      key==='sendMessage'?(message)=>delivered.push(message.details.eventId):()=>{}});
    const ctx={cwd:${JSON.stringify(dir)},hasUI:true,scopedModels:[],modelRegistry:{getAvailable:()=>[]},ui:{notify:(m)=>notices.push(m),setWidget:()=>{}},
      sessionManager:{getHeader:()=>({id:${JSON.stringify(headerId)}}),getSessionId:()=>${JSON.stringify(headerId)},getSessionFile:()=>${JSON.stringify(join(dir, file))},getSessionDir:()=>${JSON.stringify(dir)},getBranch:()=>branch,buildSessionProjection:()=>({messages:[]})}};
    extension(pi); await emit('session_start',{reason:'startup'});
    await emit('session_start',{reason:'startup'});
    const runtime=globalThis[Symbol.for('pi-subagents/runtime')];
    const report=await tools.get('subagents_recovery').execute('report',{},undefined,undefined,ctx);
    const projection=await emit('before_agent_start',{systemPromptOptions:{toolGuidelines:{}}});
    fs.writeFileSync(${JSON.stringify(join(dir, "observed.json"))},JSON.stringify({report,projection,delivered,notices,error:runtime.recoveryError,runs:runtime.runningSubagents.size,owners:[...((await import(${JSON.stringify(moduleURL("ownership"))})).sessionOwners.values())]}));
    await emit('session_shutdown',{reason:'quit'});`;
}
function execute(code: string, timeout = 30000) {
  // These subprocesses simulate parent writers, even if the test runner is a child.
  const env = { ...process.env };
  delete env.PI_SUBAGENT_ID;
  delete env.PI_SUBAGENT_SESSION;
  delete env.PI_DENY_TOOLS;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout, env });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
}

test("harvest I/O failures pause only their run, report errors, and permit bounded explicit reconciliation without replay/relaunch", { skip: !processSupported }, () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-harvest-io-"));
  try {
    execute(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
      import {RuntimeStore} from ${JSON.stringify(moduleURL("runtime-store"))};
      import {probeProcess} from ${JSON.stringify(moduleURL("process-identity"))};
      import {canonicalSessionPath,releaseSession} from ${JSON.stringify(moduleURL("ownership"))};
      const dir=${JSON.stringify(dir)},read=fs.readFileSync;let tick,failure;
      globalThis.setInterval=fn=>{tick=fn;return {unref(){}}};globalThis.clearInterval=()=>{};
      fs.readFileSync=(file,...args)=>{
        if(failure&&String(file).includes('bad.jsonl.bad.exit.events'))throw Object.assign(Error(failure),{code:failure});
        return String(file).endsWith('.response.json')?read(String(file).replace('.response.json','.challenge.json'),...args):read(file,...args);
      };
      syncBuiltinESMExports();
      const {reconcileRuntime}=await import(${JSON.stringify(moduleURL("runtime-recovery"))});
      const s=new RuntimeStore(dir+'/runtime',{sessionFile:'parent',headerId:'p',branchToken:'b',checkpoint:'c'});
      const failures=[],seen=[];
      for(const id of ['bad','good']){
        const session=canonicalSessionPath(dir+'/'+id+'.jsonl');fs.writeFileSync(session,JSON.stringify({type:'session',id})+'\\n');
        s.prepare({id,sessionFile:session,name:id,task:'task',cli:'pi',startTime:1});
        const base=session+'.'+id+'.exit';fs.mkdirSync(base+'.events');
        fs.writeFileSync(base+'.identity.json',JSON.stringify({schema:1,runId:id,sessionFile:session,headerId:id,nonce:id,process:probeProcess(process.pid).identity}));
      }
      const onEvidence=(run,event)=>{
        const id='subagent:'+run.id+':completion:'+event.eventId;
        s.enqueue(id,run.id,{message:{customType:'subagent_result',content:event.summary,details:{eventId:id}},options:{triggerTurn:true,deliverAs:'steer'}});seen.push(id);
      };
      const stop=await reconcileRuntime(s,onEvidence,()=>true,{maxEventsPerPass:1,onError:error=>{failures.push(error);if(failures.length===1)throw Error('broken diagnostic observer')}});
      const put=(id,eventId)=>fs.writeFileSync(dir+'/'+id+'.jsonl.'+id+'.exit.events/'+eventId+'.json',JSON.stringify({type:'done',runId:id,eventId,summary:eventId}));
      for(const code of ['ENOSPC','EACCES','EIO']){
        failure=code;put('bad',code);put('good',code);
        for(let pass=0;pass<3&&!failures.some(error=>error.runId==='bad'&&error.error.includes(code));pass++)assert.doesNotThrow(()=>tick());
        assert.ok(failures.some(error=>error.runId==='bad'&&error.error.includes(code)),JSON.stringify(failures));
        assert.equal(stop.status().state,'paused');assert.match(s.getRun('bad').reconciliation,/paused/);
        tick();assert.ok(seen.includes('subagent:good:completion:'+code),'one failure cannot disable other recovered runs');
        const count=failures.length;tick();assert.equal(failures.length,count,'paused runs do not auto-retry');
        failure=undefined;const before=seen.length;stop.reconcile();assert.ok(seen.length-before<=1,'explicit reconciliation has a hard work bound');
        assert.ok(seen.includes('subagent:bad:completion:'+code));assert.equal(stop.status().state,'active');
        tick();assert.equal(seen.filter(id=>id==='subagent:bad:completion:'+code).length,1);
      }
      let current=true;s.isCurrent=()=>current;current=false;
      assert.doesNotThrow(()=>tick());assert.equal(stop.status().state,'paused');
      assert.doesNotThrow(()=>stop.reconcile());assert.equal(stop.status().state,'paused','lost custody cannot be resumed automatically');
      current=true;stop.reconcile();assert.equal(stop.status().state,'active');
      assert.equal(new Set(seen).size,seen.length);stop();assert.equal(stop.status().state,'stopped');
      for(const id of ['bad','good'])releaseSession(dir+'/'+id+'.jsonl',id);s.close();
    `, 30000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registered recovery tool fails closed on unavailable hosts, recovery errors and custody loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-access-"));
  try {
    execute(`import extension from ${JSON.stringify(moduleURL("index"))};
      import assert from 'node:assert/strict';import fs from 'node:fs';
      import {canonicalSessionPath} from ${JSON.stringify(moduleURL("ownership"))};
      const tools=new Map();
      extension(new Proxy({}, {get:(_,key)=>key==='registerTool'?tool=>tools.set(tool.name,tool):key==='getAllTools'?()=>[]:()=>{}}));
      const runtime=globalThis[Symbol.for('pi-subagents/runtime')];
      const dir=${JSON.stringify(dir)};
      const branch=[{id:'c',type:'custom',customType:'subagent-custody',data:{branchToken:'b'}}];
      const ctx={sessionManager:{getHeader:()=>({id:'parent'}),getBranch:()=>branch,getSessionFile:()=>dir+'/parent.jsonl',getSessionDir:()=>dir}};
      const report=(context=ctx)=>tools.get('subagents_recovery').execute('read',{},undefined,undefined,context);
      assert.match((await report({sessionManager:{}})).content[0].text,/Host lacks/);
      assert.match((await report()).content[0].text,/Legacy.missing/);
      const manifest={schema:1,revision:1,generation:'g',parent:{sessionFile:canonicalSessionPath(dir+'/parent.jsonl'),headerId:'parent',checkpoint:'c',branchToken:'b'},runs:{run:{id:'run',name:'private-name',task:'private-task',sessionFile:dir+'/child.jsonl',startTime:1,phase:'prepared',eventCursor:[]}},outbox:{}};
      const directory=dir+'/artifacts/parent/subagent-runtime';fs.mkdirSync(directory,{recursive:true});
      const file=directory+'/manifest.json';fs.writeFileSync(file,JSON.stringify({...manifest,custodyPaused:'explicit decision required'}));
      const before=fs.readFileSync(file,'utf8');
      assert.match((await report()).content[0].text,/Paused diagnostics only/);
      assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.existsSync(directory+'/writer'),false);
      runtime.recoveryError='reconciliation failed';
      let result=await report();assert.equal(result.isError,true);assert.doesNotMatch(result.content[0].text,/private-task/);
      runtime.recoveryError=undefined;
      runtime.store={snapshot:()=>manifest,assertCustody:()=>{throw Error('writer custody lost')}};
      result=await report();assert.equal(result.isError,true);assert.match(result.content[0].text,/custody lost/);assert.doesNotMatch(result.content[0].text,/private-task/);
      runtime.store={snapshot:()=>manifest,assertCustody:()=>{throw Object.assign(Error('manifest busy'),{code:'EBUSY'})}};
      result=await report();assert.equal(result.isError,true);assert.match(result.content[0].text,/last verified evidence.*manifest busy/);assert.match(result.content[0].text,/private-task/);
      branch.pop();result=await report();assert.equal(result.isError,true);assert.doesNotMatch(result.content[0].text,/private-task/);
      runtime.store=undefined;fs.writeFileSync(file,'broken');
      result=await report();assert.equal(result.isError,true);assert.doesNotMatch(result.content[0].text,/private-task/);`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
    assert.match(observed.report.content[0].text, /"task":"work"/);
    assert.match(observed.report.content[0].text, /"sessionPath":/);
    assert.match(observed.report.content[0].text, /"unknown":1/);
    assert.match(observed.projection.messages[0].content, /"runId":"run"/);
    assert.ok(observed.notices.some((notice: string) => notice.includes("Saved subagent assignments found")));
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
    assert.equal(observed.report.isError, true);
    assert.doesNotMatch(observed.report.content[0].text, /"task":"work"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fresh parent resumes an exited recovered session only after fresh process and writer checks", { skip: !processSupported }, () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-restart-resume-"));
  try {
    // The original parent/process publishes identity and exits without releasing
    // its lease. Recovery runs in a genuinely fresh process, not a module reload.
    execute(`import {RuntimeStore} from ${JSON.stringify(moduleURL("runtime-store"))};
      import {probeProcess} from ${JSON.stringify(moduleURL("process-identity"))};
      import {canonicalSessionPath} from ${JSON.stringify(moduleURL("ownership"))};
      import {runCompletionFile} from ${JSON.stringify(moduleURL("run-artifacts"))};
      import {persistLaunchProfile,resolveLaunchProfile} from ${JSON.stringify(moduleURL("launch-profile"))};
      import fs from 'node:fs';
      const dir=${JSON.stringify(dir)},session=canonicalSessionPath(dir+'/child.jsonl');
      fs.writeFileSync(dir+'/parent.jsonl',JSON.stringify({type:'session',id:'parent'})+'\\n');
      fs.writeFileSync(session,JSON.stringify({type:'session',version:3,id:'child',cwd:dir})+'\\n');
      const profile=resolveLaunchProfile({params:{id:'run',name:'Recovered'},
        runtimePlan:{provider:'test',modelId:'model',model:'test/model',thinking:'off',modelSource:'parent',thinkingSource:'parent'},
        effectiveCwd:dir,effectiveAutoExit:true,effectiveInteractive:false,taskDelivery:'artifact',
        subagentSessionFile:session,localAgentDir:dir,denySet:new Set()},'pi','read');
      persistLaunchProfile(profile);
      const store=new RuntimeStore(dir+'/artifacts/parent/subagent-runtime',{
        sessionFile:canonicalSessionPath(dir+'/parent.jsonl'),headerId:'parent',branchToken:'token',checkpoint:'checkpoint'});
      store.prepare({id:'run',sessionFile:session,name:'Recovered',task:'work',startTime:1,cli:'pi',surface:'old-pane',profile});
      store.phase('run','supervised');
      const file=runCompletionFile(session,'run');
      fs.writeFileSync(file+'.identity.json',JSON.stringify({schema:1,runId:'run',sessionFile:session,
        headerId:'child',nonce:'original-process',process:probeProcess(process.pid).identity}));`);
    execute(`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
      import {promisify} from 'node:util';import fs from 'node:fs';import assert from 'node:assert/strict';
      let surfaces=0,dispatches=0,auditSnapshots=0,enumerationDenied=false;const inspections=[];
      const originalReaddir=fs.readdirSync;
      // Only global enumeration is synthetic: /proc/PID/stat identity probes
      // must still observe the real exited parent and live replacement below.
      fs.readdirSync=(path,...args)=>{
        if(String(path)==='/proc'){
          auditSnapshots++;
          if(enumerationDenied)throw Object.assign(Error('enumeration denied'),{code:'EACCES'});
          return [];
        }
        return originalReaddir(path,...args);
      };
      const original=cp.execFileSync;
      cp.execSync=()=> 'herdr';
      cp.execFileSync=(command,args,...options)=>{
        if(command==='powershell.exe'){
          // This fixture never launches a real Pi writer. Isolate global Windows
          // enumeration from unrelated/transient CLI processes while retaining
          // real PID/birth probes for the recovered identity below. Audit parser,
          // duplicate/uncertain writer cases have dedicated session-audit tests.
          if(args.some(arg=>typeof arg==='string'&&arg.includes('ForEach-Object { @{pid=$_.ProcessId;parentPid='))){
            auditSnapshots++;
            if(enumerationDenied)throw Error('enumeration denied');
            return '[]';
          }
          return original(command,args,...options);
        }
        if(args[0]==='tab'&&args[1]==='create')return JSON.stringify({result:{root_pane:{pane_id:'new-'+(++surfaces)}}});
        if(args[1]==='run')dispatches++;
        return '';
      };
      cp.execFile=Object.assign(()=>{throw new Error('unexpected transport')},{[promisify.custom]:async(_command,args)=>{
        inspections.push(args[2]);return {stdout:JSON.stringify({result:{pane:{pane_id:'new',agent_status:'idle'}}})};
      }});syncBuiltinESMExports();
      process.env.HERDR_ENV='1';process.env.HERDR_WORKSPACE_ID='restart-test';process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS='0';
      for(const key of ['HC_TERMINAL_ID','HC_TERMINAL_SOCKET','PI_SUBAGENT_LAYOUT'])delete process.env[key];
      process.env.PI_CODING_AGENT_DIR=${JSON.stringify(dir)};
      const {default:extension}=await import(${JSON.stringify(moduleURL("index"))});
      const {canonicalSessionPath,sessionOwners}=await import(${JSON.stringify(moduleURL("ownership"))});
      const {runCompletionFile}=await import(${JSON.stringify(moduleURL("run-artifacts"))});
      const {probeProcess}=await import(${JSON.stringify(moduleURL("process-identity"))});
      const dir=${JSON.stringify(dir)},session=canonicalSessionPath(dir+'/child.jsonl');
      const handlers=new Map(),tools=new Map();
      extension(new Proxy({}, {get:(_,key)=>key==='on'?(name,fn)=>handlers.set(name,fn):
        key==='registerTool'?tool=>tools.set(tool.name,tool):key==='getAllTools'?()=>[]:()=>{}}));
      const branch=[{id:'checkpoint',type:'custom',customType:'subagent-custody',data:{branchToken:'token'}}];
      const ctx={hasUI:false,cwd:dir,scopedModels:[],modelRegistry:{getAvailable:()=>[]},sessionManager:{
        getHeader:()=>({id:'parent'}),getSessionId:()=> 'parent',getSessionFile:()=>dir+'/parent.jsonl',
        getSessionDir:()=>dir,getBranch:()=>branch}};
      await handlers.get('session_start')({reason:'startup'},ctx);
      const runtime=globalThis[Symbol.for('pi-subagents/runtime')],owner=sessionOwners.get(session);
      assert.equal(runtime.recoveryError,undefined);assert.equal(runtime.runningSubagents.size,0);
      assert.equal(owner.runId,'run');assert.equal(owner.surface,undefined);
      assert.match(runtime.store.snapshot().runs.run.reconciliation,/exited:/);
      const resume=()=>tools.get('subagent_resume').execute('resume',{sessionPath:session},undefined,undefined,ctx);
      const identityFile=runCompletionFile(session,'run')+'.identity.json';
      const originalIdentity=fs.readFileSync(identityFile,'utf8'),identity=JSON.parse(originalIdentity);
      // A cached exited decision or logical completion cannot replace a fresh
      // probe. Missing/foreign identity and a still-live process retain custody.
      for(const replacement of [null,{...identity,headerId:'foreign'},
          {...identity,process:probeProcess(process.pid).identity}]){
        if(replacement)fs.writeFileSync(identityFile,JSON.stringify(replacement));else fs.rmSync(identityFile);
        await assert.rejects(resume(),/already owned/);
        assert.equal(sessionOwners.get(session),owner);assert.equal(surfaces,0);assert.equal(dispatches,0);
      }
      fs.writeFileSync(identityFile,originalIdentity);
      // Custody loss must not release the reservation, even with a dead child.
      branch.length=0;await assert.rejects(resume(),/branch/);assert.equal(sessionOwners.get(session),owner);
      branch.push({id:'checkpoint',type:'custom',customType:'subagent-custody',data:{branchToken:'token'}});
      if(['linux','win32'].includes(process.platform)){
        enumerationDenied=true;
        await assert.rejects(resume(),/Session process audit is uncertain/);
        assert.equal(sessionOwners.get(session),owner,'denied audit retains recovered custody');
        assert.equal(surfaces,0);assert.equal(dispatches,0);
        enumerationDenied=false;
      }
      const attempts=await Promise.allSettled([resume(),resume()]);
      assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
      assert.match(String(attempts.find(r=>r.status==='rejected').reason),/already owned/);
      if(['linux','win32'].includes(process.platform))assert.ok(auditSnapshots>0,'verified enumeration fixture must run');
      const result=attempts.find(r=>r.status==='fulfilled').value;
      assert.equal(result.details.status,'started');assert.notEqual(result.details.id,'run');
      assert.equal(sessionOwners.get(session).runId,result.details.id);
      assert.equal(surfaces,1);assert.equal(dispatches,1);
      assert.match(runtime.store.snapshot().runs.run.reconciliation,/explicit resume released/);
      // No recovered terminal locator was inspected or used to authorize launch.
      assert.ok(inspections.every(pane=>pane==='new-1'));
      handlers.get('session_shutdown')({reason:'quit'},ctx);`, 120000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Only for a direct test fixture we spawned. An earlier exit is not replayed to late listeners.
async function stopFixture(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
  child.kill();
  await exited;
}

test("recovery teardown does not hang when the child exits before publishing its identity", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-early-exit-"));
  const child = spawn(process.execPath, ["-e", "process.exitCode = 7"], { cwd: dir, stdio: "ignore" });
  try {
    const [code] = await once(child, "close", { signal: AbortSignal.timeout(10000) });
    assert.equal(code, 7);
  } finally {
    await stopFixture(child); // The exit event has already been delivered.
    rmSync(dir, { recursive: true });
  }
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
    store.phase("run", "dispatch-intent");
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
    assert.equal(store.getRun("run")?.dispatchVerified, true, "fresh child challenge supplies historical dispatch proof");
    store.reconcileRun("run", "unverified: later observation unavailable");
    assert.equal(store.getRun("run")?.dispatchVerified, true, "saved proof is distinct from current liveness");
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
    await stopFixture(child);
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
      const directory=${JSON.stringify(dir)};process.env.PI_CODING_AGENT_DIR=directory;
      const parent={sessionFile:canonicalSessionPath(directory+'/parent.jsonl'),headerId:'parent',branchToken:'token',checkpoint:'checkpoint'};
      const branch=[{id:'checkpoint',type:'custom',customType:'subagent-custody',data:{branchToken:'token'}}];
      const ctx={cwd:directory,hasUI:false,scopedModels:[],modelRegistry:{getAvailable:()=>[]},sessionManager:{
        getHeader:()=>({id:'parent'}),getSessionFile:()=>parent.sessionFile,getSessionDir:()=>directory,getBranch:()=>branch}};
      const delivered=[];const stale=[];
      function host(messages){const handlers=new Map();extension(new Proxy({}, {get:(_,key)=>key==='on'?(n,f)=>handlers.set(n,f):key==='getAllTools'?()=>[]:key==='sendMessage'?m=>messages.push(m):()=>{}}));return handlers;}
      const old=host(stale);await old.get('session_start')({},ctx);
      const runtime=globalThis[Symbol.for('pi-subagents/runtime')];
      const store=new RuntimeStore(directory+'/artifacts/parent/subagent-runtime',parent);
      runtime.store=store;runtime.delivery.store=store;store.isCurrent=()=>!!runtime.latestCtx;
      const children=['shutdown','factory','artifact','kept'].map(id=>({id,name:id,task:'task',sessionFile:directory+'/'+id+'.jsonl',startTime:1,
        durableStore:store,lifecycle:createLifecycle(1),interactive:false,completionRunId:id,
        surface:'unverified-test-surface',terminalActionsAllowed:false,abortController:new AbortController()}));
      runtime.runningSubagents.set('kept',children[3]);
      for(const child of children)store.prepare({id:child.id,name:child.name,task:child.task,sessionFile:child.sessionFile,startTime:child.startTime});
      old.get('session_shutdown')({reason:'reload'},ctx);
      const keptBase=runCompletionFile(children[3].sessionFile,'kept');fs.mkdirSync(keptBase+'.events',{recursive:true});
      fs.writeFileSync(keptBase+'.events/kept-event.json',JSON.stringify({type:'done',runId:'kept',eventId:'kept-event',summary:'retained kept',keepOpen:true}));
      await observeSubagentCompletion(children[3],Promise.resolve({name:'kept',task:'task',sessionFile:children[3].sessionFile,
        summary:'retained kept',elapsed:2,exitCode:0,eventId:'kept-event',keepOpen:true}));
      await new Promise(resolve=>setTimeout(resolve,50));
      assert.deepEqual(store.snapshot().runs.kept.eventCursor,[]);
      assert.equal(runtime.suspendedCompletions.size,1,'keep-open observation must remain suspended, not re-read evidence');
      const output=child=>({name:child.name,task:'task',sessionFile:child.sessionFile,summary:'original '+child.id,elapsed:2,exitCode:0,eventId:child.id+'-event'});
      await observeSubagentCompletion(children[0],Promise.resolve(output(children[0])));
      const fresh=host(delivered);
      await observeSubagentCompletion(children[1],Promise.resolve(output(children[1])));
      const base=runCompletionFile(children[2].sessionFile,'artifact');fs.mkdirSync(base+'.events',{recursive:true});
      const structuredResult={status:'complete',summary:'Short recovery proposal',artifacts:[],checks:[],unmetCriterionIds:[],risks:[]};
      fs.writeFileSync(base+'.events/evidence.json',JSON.stringify({type:'done',runId:'artifact',eventId:'evidence',summary:'Detailed retained assistant final',structuredResult}));
      assert.equal(delivered.length,0);assert.equal(stale.length,0);
      await fresh.get('session_start')({reason:'reload'},ctx);
      await fresh.get('session_start')({reason:'reload'},ctx);
      assert.equal(runtime.recoveryError,undefined);assert.equal(delivered.length,4);
      assert.deepEqual(store.snapshot().runs.kept.eventCursor,['subagent:kept:completion:kept-event']);
      assert.equal(runtime.suspendedCompletions.size,0);
      for(const child of children.slice(0,2)){
        const messages=delivered.filter(m=>m.details.eventId==='subagent:'+child.id+':completion:'+child.id+'-event');
        assert.equal(messages.length,1);assert.equal(messages[0].details.response,'original '+child.id);
      }
      const recovered=delivered.find(m=>m.details.eventId==='subagent:artifact:completion:evidence');
      assert.equal(recovered.details.response,'Detailed retained assistant final');
      assert.deepEqual(recovered.details.structuredResult,structuredResult);
      assert.match(recovered.content,/proposal, requires parent review/);
      assert.deepEqual(store.snapshot().outbox[recovered.details.eventId].envelope.message,recovered);
      // A real branch mismatch still fences both observer enqueue and fallback;
      // neither callback may produce an unhandled rejected observer promise.
      runtime.latestCtx={...ctx,sessionManager:{...ctx.sessionManager,getBranch:()=>[]}};
      await observeSubagentCompletion(children[0],Promise.resolve({...output(children[0]),eventId:'foreign'}));
      await observeSubagentCompletion(children[0],Promise.reject(new Error('observer failure')));
      assert.equal(delivered.length,4);
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
      const directory=${JSON.stringify(dir)};process.env.PI_CODING_AGENT_DIR=directory;const delivered=[];const errors=[];
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
