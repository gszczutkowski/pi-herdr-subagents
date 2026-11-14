import assert from "node:assert/strict";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { HcTuiRun, jsonLines, until } from "./hc-tui-harness.ts";
import { runCompletionFile } from "../../pi-extension/subagents/run-artifacts.ts";
import { canonicalSessionPath } from "../../pi-extension/subagents/ownership.ts";
import { probeProcess } from "../../pi-extension/subagents/process-identity.ts";
import { closeDir } from "../../pi-extension/subagents/close-control.ts";

const options = { skip: process.env.PI_TEST_HC_TUI !== "1", timeout: 600_000 };
function journey(name: string, verify: (run: HcTuiRun) => Promise<void>) {
  it(`real HC Pi TUI: ${name}`, options, async () => {
    const run = new HcTuiRun(name.replace(/[^a-z]+/gi, "-"));
    let failure: unknown;
    try { await run.launch(); await verify(run); }
    catch (error) { failure = error; throw error; }
    finally { await run.finish(failure); console.log(`HC ${name} evidence: ${run.evidence}`); }
  });
}
function metadata(run: HcTuiRun, child: any) {
  return JSON.parse(readFileSync(join(run.evidence, `child-${child.id}.json`), "utf8"));
}

journey("owned audit draft rejection resume and close", async run => {
  const child = await run.spawn("Closable", "Run bash: printf ALIVE > close-alive.txt . Summarize, then wait for further instructions without exiting.", "verify-open");
  await run.marker("close-alive.txt", "ALIVE"); await run.completion(child);
  const owned = metadata(run, child);
  const started = run.observed().find(e => e.kind === "session_start" && e.session === child.sessionFile);
  assert.equal(started?.mode, "tui"); assert.ok(started?.pid);
  const activity = run.manifest().runs[child.id].activityFile;
  const control = closeDir(activity);
  await until(run.evidence, () => existsSync(join(control, "current.json")) ? true : undefined, "real child CLOSE idle capability");
  const tool = async (name: string) => {
    const count = run.results(name).length, at = Date.now();
    run.action(run.parent, `Call ${name} exactly once with id ${JSON.stringify(child.id)}. Report the actual tool result briefly and end your turn. Do not retry, poll, close terminals, or use any other tool.`);
    const event = await until(run.evidence, () => run.results(name)[count], `actual ${name} result`);
    assert.ok(!event.data.isError, `${name} must return a lifecycle result, not throw`);
    await run.idle(at);
    return event;
  };
  const audit = (await tool("subagent_audit")).data.result.details;
  assert.equal(audit.status, "single"); assert.equal(audit.ownerCount, 1);
  assert.equal(audit.owners[0].pid, started.pid);
  run.assertions.ownedAudit = audit;
  const beforeDraft = readFileSync(child.sessionFile, "utf8");
  run.keys(owned.surface, ..."unsentclosedraft".split("")); // No Enter: typed after idle publication.
  await run.capture("live-draft-before-close");
  const rejected = (await tool("subagent_close")).data.result.details;
  assert.equal(rejected.status, "rejected"); assert.match(rejected.reason, /draft/);
  assert.equal(existsSync(join(control, `${rejected.requestId}.claim.json`)), false);
  assert.equal(existsSync(join(control, "intent.json")), false);
  assert.equal(probeProcess(started.pid).kind, "present");
  assert.equal(readFileSync(child.sessionFile, "utf8"), beforeDraft, "draft rejection starts no child model turn");
  assert.equal(run.observed().some(e => e.kind === "session_shutdown" && e.session === child.sessionFile), false);
  copyFileSync(join(control, `${rejected.requestId}.ack.json`), join(run.evidence, "draft-rejection-ack.json"));
  run.assertions.liveDraftRejected = rejected;
  run.keys(owned.surface, "ctrl+u"); // Only this journey's owned editor, no Escape or user-pane input.
  const resumed = await run.resume(child, "Run bash: printf RESUMED > close-resumed.txt . Summarize, then wait without exiting.", false);
  assert.equal(resumed.id, child.id);
  await run.marker("close-resumed.txt", "RESUMED"); await run.completion(child, 2);
  assert.equal(run.observed().filter(e => e.kind === "session_start" && e.session === child.sessionFile).length, 1);
  const beforeClose = readFileSync(child.sessionFile, "utf8");
  const closedEvent = await tool("subagent_close"), result = closedEvent.data.result.details;
  assert.equal(result.status, "closed"); assert.notEqual(result.requestId, rejected.requestId);
  assert.equal(result.process.pid, started.pid); assert.equal(result.remainingOwners, 0);
  assert.equal(probeProcess(started.pid).kind, "absent");
  assert.equal(readFileSync(child.sessionFile, "utf8"), beforeClose, "CLOSE must not add a prompt or child model turn");
  const cleanup = run.observed().filter(e => e.kind === "close_custody" && e.data.id === child.id && e.at <= closedEvent.at);
  assert.ok(cleanup.some(e => e.data.source === "closure-validation-read" && !e.data.running && !e.data.owner), "normal watcher cleanup must be observed before the registered close returns");
  run.assertions.verifiedClose = { result, cleanup, noExtraChildTurn: true, originalPidAbsent: true };
  const receipt = (await tool("subagent_close")).data.result.details;
  assert.deepEqual(receipt, result, "closed receipt recheck never dispatches another shutdown");
  await run.capture("verified-close");
  run.action(run.parent, "/quit");
  await until(run.evidence, () => run.observed().find(e => e.kind === "session_shutdown" && e.session === run.parentSession && e.data.reason === "quit"), "owned parent graceful quit");
});

journey("parallel and reload", async run => {
  const a = await run.spawn("ParallelA", "Run bash: node gate.mjs parallel-a . Then finish.");
  const b = await run.spawn("ParallelB", "Run bash: node gate.mjs parallel-b . Then finish.");
  await run.marker("parallel-a.started", "STARTED");
  await run.marker("parallel-b.started", "STARTED");
  assert.notEqual(a.id, b.id); assert.notEqual(a.sessionFile, b.sessionFile);
  assert.equal(run.deliveries(a.id).length + run.deliveries(b.id).length, 0);
  await run.capture("parallel-blocked");
  const reloadAt = Date.now();
  run.action(run.parent, "/reload");
  const shutdown = await until(run.evidence, () => run.observed().find(e => e.kind === "session_shutdown" && e.data.reason === "reload" && e.at >= reloadAt), "real reload shutdown");
  run.release("parallel-a"); run.release("parallel-b");
  const restart = await until(run.evidence, () => run.observed().find(e => e.kind === "session_start" && e.data.reason === "reload" && e.at >= reloadAt), "real reload start");
  const doneDuringReload = run.observed().filter(e => e.kind === "session_shutdown" && e.data.reason === "quit" && [a.sessionFile, b.sessionFile].includes(e.session) && e.at >= shutdown.at && e.at < restart.at);
  run.assertions.parallelReload = { a, b, shutdown: shutdown.at, restart: restart.at, doneDuringReload };
  assert.ok(doneDuringReload.length >= 1, "At least one actual child must complete inside reload gap");
  await run.completion(a); await run.completion(b);
  await run.marker("parallel-a.txt", "parallel-a"); await run.marker("parallel-b.txt", "parallel-b");
  run.assertChildBash(a, "node gate.mjs parallel-a"); run.assertChildBash(b, "node gate.mjs parallel-b");
  // Recheck after the reload's reconciliation and parent acknowledgment have settled.
  assert.equal(run.deliveries(a.id).length, 1); assert.equal(run.deliveries(b.id).length, 1);
});

journey("closed resume", async run => {
  const child = await run.spawn("Closed", "Run bash: printf HISTORY > original.txt . Then finish.");
  await run.completion(child); await run.marker("original.txt", "HISTORY");
  assert.equal((await run.hc.inspect(metadata(run, child).surface)).kind, "missing");
  const resumed = await run.resume(child, "Use bash to read original.txt and copy it byte-for-byte to closed-resume.txt. Then finish.", true);
  assert.notEqual(resumed.id, child.id);
  assert.equal(canonicalSessionPath(resumed.sessionPath), canonicalSessionPath(child.sessionFile));
  await run.completion({ ...resumed, sessionFile: child.sessionFile });
  await run.marker("closed-resume.txt", "HISTORY");
  run.assertChildBash(child, "original.txt"); run.assertChildBash(child, "closed-resume.txt");
  const log = jsonLines(child.sessionFile);
  assert.ok(log.filter(e => e.message?.role === "user").length >= 2, "Saved conversation plus follow-up must coexist");
  assert.ok(log.some(e => Array.isArray(e.message?.content) && e.message.content.some((c: any) => c.type === "toolCall" && c.name === "bash" && /original\.txt/.test(c.arguments?.command || ""))));
  run.assertions.closedResume = { originalId: child.id, resumed, historyEntries: log.length };
});

journey("keepOpen followup", async run => {
  const child = await run.spawn("KeepOpen", "Run bash: printf FIRST > keep-first.txt . Summarize, then wait. Do not call subagent_done until the user's explicit completion request.", "verify-open");
  await run.marker("keep-first.txt", "FIRST");
  const first = await run.completion(child);
  assert.equal(first[0].details.keepOpen, true);
  const kept = metadata(run, child);
  assert.equal((await run.hc.inspect(kept.surface)).kind, "present");
  const pid = run.observed().find(e => e.kind === "session_start" && e.session === child.sessionFile)?.pid;
  const continued = await run.resume(child, "Run bash: printf SECOND > keep-second.txt . Summarize, then wait for the user's explicit completion request before calling subagent_done.", false);
  run.assertions.firstResultAndContinuation = { id: child.id, terminal: kept.surface, pid, continued };
  assert.equal(continued.id, child.id);
  await run.marker("keep-second.txt", "SECOND");
  const second = await run.completion(child, 2);
  await run.marker("keep-first.txt", "FIRST"); await run.marker("keep-second.txt", "SECOND");
  run.assertChildBash(child, "keep-first.txt"); run.assertChildBash(child, "keep-second.txt");
  assert.notEqual(second[0].details.eventId, second[1].details.eventId);
  assert.equal((await run.hc.inspect(kept.surface)).kind, "present");
  assert.equal(run.observed().filter(e => e.kind === "session_start" && e.session === child.sessionFile).length, 1);
  run.assertions.keepOpen = { id: child.id, terminal: kept.surface, pid, events: second.map(m => m.details.eventId) };
});

journey("interrupt live continuation", async run => {
  const child = await run.spawn("Interrupt", "Run bash: node gate.mjs interrupt . Then finish.", "verify-open");
  await run.marker("interrupt.started", "STARTED");
  const at = Date.now();
  run.action(run.parent, "Call subagent_interrupt exactly once with name Interrupt. Do not close its terminal. End your turn.");
  const ack = await until(run.evidence, () => run.results("subagent_interrupt").find(e => e.at >= at), "interrupt actual tool acknowledgement");
  assert.ok(!ack.data.isError);
  assert.equal(ack.data.result.details?.status, "interrupt_requested", "Escape dispatch must be acknowledged, not merely a non-throwing tool result");
  await until(run.evidence, () => run.observed().find(e => e.kind === "settled" && e.session === child.sessionFile && e.data.aborted === true && e.at >= at), "child aborted settlement");
  const owned = metadata(run, child);
  assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
  assert.equal(run.deliveries(child.id).length, 0, "Abort alone must not publish a result");
  assert.equal(existsSync(join(run.scratch, "interrupt.txt")), false);
  run.assertions.interruptedSurvivingChild = { id: child.id, terminal: owned.surface, noAbortResult: true };
  await run.idle(at);
  const live = await run.resume(child, "Run bash: printf SURVIVED > interrupt-followup.txt . Summarize, then wait for the user's explicit completion request before calling subagent_done.", false);
  assert.equal(live.id, child.id);
  await run.marker("interrupt-followup.txt", "SURVIVED"); await run.completion(child);
  run.assertChildBash(child, "node gate.mjs interrupt"); run.assertChildBash(child, "interrupt-followup.txt");
  assert.equal(run.observed().filter(e => e.kind === "session_start" && e.session === child.sessionFile).length, 1);
  run.assertions.liveContinuation = { id: child.id, live, terminal: owned.surface };
});

journey("parent OS death and recovery", async run => {
  const child = await run.spawn("Recovery", "Run bash: node gate.mjs recovery . Summarize, then wait. Do not call subagent_done until the user's explicit completion request.", "verify-open");
  await run.marker("recovery.started", "STARTED");
  const owned = metadata(run, child);
  const childStart = run.observed().find(e => e.kind === "session_start" && e.session === child.sessionFile);
  assert.ok(childStart?.pid);
  const before = run.manifest(); run.save("manifest-before.json", before);
  await run.killParent();
  assert.equal((await run.hc.inspect(owned.surface)).kind, "present", "Child must survive parent death");
  await run.launch(); // Exact same --session, new Pi process and terminal.
  const after = run.manifest(); run.save("manifest-recovered.json", after);
  assert.notEqual(after.generation, before.generation);
  run.assertions.recoveryDecision = { childId: child.id, childPid: childStart.pid, oldGeneration: before.generation, newGeneration: after.generation, reconciliation: after.runs[child.id].reconciliation };
  const base = runCompletionFile(child.sessionFile, child.id);
  for (const suffix of ["identity", "challenge", "response"]) copyFileSync(`${base}.${suffix}.json`, join(run.evidence, `child-${suffix}.json`));
  const challenge = JSON.parse(readFileSync(`${base}.challenge.json`, "utf8"));
  const response = JSON.parse(readFileSync(`${base}.response.json`, "utf8"));
  assert.equal(challenge.generation, after.generation); assert.deepEqual(response, challenge);
  assert.equal(challenge.process.pid, childStart.pid);
  assert.match(after.runs[child.id].reconciliation, /^verified-live: artifact-only supervision; terminal controls disabled/);
  assert.equal(run.results().length, 1, "Recovery must not auto-launch a second child");
  assert.equal(run.observed().filter(e => e.kind === "session_start" && e.session === child.sessionFile).length, 1);
  run.release("recovery");
  await run.marker("recovery.txt", "recovery"); await run.completion(child);
  const at = Date.now();
  run.action(run.parent, "Call subagent_interrupt exactly once with name Recovery. Do not retry or use other tools. End your turn.");
  const rejected = await until(run.evidence, () => run.results("subagent_interrupt").find(e => e.at >= at), "recovered interrupt rejection");
  assert.match(rejected.data.result.details?.error || "", /custody.*(?:detached|unverified)|^No running subagent named "Recovery"\.$/i);
  assert.notEqual(rejected.data.result.details?.status, "interrupt_requested");
  assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
  run.assertions.recoveredControlRejected = rejected.data.result;
  await run.idle(at);
  // Test driver's independent terminal custody is not recovered orchestrator control.
  run.action(owned.surface, "Run bash: printf RECOVERED_SECOND > recovered-second.txt . Summarize, then wait. Do not call subagent_done until the user's explicit completion request.");
  await run.marker("recovered-second.txt", "RECOVERED_SECOND");
  const second = await run.completion(child, 2);
  run.assertChildBash(child, "node gate.mjs recovery"); run.assertChildBash(child, "recovered-second.txt");
  assert.notEqual(second[0].details.eventId, second[1].details.eventId);
  run.assertions.retainedResults = { events: second.map(m => m.details.eventId), exactlyOnceClaim: false };
});
