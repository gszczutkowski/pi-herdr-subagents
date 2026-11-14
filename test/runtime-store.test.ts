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
