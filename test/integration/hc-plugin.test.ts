import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { it } from "node:test";
import { HcTuiRun, childSurface, jsonLines, literalHcKeys, until } from "./hc-tui-harness.ts";
import { canonicalSessionPath } from "../../pi-extension/subagents/ownership.ts";

const options = { skip: process.env.PI_TEST_HC_TUI !== "1", timeout: 600_000 };
const planEntryType = "pi-subagents-plan/v1";
const checkpointEntryType = "pi-subagents-context-checkpoint/v1";

function journey(name: string, verify: (run: HcTuiRun) => Promise<void>) {
  it(`real HC Pi plugin: ${name}`, options, async () => {
    const run = new HcTuiRun(name.replace(/[^a-z]+/gi, "-"));
    let failure: unknown;
    try {
      await run.launch();
      await run.idle();
      await verify(run);
    } catch (error) { failure = error; }
    // Always tear down, preserving both errors rather than masking the journey.
    try {
      await run.finish(failure);
      const cleanup = JSON.parse(readFileSync(join(run.evidence, "cleanup.json"), "utf8"));
      assert.equal(cleanup.allMissing, true);
      assert.deepEqual(cleanup.unresolved, []);
    } catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], "Journey and cleanup both failed") : cleanupError;
    } finally { console.log(`HC plugin ${name} evidence: ${run.evidence}`); }
    if (failure) throw failure;
  });
}

function text(result: any): string {
  return result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
}

/** Drive only a registered public tool through the real parent model. */
async function tool(run: HcTuiRun, name: string, args: Record<string, unknown>, isError = false) {
  const count = run.results(name).length, offset = run.observed().length;
  run.action(run.parent, `Call ${name} exactly once with this exact JSON argument object: ${JSON.stringify(args)}. Do not substitute arguments, retry even on error, invoke another tool, poll, or perform the task yourself. Report the actual tool result briefly and end your turn. Later child completion will arrive automatically.`);
  const event = await until(run.evidence, () => run.results(name)[count], `actual public ${name} result`);
  await run.idle(event.at);
  assert.equal(run.results(name).length, count + 1, `${name} must not be retried`);
  const starts = run.observed().slice(offset).filter(e => e.kind === "tool_start" && e.session === run.parentSession);
  assert.equal(starts.length, 1, "Exactly the requested public tool, not a model workaround");
  assert.equal(starts[0].data.toolName, name);
  assert.equal(starts[0].data.toolCallId, event.data.toolCallId);
  assert.deepEqual(starts[0].data.args, args);
  assert.equal(event.data.isError, isError, `${name}: ${text(event.data.result)}`);
  const saved = run.messages().find(message => message.role === "toolResult" && message.toolCallId === event.data.toolCallId);
  assert.ok(saved, "The actual public tool result must be saved in the parent conversation");
  assert.equal(saved.isError, isError);
  assert.equal(text(saved), text(event.data.result));
  run.assertions[`${name}-${count}`] = { call: starts[0], result: event, saved };
  return event;
}

function nativeEntries(run: HcTuiRun, customType: string) {
  return jsonLines(run.parentSession).filter(entry => entry.type === "custom" && entry.customType === customType);
}

/** Slash launches are discovered from actual child startup + this parent's
 * durable manifest, never from a presumed subagent tool_end acknowledgement. */
async function discoverChild(run: HcTuiRun, before: string[]) {
  const found = await until(run.evidence, () => {
    const manifest = run.manifestIfPresent();
    if (!manifest) return undefined;
    assert.equal(canonicalSessionPath(manifest.parent.sessionFile), canonicalSessionPath(run.parentSession));
    const candidates = Object.values(manifest.runs).filter((child: any) => !before.includes(child.id)) as any[];
    if (!candidates.length) return undefined;
    assert.equal(candidates.length, 1, "Exactly one new durable child run");
    const child = candidates[0];
    if (!child.launchScriptFile || !existsSync(child.launchScriptFile)) return undefined;
    const start = run.observed().find(e => e.kind === "session_start" && e.terminal === child.surface &&
      e.session && canonicalSessionPath(e.session) === canonicalSessionPath(child.sessionFile));
    return start ? { child, start } : undefined;
  }, "child session_start correlated with parent's durable manifest");
  const { child, start } = found;
  assert.ok(resolve(child.launchScriptFile).startsWith(resolve(run.artifactDirectory()) + sep), "Launch script must be in this parent's custody");
  assert.match(child.surface, /^t[a-z0-9]+$/);
  assert.notEqual(child.surface, run.parent);
  assert.equal(childSurface(readFileSync(child.launchScriptFile, "utf8")), child.surface);
  assert.equal(start.mode, "tui");
  assert.ok(start.pid);
  assert.notEqual(start.pid, run.parentPid());
  assert.equal(run.registerChild(child), child.surface);
  const header = jsonLines(child.sessionFile).find(entry => entry.type === "session");
  assert.ok(header?.id);
  assert.equal(header.id, start.sessionId);
  assert.notEqual(canonicalSessionPath(child.sessionFile), canonicalSessionPath(run.parentSession));
  run.assertions[`discovered-${child.id}`] = { child, start, header };
  return child;
}

async function markerCompletion(run: HcTuiRun, child: any, file: string, marker: string) {
  await run.marker(file, marker);
  const [delivery] = await run.completion(child);
  run.assertChildBash(child, file);
  const bash = run.observed().filter(e => e.kind === "tool_start" && e.session && canonicalSessionPath(e.session) === canonicalSessionPath(child.sessionFile) &&
    e.data.toolName === "bash" && e.data.args?.command?.includes(file));
  assert.ok(bash.some(start => run.observed().some(end => end.kind === "tool_end" && end.session && canonicalSessionPath(end.session) === canonicalSessionPath(child.sessionFile) &&
    end.data.toolCallId === start.data.toolCallId && end.data.isError === false)), "The child's marker bash must actually succeed");
  assert.equal(canonicalSessionPath(delivery.details.sessionFile), canonicalSessionPath(child.sessionFile));
  assert.equal(delivery.details.task, child.task);
  assert.equal(delivery.details.exitCode, 0);
  assert.ok(delivery.details.response?.trim(), "Parent must receive the actual child response");
  run.assertions[`marker-result-${child.id}`] = { file, marker, delivery };
}

journey("project discovery and literal named slash launch", async run => {
  const listed = await tool(run, "subagents_list", {});
  const agents = listed.data.result.details.agents;
  for (const name of ["verify-worker", "verify-open"]) {
    const matches = agents.filter((agent: any) => agent.name === name);
    assert.equal(matches.length, 1);
    const agent = matches[0];
    assert.equal(agent.source, "project");
    assert.equal(canonicalSessionPath(agent.sourcePath), canonicalSessionPath(join(run.scratch, ".pi", "agents", `${name}.md`)));
    assert.equal(agent.model, process.env.PI_TEST_MODEL || "openai-codex/gpt-6.1-sol");
    assert.equal(agent.autoExit, name === "verify-worker");
    assert.ok(text(listed.data.result).includes(`${name} (project)`), "Actual list content must expose the project role");
  }
  const before = Object.keys(run.manifestIfPresent()?.runs ?? {});
  assert.deepEqual(before, []);
  // HC's named-key driver is lossless only for this lowercase-safe alphabet.
  const marker = `slash-${randomUUID()}`, file = "slash-marker.txt";
  const task = `run bash to write exactly ${marker} with no newline into ${file}. then summarize the completed work and finish. never delegate or poll.`;
  const command = `/subagent verify-worker ${task}`;
  run.keys(run.parent, ...literalHcKeys(command), "enter");
  const child = await discoverChild(run, before);
  assert.equal(child.name, "Verify-worker");
  assert.equal(child.task, task);
  await markerCompletion(run, child, file, marker);
  const actions = jsonLines(join(run.evidence, "actions.jsonl"));
  assert.ok(actions.some(action => action.target === run.parent && JSON.stringify(action.keys) === JSON.stringify([...literalHcKeys(command), "enter"])));
  assert.equal(Object.keys(run.manifest().runs).length, 1);
  await run.capture("literal-slash-result");
});

journey("explicit fork inherits context and saves unique parent linkage", async run => {
  const token = `FORK_CONTEXT_${randomUUID()}`, ack = `CONTEXT_ACK_${randomUUID()}`;
  const offset = run.observed().length, at = Date.now();
  run.action(run.parent, `Remember this verification context token for a later child: ${token}. Reply exactly ${ack}. Do not call tools.`);
  await until(run.evidence, () => run.messages().find(message => message.role === "assistant" &&
    message.content?.some((block: any) => block.type === "text" && block.text.trim() === ack)), "real context acknowledgement");
  await run.idle(at);
  assert.equal(run.observed().slice(offset).filter(e => e.kind === "tool_start").length, 0);
  const remembered = jsonLines(run.parentSession).find(entry => entry.message?.role === "user" &&
    entry.message.content?.some((block: any) => block.type === "text" && block.text.includes(token)));
  assert.ok(remembered?.id);
  const before = Object.keys(run.manifestIfPresent()?.runs ?? {}), file = "fork-token.txt";
  const task = `Use the verification context token supplied earlier in the inherited parent conversation. Run bash to write that exact token with no newline into ${file}. Do not ask the parent or inspect files to find the token. Then summarize and finish. Never delegate.`;
  assert.equal(task.includes(token), false, "The delegated task must not leak the answer");
  const spawned = await tool(run, "subagent", { name: "ForkVerify", agent: "verify-worker", fork: true, task });
  assert.equal(spawned.data.result.details.status, "started");
  const child = await discoverChild(run, before);
  assert.equal(child.id, spawned.data.result.details.id);
  assert.equal(child.task, task);
  const parentHeader = jsonLines(run.parentSession).find(entry => entry.type === "session");
  const childLog = jsonLines(child.sessionFile), header = childLog.find(entry => entry.type === "session");
  assert.equal(canonicalSessionPath(header.parentSession), canonicalSessionPath(run.parentSession));
  assert.notEqual(header.id, parentHeader.id, "Fork must have a distinct saved session identity");
  assert.ok(childLog.some(entry => entry.id === remembered.id && JSON.stringify(entry.message) === JSON.stringify(remembered.message)), "Original context turn must actually be inherited, not repeated in the task");
  await markerCompletion(run, child, file, token);
  const childTools = run.observed().filter(event => event.kind === "tool_start" && event.session && canonicalSessionPath(event.session) === canonicalSessionPath(child.sessionFile));
  assert.ok(childTools.some(event => event.data.toolName === "bash" && event.data.args?.command?.includes(file) &&
    event.data.args.command.includes(token)), "Child must supply the inherited token in its actual marker bash");
  assert.equal(childTools.some(event => ["read", "write"].includes(event.data.toolName)), false, "The fork token must not be obtained or written through a file-tool workaround");
  run.assertions.explicitFork = { token, rememberedEntryId: remembered.id, parentHeader, childHeader: header, childId: child.id, childTools };
  await run.capture("fork-context-result");
});

journey("invalid named tool agent rejects before child work and parent recovers", async run => {
  const missing = `missing-agent-${randomUUID()}`;
  const before = run.manifestIfPresent(), offset = run.observed().length;
  const scripts = () => existsSync(run.artifactDirectory())
    ? readdirSync(run.artifactDirectory(), { recursive: true }).map(String).filter(path => path.endsWith(".sh")).sort() : [];
  const beforeScripts = scripts();
  assert.deepEqual(Object.keys(before?.runs ?? {}), []);
  const rejected = await tool(run, "subagent", {
    name: "InvalidNamed", agent: missing,
    task: "Run bash to create invalid-agent-must-not-exist.txt. Then finish.",
  }, true);
  const error = text(rejected.data.result);
  assert.ok(error.includes(missing), "Actual public error must identify the invalid agent");
  assert.match(error, /unavailable|not found/i);
  assert.notEqual(rejected.data.result.details?.status, "started");
  const after = run.manifestIfPresent(), events = run.observed().slice(offset);
  assert.deepEqual(after?.runs ?? {}, before?.runs ?? {});
  assert.deepEqual(after?.outbox ?? {}, before?.outbox ?? {});
  assert.deepEqual(scripts(), beforeScripts, "Rejection must create no child launch script");
  assert.ok(events.every(event => event.terminal === run.parent && event.session === run.parentSession), "No child session, process, surface observation or model turn may occur");
  assert.deepEqual([...run.owned], [run.parent]);
  assert.equal(run.messages().filter(message => message.customType === "subagent_result").length, 0);
  assert.equal(existsSync(join(run.scratch, "invalid-agent-must-not-exist.txt")), false);
  run.save("invalid-agent-before.json", { manifest: before ?? null });
  run.save("invalid-agent-after.json", { manifest: after ?? null });
  run.assertions.invalidAgent = { missing, rejected, noChildEvents: events, noLaunchScripts: beforeScripts };
  const file = "after-invalid.txt", marker = `PARENT_USABLE_${randomUUID()}`;
  const acknowledged = await run.spawn("AfterInvalid", `Run bash to write exactly ${marker} with no newline into ${file}. Then summarize and finish.`);
  const child = await discoverChild(run, Object.keys(after?.runs ?? {}));
  assert.equal(child.id, acknowledged.id);
  await markerCompletion(run, child, file, marker);
  assert.equal(run.results().length, 2, "One rejected request followed by exactly one usable spawn");
  assert.equal(Object.keys(run.manifest().runs).length, 1);
  await run.capture("usable-after-invalid-agent");
});

journey("durable plan and checkpoint survive literal reload with revision guards", async run => {
  const initial = JSON.parse(text((await tool(run, "plan_read", {})).data.result));
  assert.equal(initial.writable, true);
  assert.equal(initial.snapshot, undefined);
  const title = `HC durable plan ${run.id}`;
  const created = await tool(run, "plan_update", { expectedRevision: 0, command: { action: "create", title } });
  const identity = JSON.parse(text(created.data.result));
  assert.ok(identity.planId);
  assert.equal(identity.revision, 0);
  const firstTitle = "Preserve the first durable task";
  const added = await tool(run, "plan_update", { expectedRevision: 0, command: { action: "add", planId: identity.planId, title: firstTitle } });
  const receipt = JSON.parse(text(added.data.result));
  assert.equal(receipt.planId, identity.planId);
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.tasks.length, 1);
  const state = {
    goal: `CHECKPOINT_GOAL_${randomUUID()}`,
    decisions: ["Keep the same plan identity across reload"],
    nextSteps: ["Reject a stale revision, then add with the current revision"],
    verification: ["Compare public tool results with native saved session entries"],
    refs: ["hc-plugin.test.ts:durable-reload"],
  };
  const saved = await tool(run, "context_checkpoint", { action: "save", ...state });
  const saveReceipt = JSON.parse(text(saved.data.result));
  assert.equal(saveReceipt.status, "saved");
  assert.equal(saveReceipt.durable, true);
  const beforePlan = JSON.parse(text((await tool(run, "plan_read", {})).data.result));
  const beforeCheckpoint = JSON.parse(text((await tool(run, "context_checkpoint", { action: "read" })).data.result));
  assert.equal(beforePlan.snapshot.planId, identity.planId);
  assert.equal(beforePlan.snapshot.revision, 1);
  assert.equal(beforePlan.snapshot.tasks[0].taskId, receipt.tasks[0].taskId);
  assert.equal(beforePlan.snapshot.tasks[0].title, firstTitle);
  assert.equal(beforeCheckpoint.entryId, saveReceipt.entryId);
  assert.equal(beforeCheckpoint.writable, true);
  assert.equal(beforeCheckpoint.inherited, false);
  assert.deepEqual(beforeCheckpoint.checkpoint.workingState, state);
  assert.equal(beforeCheckpoint.checkpoint.plan.planId, identity.planId);
  assert.equal(beforeCheckpoint.checkpoint.plan.revision, 1);
  const planEntries = nativeEntries(run, planEntryType), checkpoints = nativeEntries(run, checkpointEntryType);
  assert.equal(planEntries.length, 2);
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(checkpoints[0].data, beforeCheckpoint.checkpoint);
  assert.equal(checkpoints[0].id, beforeCheckpoint.entryId);
  assert.equal(beforeCheckpoint.checkpoint.plan.entryId, planEntries.at(-1).id);
  const header = jsonLines(run.parentSession).find(entry => entry.type === "session");
  assert.equal(beforeCheckpoint.checkpoint.originSessionId, header.id);
  assert.equal(beforePlan.snapshot.authority.sessionId, header.id);
  const offset = run.observed().length, users = run.messages().filter(message => message.role === "user").length;
  run.keys(run.parent, ..."/reload".split(""), "enter");
  const shutdown = await until(run.evidence, () => run.observed().slice(offset).find(event => event.kind === "session_shutdown" && event.session === run.parentSession && event.data.reason === "reload"), "literal reload shutdown");
  const restart = await until(run.evidence, () => run.observed().slice(offset).find(event => event.kind === "session_start" && event.session === run.parentSession && event.data.reason === "reload"), "literal reload restored parent");
  assert.ok(restart.at >= shutdown.at);
  assert.equal(restart.pid, shutdown.pid);
  assert.equal(restart.terminal, run.parent);
  assert.equal(restart.sessionId, header.id);
  assert.equal(restart.mode, "tui");
  for (const name of ["plan_read", "plan_update", "context_checkpoint"]) {
    assert.equal(restart.data.tools.filter((registered: any) => registered.name === name).length, 1);
  }
  assert.equal(run.messages().filter(message => message.role === "user").length, users, "Literal /reload must not become a model prompt");
  const afterPlan = JSON.parse(text((await tool(run, "plan_read", {})).data.result));
  const afterCheckpoint = JSON.parse(text((await tool(run, "context_checkpoint", { action: "read" })).data.result));
  assert.deepEqual(afterPlan, beforePlan, "Actual plan_read must preserve planId, revision, authority and task");
  assert.deepEqual(afterCheckpoint, beforeCheckpoint, "Actual checkpoint read must preserve notes, pointer, timestamp and entryId");
  assert.deepEqual(nativeEntries(run, planEntryType), planEntries);
  assert.deepEqual(nativeEntries(run, checkpointEntryType), checkpoints);
  const staleTitle = "STALE_WRITE_MUST_NOT_PERSIST";
  const stale = await tool(run, "plan_update", { expectedRevision: 0, command: { action: "add", planId: identity.planId, title: staleTitle } }, true);
  assert.match(text(stale.data.result), /Revision conflict/);
  assert.deepEqual(nativeEntries(run, planEntryType), planEntries, "A rejected stale write must not append a plan");
  const currentTitle = "Current revision succeeds after reload";
  const updated = await tool(run, "plan_update", { expectedRevision: afterPlan.snapshot.revision, command: { action: "add", planId: identity.planId, title: currentTitle } });
  const current = JSON.parse(text(updated.data.result));
  assert.equal(current.planId, identity.planId);
  assert.equal(current.revision, 2);
  assert.deepEqual(current.authority, identity.authority);
  const finalPlan = JSON.parse(text((await tool(run, "plan_read", {})).data.result));
  assert.equal(finalPlan.snapshot.planId, identity.planId);
  assert.equal(finalPlan.snapshot.revision, 2);
  assert.deepEqual(finalPlan.snapshot.tasks.map((task: any) => task.title), [firstTitle, currentTitle]);
  const finalEntries = nativeEntries(run, planEntryType);
  assert.equal(finalEntries.length, planEntries.length + 1);
  assert.equal(finalEntries.at(-1).data.revision, 2);
  assert.deepEqual(finalEntries.at(-1).data.tasks, updated.data.result.details.tasks);
  assert.equal(finalEntries.some(entry => entry.data.tasks.some((task: any) => task.title === staleTitle)), false);
  assert.deepEqual(nativeEntries(run, checkpointEntryType), checkpoints, "Plan mutation must not silently replace explicit working-state notes");
  assert.deepEqual(Object.keys(run.manifestIfPresent()?.runs ?? {}), []);
  run.assertions.durableReload = { shutdown, restart, beforePlan, afterPlan, beforeCheckpoint, afterCheckpoint, stale, current, finalPlan };
  await run.capture("durable-reload-revision-result");
});
