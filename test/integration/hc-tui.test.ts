import assert from "node:assert/strict";
import { existsSync, readFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { HcTuiRun, jsonLines, until } from "./hc-tui-harness.ts";
import { runCompletionFile } from "../../pi-extension/subagents/run-artifacts.ts";
import { canonicalSessionPath } from "../../pi-extension/subagents/ownership.ts";
import { probeProcess } from "../../pi-extension/subagents/process-identity.ts";
import { closeDir } from "../../pi-extension/subagents/close-control.ts";
import { sameBatchModel, sameBatchScenario, type SameBatchIntent } from "./hc-same-batch-provider.ts";

const options = { skip: process.env.PI_TEST_HC_TUI !== "1", timeout: 600_000 };
function journey(name: string, verify: (run: HcTuiRun) => Promise<void>, sameBatch?: SameBatchIntent) {
  it(`real HC Pi TUI: ${name}`, options, async () => {
    const run = new HcTuiRun(name.replace(/[^a-z]+/gi, "-"), sameBatch);
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

// These journeys each own a fresh parent and exactly one child. Observe disk
// publication as well as parent messages: a delayed watcher is not a pass.
function retainedCompletions(child: any) {
  const base = runCompletionFile(child.sessionFile, child.id), directory = `${base}.events`;
  const files = [
    ...(existsSync(base) ? [base] : []),
    ...(existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json")).map(name => join(directory, name)) : []),
  ];
  return files.map(path => ({ path, modifiedAt: statSync(path).mtimeMs, payload: JSON.parse(readFileSync(path, "utf8")) }));
}
async function assertNoChildPublication(run: HcTuiRun, child: any) {
  const owned = metadata(run, child);
  assert.equal(retainedCompletions(child).length, 0, "No original run completion sidecar may be published");
  assert.equal(run.messages().filter(m => m.customType === "subagent_result" || m.customType === "subagent_ping").length, 0,
    "Neither a result nor a ping may reach this fresh parent");
  assert.equal(run.observed().filter(e => e.terminal === owned.surface && e.kind === "session_shutdown" && e.data.reason === "quit").length, 0,
    "The owned child must not request quit");
  const text = await run.hc.readAsync(owned.surface, 0);
  assert.equal(text.split(`__SUBAGENT_DONE_${child.id}_`).slice(1).some(tail => /^\d+__/.test(tail)), false,
    "No actual launcher exit sentinel (as distinct from echoed script source)");
}

journey("manual Escape live continuation", async run => {
  const child = await run.spawn("ManualEscape", "Run only bash with command node gate.mjs manual-escape and timeout 300. Do not call subagent_done or caller_ping before this gate finishes.", "verify-open");
  await run.marker("manual-escape.started", "STARTED");
  const owned = metadata(run, child);
  const start = run.observed().find(e => e.kind === "session_start" && e.session === child.sessionFile && e.terminal === owned.surface);
  assert.equal(start?.mode, "tui"); assert.ok(start?.pid);
  const gate = run.observed().find(e => e.kind === "tool_start" && e.session === child.sessionFile && e.data.toolName === "bash" && e.data.args?.command === "node gate.mjs manual-escape");
  assert.ok(gate, "Unmet precondition: actual child bash gate required before manual Escape");
  assert.equal(gate.pid, start.pid); assert.equal(gate.terminal, owned.surface);
  assert.equal(run.observed().some(e => e.session === child.sessionFile && e.kind === "tool_end" && e.data.toolCallId === gate.data.toolCallId), false, "Gate must still be active");
  assert.equal(run.observed().some(e => e.session === child.sessionFile && e.kind === "tool_start" && ["subagent_done", "caller_ping"].includes(e.data.toolName)), false, "Abort must be unstaged");
  await assertNoChildPublication(run, child);
  await run.capture("before-manual-escape");
  const at = Date.now();
  await run.viewerEscape(owned.surface); // Literal Escape in our child, not subagent_interrupt or Ctrl+C.
  const aborted = await until(run.evidence, () => run.observed().find(e => e.kind === "settled" && e.session === child.sessionFile && e.pid === start.pid && e.at >= at && e.data.aborted === true), "manual Escape aborted child settlement", 15_000);
  assert.equal(run.results("subagent_interrupt").length, 0);
  assert.equal(existsSync(join(run.scratch, "manual-escape.release")), false);
  assert.equal(existsSync(join(run.scratch, "manual-escape.txt")), false);
  assert.equal(probeProcess(start.pid).kind, "present");
  assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
  await assertNoChildPublication(run, child);
  run.assertions.manualEscape = { start, gate, aborted, noAbortPublication: true };
  const resumed = await run.resume(child, "Run bash: printf MANUAL_SURVIVED > manual-escape-followup.txt . Then call subagent_done exactly once with close false, and wait without exiting.", false);
  assert.equal(resumed.id, child.id);
  await run.marker("manual-escape-followup.txt", "MANUAL_SURVIVED");
  const result = await run.completion(child);
  assert.equal(result[0].details.keepOpen, true);
  const followup = run.observed().find(e => e.kind === "tool_start" && e.session === child.sessionFile && e.data.toolName === "bash" && e.data.args?.command?.includes("manual-escape-followup.txt"));
  assert.ok(followup); assert.equal(followup.pid, start.pid); assert.equal(followup.terminal, owned.surface);
  assert.equal(run.observed().filter(e => e.kind === "session_start" && e.terminal === owned.surface).length, 1, "Continuation must not relaunch Pi");
  assert.equal(probeProcess(start.pid).kind, "present");
  assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
  assert.equal(existsSync(join(run.scratch, "manual-escape.txt")), false);
  run.assertChildBash(child, "node gate.mjs manual-escape"); run.assertChildBash(child, "manual-escape-followup.txt");
  run.assertions.manualEscapeContinuation = { resumed, followup, eventId: result[0].details.eventId };
});

journey("literal new after guarded abort detaches original supervision", async run => {
  const child = await run.spawn("NewSession", "Run only bash with command node gate.mjs before-new and timeout 300. Do not call subagent_done or caller_ping before this gate finishes.", "verify-open");
  await run.marker("before-new.started", "STARTED");
  const owned = metadata(run, child);
  const start = run.observed().find(e => e.kind === "session_start" && e.session === child.sessionFile && e.terminal === owned.surface);
  assert.equal(start?.mode, "tui"); assert.ok(start?.pid); assert.ok(start?.sessionId);
  const header = jsonLines(child.sessionFile).find(e => e.type === "session");
  assert.equal(header?.id, start.sessionId);
  const gate = run.observed().find(e => e.kind === "tool_start" && e.session === child.sessionFile && e.data.toolName === "bash" && e.data.args?.command === "node gate.mjs before-new");
  assert.ok(gate, "Unmet precondition: unstaged active bash gate required before /new");
  assert.equal(gate.pid, start.pid); assert.equal(gate.terminal, owned.surface);
  const gateActive = () => !run.observed().some(e => e.session === child.sessionFile && e.kind === "tool_end" && e.data.toolCallId === gate.data.toolCallId);
  assert.ok(gateActive(), "Gate must still be active");
  assert.equal(run.observed().some(e => e.session === child.sessionFile && e.kind === "tool_start" && ["subagent_done", "caller_ping"].includes(e.data.toolName)), false);
  await assertNoChildPublication(run, child);
  await run.capture("before-literal-new");
  const at = Date.now();
  // HC's named-key transport can wait indefinitely for a quiet active TUI.
  // Prove idle /new explicitly; this is NOT manual Escape or busy-/new proof.
  run.action(run.parent, `Call subagent_interrupt exactly once with id ${JSON.stringify(child.id)}. Do not use other tools or retry. End your turn.`);
  const requested = await until(run.evidence, () => run.results("subagent_interrupt").find(e => e.at >= at), "guarded abort before idle /new");
  assert.equal(requested.data.result.details?.status, "interrupt_requested");
  await until(run.evidence, () => run.observed().find(e => e.kind === "settled" && e.session === child.sessionFile && e.pid === start.pid && e.at >= at && e.data.aborted === true), "confirmed abort before idle /new");
  await run.idle(at);
  await assertNoChildPublication(run, child);
  const precondition = "literal idle /new after guarded tool abort and confirmed aborted settlement; NOT manual Escape or direct busy /new proof";
  run.assertions.newSessionPrecondition = precondition;
  run.action(owned.surface, "/new"); // Literal HC keys, never a tagged model prompt.
  const replacement = await until(run.evidence, () => run.observed().find(e => e.kind === "session_start" && e.terminal === owned.surface && e.data.reason === "new" && e.at >= at), "literal idle /new replacement");
  assert.equal(replacement.mode, "tui"); assert.equal(replacement.pid, start.pid); assert.equal(replacement.terminal, owned.surface);
  assert.ok(replacement.session); assert.ok(replacement.sessionId);
  assert.notEqual(canonicalSessionPath(replacement.session), canonicalSessionPath(child.sessionFile));
  assert.notEqual(replacement.sessionId, header.id, "Replacement must have a different session header, not just another path");
  const aborted = run.observed().find(e => e.kind === "settled" && e.session === child.sessionFile && e.pid === start.pid && e.data.aborted === true && e.at >= at && e.at <= replacement.at);
  const shutdown = run.observed().find(e => e.kind === "session_shutdown" && e.session === child.sessionFile && e.terminal === owned.surface && e.data.reason === "new" && e.at >= at && e.at <= replacement.at);
  assert.ok(aborted); assert.ok(shutdown); assert.ok(aborted.at <= shutdown.at);
  assert.equal(existsSync(join(run.scratch, "before-new.release")), false);
  assert.equal(existsSync(join(run.scratch, "before-new.txt")), false);
  await assertNoChildPublication(run, child);
  const replacementAt = Date.now();
  run.action(owned.surface, "Run bash: printf NEW_SESSION_SURVIVED > new-session-marker.txt . After bash succeeds reply exactly NEW_SESSION_SURVIVED. Do not call subagent_done, caller_ping, or any other tool; do not quit.");
  await run.marker("new-session-marker.txt", "NEW_SESSION_SURVIVED");
  const settled = await until(run.evidence, () => run.observed().find(e => e.kind === "settled" && e.session === replacement.session && e.pid === start.pid && e.at >= replacementAt && e.data.aborted === false), "replacement real bash turn settled");
  const replacementHeader = jsonLines(replacement.session).find(e => e.type === "session");
  assert.equal(replacementHeader?.id, replacement.sessionId); assert.notEqual(replacementHeader.id, header.id);
  run.assertChildBash({ sessionFile: replacement.session }, "new-session-marker.txt");
  const replacementBash = run.observed().find(e => e.kind === "tool_start" && e.session === replacement.session && e.data.toolName === "bash" && e.data.args?.command?.includes("new-session-marker.txt"));
  assert.equal(replacementBash?.pid, start.pid); assert.equal(replacementBash?.terminal, owned.surface);
  assert.ok(jsonLines(replacement.session).some(e => e.message?.role === "assistant" && e.message.content?.some((c: any) => c.type === "text" && c.text.trim() === "NEW_SESSION_SURVIVED")));
  assert.equal(probeProcess(start.pid).kind, "present");
  assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
  assert.equal(run.observed().filter(e => e.kind === "session_start" && e.terminal === owned.surface).length, 2, "No replacement process or extra session launch");
  await assertNoChildPublication(run, child);
  copyFileSync(child.sessionFile, join(run.evidence, `child-${child.id}-before-new.jsonl`));
  copyFileSync(replacement.session, join(run.evidence, `child-${child.id}-after-new.jsonl`));
  run.assertions.newSession = { precondition, start, header, gate, aborted, shutdown, replacement, replacementHeader, settled, noOriginalPublication: true, sameProcessSurvived: true };
  await run.capture("replacement-survived");
});

for (const intent of ["done", "ping"] as const) {
  journey(`staged ${intent} waits for same batch bash sibling`, async run => {
    const { gateName, command, toolName, finalText, pingMessage, args } = sameBatchScenario(intent, run.id);
    const child = await run.spawn(`Batch${intent}`, `Exercise ${toolName} and gated bash in one assistant message, then reply ${finalText}.`, "verify-open");
    const owned = metadata(run, child);
    const attempt = await until(run.evidence, () => {
      const batch = jsonLines(child.sessionFile).find(e => e.message?.role === "assistant" && e.message.content?.some((c: any) => c.type === "toolCall" && c.name === "bash" && c.arguments?.command === command));
      const settled = run.observed().find(e => e.kind === "settled" && e.session === child.sessionFile);
      return batch || settled ? { batch, settled } : undefined;
    }, `Unmet precondition: scripted input must supply ${toolName} and gated bash in the same assistant tool batch`);
    run.assertions.sameBatchPrecondition = { toolName, childModel: sameBatchModel, attempt };
    assert.ok(attempt.batch, `Unmet precondition: child settled without the required ${toolName} + bash assistant batch; no sequential substitute is allowed`);
    assert.equal(`${attempt.batch.message.provider}/${attempt.batch.message.model}`, sameBatchModel);
    const calls = attempt.batch.message.content.filter((c: any) => c.type === "toolCall");
    assert.equal(calls.length, 2, "Unmet precondition: exactly the two requested real sibling calls are required");
    assert.equal(calls[0].name, toolName, "Unmet precondition: staged intent must be in the gate's actual assistant message");
    assert.deepEqual(calls[0].arguments, args);
    assert.equal(calls[1].name, "bash"); assert.equal(calls[1].arguments.command, command);
    const start = run.observed().find(e => e.kind === "session_start" && e.session === child.sessionFile && e.terminal === owned.surface);
    assert.equal(start?.mode, "tui"); assert.ok(start?.pid);
    const staged = await until(run.evidence, () => run.observed().find(e => e.kind === "tool_end" && e.session === child.sessionFile && e.data.toolCallId === calls[0].id), "actual recorded staged intent while bash sibling is blocked");
    assert.equal(staged.data.toolName, toolName); assert.equal(staged.data.isError, false);
    assert.match(staged.data.result.content.map((c: any) => c.text || "").join("\n"), intent === "done" ? /Result staged for settlement/ : /Ping staged/);
    await run.marker(`${gateName}.started`, "STARTED");
    const gate = run.observed().find(e => e.kind === "tool_start" && e.session === child.sessionFile && e.data.toolCallId === calls[1].id && e.data.toolName === "bash");
    assert.ok(gate); assert.equal(gate.pid, start.pid); assert.equal(gate.terminal, owned.surface);
    assert.equal(staged.pid, start.pid); assert.equal(staged.terminal, owned.surface);
    assert.equal(run.observed().some(e => e.session === child.sessionFile && e.kind === "tool_end" && e.data.toolCallId === calls[1].id), false, "Intent must actually be staged while its real bash sibling is still blocked");
    assert.equal(run.observed().some(e => e.kind === "settled" && e.session === child.sessionFile), false, "No settlement before sibling release");
    assert.equal(existsSync(join(run.scratch, `${gateName}.release`)), false);
    assert.equal(existsSync(join(run.scratch, `${gateName}.txt`)), false);
    await assertNoChildPublication(run, child);
    assert.equal(probeProcess(start.pid).kind, "present");
    assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
    run.assertions.stagedWhileSiblingBlocked = { assistantEntryId: attempt.batch.id, calls, staged, gate, noPublication: true, noQuit: true };
    await run.capture("staged-sibling-blocked");
    const releasedAt = Date.now();
    run.release(gateName);
    await run.marker(`${gateName}.txt`, gateName);
    const ended = await until(run.evidence, () => run.observed().find(e => e.kind === "tool_end" && e.session === child.sessionFile && e.data.toolCallId === calls[1].id), "actual gated bash sibling finished");
    assert.equal(ended.data.isError, false); assert.ok(ended.at >= releasedAt);
    const settled = await until(run.evidence, () => run.observed().find(e => e.kind === "settled" && e.session === child.sessionFile && e.pid === start.pid && e.at >= ended.at && e.data.aborted === false), "actual child settlement after sibling completion");
    let delivery: any;
    if (intent === "done") {
      [delivery] = await run.completion(child);
      assert.equal(delivery.details.keepOpen, true); assert.equal(delivery.details.response, finalText);
      assert.equal((await run.hc.inspect(owned.surface)).kind, "present");
      assert.equal(probeProcess(start.pid).kind, "present");
      assert.equal(run.observed().some(e => e.kind === "session_shutdown" && e.terminal === owned.surface), false);
      assert.equal(run.messages().filter(m => m.customType === "subagent_ping").length, 0);
    } else {
      const pings = () => run.messages().filter(m => m.customType === "subagent_ping" && m.details?.sessionFile === child.sessionFile);
      delivery = await until(run.evidence, () => pings()[0], "actual parent subagent_ping after sibling settlement");
      const timestamp = typeof delivery.timestamp === "number" ? delivery.timestamp : Date.parse(delivery.timestamp);
      await run.idle(timestamp);
      assert.equal(pings().length, 1); assert.equal(delivery.details.message, pingMessage);
      assert.equal(run.deliveries(child.id).length, 0, "Ping must not also produce a result");
      const quit = await until(run.evidence, () => run.observed().find(e => e.kind === "session_shutdown" && e.session === child.sessionFile && e.data.reason === "quit"), "ping child quits only after real settlement");
      assert.ok(quit.at >= settled.at); assert.ok(quit.at >= releasedAt);
      copyFileSync(child.sessionFile, join(run.evidence, `child-${child.id}.jsonl`));
    }
    const deliveredAt = typeof delivery.timestamp === "number" ? delivery.timestamp : Date.parse(delivery.timestamp);
    assert.ok(deliveredAt >= settled.at, "Parent notification must follow actual agent_settled, not merely intent staging");
    const retained = retainedCompletions(child);
    assert.equal(retained.length, 1); assert.equal(retained[0].payload.type, intent === "done" ? "done" : "ping");
    assert.ok(retained[0].modifiedAt >= settled.at, "Immutable completion bytes must be written after actual settlement, not staged early for delayed delivery");
    assert.equal(retained[0].payload.summary, finalText, "Publication must contain the real final post-sibling assistant response");
    run.save("settled-sibling-completion.json", retained);
    run.assertChildBash(child, command);
    assert.equal(run.observed().filter(e => e.kind === "session_start" && e.terminal === owned.surface).length, 1);
    run.assertions.siblingSettlement = { intent, assistantEntryId: attempt.batch.id, releasedAt, ended, settled, deliveredAt, delivery, retained };
  }, intent);
}

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
