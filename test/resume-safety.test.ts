import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import { runCompletionFile, writeRunCompletion } from "../pi-extension/subagents/run-artifacts.ts";
import { canonicalSessionPath, releaseSession, reserveSession, sessionOwners } from "../pi-extension/subagents/ownership.ts";

test("1000 retained events: empty polls read zero payloads; restart, new events, metadata edits and retry preserve evidence", () => {
  const url = pathToFileURL(resolve("pi-extension/subagents/completion.ts")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    let reads=0,stats=0;const read=fs.readFileSync,stat=fs.statSync;
    fs.readFileSync=(file,...args)=>{if(String(file).endsWith('.json'))reads++;return read(file,...args)};
    fs.statSync=(...args)=>{stats++;return stat(...args)};syncBuiltinESMExports();
    const {readRetainedCompletion,RetainedCompletionIndex}=await import(${JSON.stringify(url)});
    const dir=fs.mkdtempSync(join(tmpdir(),'retained-operations-')),session=join(dir,'child.jsonl'),base=session+'.run.exit',events=base+'.events';
    const cursor=new Set();fs.mkdirSync(events);let index=new RetainedCompletionIndex();
    const put=(id,summary=id)=>{const file=join(events,id+'.json');fs.writeFileSync(file,JSON.stringify({type:'done',runId:'run',eventId:id,summary}));return file};
    try {
      for(let n=0;n<1000;n++){const id=String(n).padStart(4,'0');put(id);cursor.add('subagent:run:completion:'+id)}
      assert.equal(readRetainedCompletion(session,'run',cursor,index),null);assert.equal(reads,1000);
      reads=0;stats=0;assert.equal(readRetainedCompletion(session,'run',cursor,index),null);
      assert.equal(reads,0,'empty poll payload reads');assert.ok(stats>=1000,'metadata checks must still detect in-place edits');
      console.log('retained empty poll: payload reads='+reads+', metadata stats='+stats+'; 1000 immutable files kept');
      put('new');const event=readRetainedCompletion(session,'run',cursor,index);assert.equal(event.eventId,'new');
      assert.equal(readRetainedCompletion(session,'run',cursor,index).eventId,'new','failed import/enqueue leaves event retryable');
      cursor.add('subagent:run:completion:new');assert.equal(readRetainedCompletion(session,'run',cursor,index),null);
      index=new RetainedCompletionIndex();reads=0;assert.equal(readRetainedCompletion(session,'run',cursor,index),null);assert.equal(reads,1001,'restart verifies all retained payloads once');
      reads=0;assert.equal(readRetainedCompletion(session,'run',cursor,index),null);assert.equal(reads,0);
      const file=join(events,'0000.json'),original=read(file,'utf8'),before=stat(file);
      fs.writeFileSync(file,original.replace('"summary":"0000"','"summary":"EDIT"'));fs.utimesSync(file,before.atime,before.mtime);
      assert.throws(()=>readRetainedCompletion(session,'run',cursor,index),/changed|corrupt|immutable/i,'ctime detects same-size edits with restored mtime');
      fs.writeFileSync(file,original);assert.equal(readRetainedCompletion(session,'run',cursor,index),null);
      const corrupt=join(events,'retry.json');fs.writeFileSync(corrupt,'{');assert.throws(()=>readRetainedCompletion(session,'run',cursor,index),/JSON|corrupt/i);
      put('retry');assert.equal(readRetainedCompletion(session,'run',cursor,index).eventId,'retry');cursor.add('subagent:run:completion:retry');
      assert.equal(readRetainedCompletion(session,'run',cursor,index),null);assert.equal(fs.readdirSync(events).length,1002);
    } finally {fs.rmSync(dir,{recursive:true,force:true})}
  `], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); console.log(result.stdout.trim());
});

test("session ownership is synchronous, canonical, reload-stable and run guarded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-"));
  try {
    mkdirSync(join(dir, "real"));
    const path = join(dir, "real", "child.jsonl");
    const owner = reserveSession(path, "first");
    assert.throws(() => reserveSession(join(dir, "real", "..", "real", "child.jsonl"), "second"), /already owned/);
    writeFileSync(path, "");
    assert.equal(sessionOwners.get(canonicalSessionPath(path)), owner);
    releaseSession(path, "second");
    assert.throws(() => reserveSession(path, "third"), /already owned/);
    const reloaded = await import("../pi-extension/subagents/ownership.ts?reload");
    assert.equal(reloaded.sessionOwners, sessionOwners);
    releaseSession(path, "first");
    reserveSession(path, "next");
    releaseSession(path, "next");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("run-qualified completion ignores stale and wrong-run evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "completion-"));
  const session = join(dir, "child.jsonl");
  try {
    writeFileSync(`${session}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(runCompletionFile(session, "current"), JSON.stringify({ type: "ping", runId: "old" }));
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1, sessionFile: session, runId: "current",
      readTerminalTail: async () => "__SUBAGENT_DONE_0__\n__SUBAGENT_DONE_old_0__\nsource code contains __SUBAGENT_DONE_current_0__\n__SUBAGENT_DONE_current_7__",
    });
    assert.equal(result.exitCode, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("atomic completion preserves richer first publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  const oldSession = process.env.PI_SUBAGENT_SESSION;
  const oldId = process.env.PI_SUBAGENT_ID;
  try {
    process.env.PI_SUBAGENT_SESSION = join(dir, "child.jsonl");
    process.env.PI_SUBAGENT_ID = "writer";
    writeRunCompletion({ type: "ping", name: "worker", message: "help" });
    writeRunCompletion({ type: "done" });
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1, sessionFile: process.env.PI_SUBAGENT_SESSION, runId: "writer", readTerminalTail: async () => "",
    });
    assert.equal(result.reason, "ping");
  } finally {
    if (oldSession === undefined) delete process.env.PI_SUBAGENT_SESSION; else process.env.PI_SUBAGENT_SESSION = oldSession;
    if (oldId === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = oldId;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("directory aliases share ownership even before session exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-alias-"));
  try {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "alias"), "junction");
    const path = join(dir, "real", "new.jsonl");
    reserveSession(path, "alias-owner");
    assert.throws(() => reserveSession(join(dir, "alias", "new.jsonl"), "duplicate"), /already owned/);
    releaseSession(path, "alias-owner");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
