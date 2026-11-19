import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentConfigDir } from "../../pi-extension/subagents/discovery.ts";
import { HcClient, bashPath, findHcExecutable } from "../../pi-extension/subagents/hc.ts";
import { runScriptInPane, shellQuote } from "../../pi-extension/subagents/terminal.ts";
import { isProtectedProcess, probeProcess, sameProcess } from "../../pi-extension/subagents/process-identity.ts";
import { canonicalSessionPath } from "../../pi-extension/subagents/ownership.ts";
import { localPiCli, localPiShellCommand } from "./local-pi.ts";

/** Validate ownership before adding anything to the transport teardown list. */
export function trackTransportSurface(owned: string[], surface: string, protectedTerminal = process.env.HC_TERMINAL_ID): void {
  assert.notEqual(surface, protectedTerminal, "Never target the user's terminal");
  assert.ok(!owned.includes(surface), "HC must allocate a distinct test terminal");
  owned.push(surface);
}

export function jsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // A concurrent append may be incomplete.
  });
}

/** Filesystem notifications, not model-driven status polling. Register before checking. */
export function until<T>(directory: string, check: () => T | undefined, label: string, timeout = 180_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch>;
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer); watcher?.close();
      if (error) reject(error); else resolve(value!);
    };
    const inspect = () => { try { const value = check(); if (value !== undefined) finish(undefined, value); } catch (error) { finish(error as Error); } };
    const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), timeout);
    watcher = watch(directory, { recursive: true }, inspect);
    watcher.on("error", error => finish(error));
    inspect();
  });
}

/** Metadata may be commented by both the driver and terminal writer. Never
 * accept an executable line or multiple ambiguous terminal declarations. */
export function childSurface(script: string): string {
  const matches = [...script.matchAll(/^#(?:[ \t]*#)*[ \t]*Surface: (t[a-z0-9]+)\r?$/gm)];
  assert.equal(matches.length, 1, "Exactly one commented child Surface required");
  return matches[0][1];
}

/** HC 0.1.21 lowercases printable named keys and does not translate shifted
 * punctuation. Fail rather than silently changing a command's task or token. */
export function literalHcKeys(text: string): string[] {
  assert.match(text, /^[a-z0-9/. -]*$/, "HC literal commands require lowercase letters, digits, spaces, slash, dot or hyphen; other named keys are not lossless");
  return Array.from(text, character => character === " " ? "space" : character);
}

export class HcTuiRun {
  readonly root = resolve(import.meta.dirname, "../..");
  readonly id = randomUUID();
  readonly scratch = mkdtempSync(join(tmpdir(), "pi-hc-tui-"));
  readonly evidence: string;
  readonly parentSession: string;
  readonly events: string;
  readonly profile: string;
  readonly hc: HcClient;
  readonly owned = new Set<string>();
  parent = "";
  launchCount = 0;
  assertions: Record<string, unknown> = {};

  readonly journey: string;
  constructor(journey: string) {
    this.journey = journey;
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    this.evidence = join(gitDir, "verification", `${new Date().toISOString().replace(/[:.]/g, "-")}-${journey}-${this.id}`);
    mkdirSync(this.evidence, { recursive: true });
    this.parentSession = join(this.evidence, "parent.jsonl");
    this.events = join(this.evidence, "events.jsonl");
    this.profile = join(this.scratch, "profile");
    mkdirSync(this.profile);
    writeFileSync(join(this.profile, "subagent-trust.json"), JSON.stringify({
      projectAgentDirectories: [join(this.scratch, ".pi", "agents")], agentDirectories: [],
    }));
    writeFileSync(this.events, "");
    const executable = findHcExecutable();
    if (!executable) throw new Error("HC executable unavailable");
    this.hc = new HcClient(executable);
    const entry = join(this.root, "pi-extension/subagents/index.ts");
    const cli = localPiCli;
    const cliVersion = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
    const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(item =>
      item.isDirectory() ? sourceFiles(join(directory, item.name)) : [join(directory, item.name)]);
    this.save("environment.json", {
      journey, id: this.id, scratch: this.scratch, node: process.version, argv: process.argv, execArgv: process.execArgv,
      pi: cliVersion, cli, nodeExecutable: process.execPath,
      hc: execFileSync(executable, ["server", "status"], { encoding: "utf8" }).trim(),
      branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      entry, sha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
      sourceHashes: Object.fromEntries([...sourceFiles(join(this.root, "pi-extension/subagents")),
        ...sourceFiles(join(this.root, "test/integration")), join(this.root, "package.json"), join(this.root, "package-lock.json")]
        .map(path => [path.slice(this.root.length + 1).replaceAll("\\", "/"), createHash("sha256").update(readFileSync(path)).digest("hex")])),
      workingTree: execFileSync("git", ["status", "--porcelain=v1"], { encoding: "utf8" }),
      sourceRoot: this.root,
      model: process.env.PI_TEST_MODEL || "openai-codex/gpt-6.1-sol",
      isolation: "Pinned local CLI; isolated scratch profile with exact project-role approval. Native test auth bridge resolves the original credential store without copying credentials or changing global settings. Observer never fabricates results.",
    });
    mkdirSync(join(this.scratch, ".pi", "agents"), { recursive: true });
    writeFileSync(join(this.scratch, ".pi", "agents", "verify-worker.md"), `---\nname: verify-worker\ndescription: Disposable live verification worker\nmodel: ${process.env.PI_TEST_MODEL || "openai-codex/gpt-6.1-sol"}\nthinking: minimal\ntools: read,bash,write\nauto-exit: true\n---\nExecute the exact assigned verification task. Never delegate. Use bash for marker side effects. Call subagent_done as requested. Do not commit or edit source.\n`);
    writeFileSync(join(this.scratch, ".pi", "agents", "verify-open.md"), readFileSync(join(this.scratch, ".pi", "agents", "verify-worker.md"), "utf8").replace("name: verify-worker", "name: verify-open").replace("auto-exit: true", "auto-exit: false"));
    // Gate work is intentionally event-driven and runs inside the child's actual bash tool.
    writeFileSync(join(this.scratch, "gate.mjs"), `import fs from 'node:fs';\nconst n=process.argv[2];fs.writeFileSync(n+'.started','STARTED');\nawait new Promise((resolve,reject)=>{let w;const t=setTimeout(()=>{w?.close();reject(Error('gate timeout'))},240000);const check=()=>{if(fs.existsSync(n+'.release')){clearTimeout(t);w?.close();resolve()}};w=fs.watch('.',check);check()});\nfs.writeFileSync(n+'.txt',n);\n`);
    const bin = join(this.scratch, "bin"); mkdirSync(bin);
    const originalProfile = getAgentConfigDir();
    writeFileSync(join(bin, "pi"), `#!/bin/bash\nexport PI_TEST_HC_TUI=1 PI_TEST_MODEL=${shellQuote(process.env.PI_TEST_MODEL || "openai-codex/gpt-6.1-sol")} PI_TEST_HC_AUTH_DIR=${shellQuote(originalProfile)} PI_CODING_AGENT_DIR=${shellQuote(this.profile)} PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TEST_HC_EVENTS=${shellQuote(this.events)} PI_TEST_HC_SCRATCH=${shellQuote(this.scratch)}\nexec ${localPiShellCommand()} -ne -e ${shellQuote(join(this.root, "test/integration/hc-auth.ts"))} -e ${shellQuote(join(this.root, "test/integration/hc-observer.ts"))} "$@"\n`, { mode: 0o755 });
    this.save("state.json", { scratch: this.scratch, evidence: this.evidence, owned: [] });
  }
  save(name: string, data: unknown) { writeFileSync(join(this.evidence, name), JSON.stringify(data, null, 2)); }
  action(target: string, text: string) {
    assert.ok(this.owned.has(target), "Only owned terminals may receive input");
    appendFileSync(join(this.evidence, "actions.jsonl"), JSON.stringify({ at: Date.now(), target, text }) + "\n");
    // hc send adds provenance tags around agent messages. Slash commands must be
    // literal keystrokes; otherwise Pi receives <hc>...</hc> as a model prompt.
    if (text.startsWith("/")) {
      this.keys(target, ...literalHcKeys(text), "enter");
    } else this.hc.send(target, text);
  }
  keys(target: string, ...keys: string[]) {
    assert.ok(this.owned.has(target), "Only owned terminals may receive keys");
    appendFileSync(join(this.evidence, "actions.jsonl"), JSON.stringify({ at: Date.now(), target, keys }) + "\n");
    execFileSync(this.hc.executable, ["keys", target, ...keys], { encoding: "utf8", timeout: 15_000 });
  }
  messages() { return jsonLines(this.parentSession).flatMap(e => e.type === "message" ? [e.message] : e.type === "custom_message" ? [e] : []); }
  observed() { return jsonLines(this.events); }
  results(name = "subagent") { return this.observed().filter(e => e.session === this.parentSession && e.kind === "tool_end" && e.data.toolName === name); }
  deliveries(id: string) { return this.messages().filter(m => m.customType === "subagent_result" && m.details?.eventId?.startsWith(`subagent:${id}:completion`)); }
  async launch() {
    this.parent = this.hc.create(`HC verify ${this.journey}`, this.scratch);
    assert.notEqual(this.parent, process.env.HC_TERMINAL_ID);
    this.owned.add(this.parent);
    this.launchCount++;
    this.save("state.json", { scratch: this.scratch, evidence: this.evidence, owned: [...this.owned] });
    const token = `VERIFY_READY_${this.id}_${this.launchCount}`;
    const command = `cd ${shellQuote(this.scratch)} && export PATH=${shellQuote(bashPath(join(this.scratch, "bin")))}:"$PATH" PI_TEST_HC_EVENTS=${shellQuote(this.events)} PI_TEST_HC_SCRATCH=${shellQuote(this.scratch)} && pi -e ${shellQuote(join(this.root, "pi-extension/subagents/index.ts"))} --no-mcp --no-skills --no-context-files --approve --session ${shellQuote(this.parentSession)} --model ${shellQuote(process.env.PI_TEST_MODEL || "openai-codex/gpt-6.1-sol")} --thinking off ${shellQuote(`Reply exactly ${token}. Do not use tools.`)}`;
    appendFileSync(join(this.evidence, "actions.jsonl"), JSON.stringify({ at: Date.now(), target: this.parent, command }) + "\n");
    runScriptInPane(this.parent, command, { scriptPath: join(this.evidence, `launch-${this.launchCount}.sh`) });
    await until(this.evidence, () => this.messages().find(m => m.role === "assistant" && m.content?.some((c: any) => c.type === "text" && c.text.trim() === token)), "authenticated readiness exact token");
    const start = this.observed().findLast(e => e.kind === "session_start" && e.terminal === this.parent);
    assert.equal(start?.mode, "tui");
    assert.equal(start.data.tools.filter((t: any) => t.name === "subagent").length, 1);
    this.assertions[`readiness-${this.launchCount}`] = { token, pid: start.pid, terminal: this.parent, at: Date.now() };
    await this.capture(`ready-${this.launchCount}`);
  }
  async idle(after = 0) {
    await until(this.evidence, () => this.observed().findLast(e => e.kind === "settled" && e.session === this.parentSession && e.at >= after), "parent settled");
  }
  async spawn(name: string, task: string, agent = "verify-worker") {
    const count = this.results().length;
    const at = Date.now();
    this.action(this.parent, `Call subagent exactly once with name ${name}, agent ${agent}, task ${JSON.stringify(task)}. End your turn immediately after the acknowledgement. Never poll. Acknowledge later completion briefly.`);
    const event = await until(this.evidence, () => this.results()[count], `${name} actual subagent result`);
    assert.ok(!event.data.isError, `${name}: tool error`);
    const details = event.data.result.details;
    assert.equal(details.status, "started");
    this.registerChild(details);
    await this.idle(at);
    return details;
  }
  registerChild(details: any) {
    assert.ok(details.id && details.sessionFile && details.launchScriptFile);
    const script = readFileSync(details.launchScriptFile, "utf8");
    const surface = childSurface(script);
    assert.notEqual(surface, process.env.HC_TERMINAL_ID);
    this.owned.add(surface);
    this.save("state.json", { scratch: this.scratch, evidence: this.evidence, owned: [...this.owned] });
    this.save(`child-${details.id}.json`, { ...details, surface });
    return surface;
  }
  async marker(name: string, content?: string) {
    const path = join(this.scratch, name);
    await until(this.scratch, () => existsSync(path) && (content === undefined || readFileSync(path, "utf8") === content) ? true : undefined, name);
    if (content !== undefined) assert.equal(readFileSync(path, "utf8"), content);
    copyFileSync(path, join(this.evidence, name));
  }
  assertChildBash(child: any, commandFragment: string) {
    const calls = this.observed().filter(e => e.session && canonicalSessionPath(e.session) === canonicalSessionPath(child.sessionFile) && e.kind === "tool_start" && e.data.toolName === "bash" && e.data.args?.command?.includes(commandFragment));
    assert.ok(calls.length > 0, `Actual child bash must reference ${commandFragment}`);
    this.assertions[`child-bash-${commandFragment}`] = calls.map(e => ({ at: e.at, pid: e.pid, terminal: e.terminal, toolCallId: e.data.toolCallId, command: e.data.args.command }));
  }
  release(name: string) {
    appendFileSync(join(this.evidence, "actions.jsonl"), JSON.stringify({ at: Date.now(), release: name }) + "\n");
    writeFileSync(join(this.scratch, `${name}.release`), "RELEASE");
  }
  async completion(child: any, count = 1) {
    await until(this.evidence, () => this.deliveries(child.id).length >= count ? true : undefined, `${child.name} delivery ${count}`);
    const messages = this.deliveries(child.id);
    assert.equal(messages.length, count, "No extra delivery at observation boundary");
    assert.ok(messages.every(m => m.details.exitCode === 0), "Successful completion required");
    copyFileSync(child.sessionFile, join(this.evidence, `child-${child.id}.jsonl`));
    const deliveredAt = messages.at(-1).timestamp;
    await this.idle(typeof deliveredAt === "number" ? deliveredAt : Date.parse(deliveredAt));
    const calls = jsonLines(child.sessionFile).filter(e => e.message?.role === "assistant").flatMap(e => e.message.content || []);
    assert.ok(calls.some(c => c.type === "toolCall" && c.name === "bash"), "Actual child bash tool required");
    return messages;
  }
  async resume(child: any, message: string, autoExit: boolean) {
    const count = this.results("subagent_resume").length;
    const childMetadata = JSON.parse(readFileSync(join(this.evidence, `child-${child.id}.json`), "utf8"));
    this.save(`pre-resume-${count}.json`, await this.hc.inspect(childMetadata.surface));
    const at = Date.now();
    this.action(this.parent, `Call subagent_resume exactly once with sessionPath ${JSON.stringify(child.sessionFile)}, name ${JSON.stringify(child.name)}, message ${JSON.stringify(message)}, autoExit ${autoExit}. End your turn and await steering; do not poll.`);
    const result = await until(this.evidence, () => this.results("subagent_resume")[count], "actual resume result");
    assert.ok(!result.data.isError, "Resume must succeed");
    const details = result.data.result.details;
    if (details.status === "pending") {
      const activity = this.manifest().runs[child.id].activityFile;
      const resultFile = join(`${activity}.continuation`, `${details.requestId}.result.json`);
      const accepted = await until(this.evidence, () => {
        if (!existsSync(resultFile)) return undefined;
        const acknowledgement = JSON.parse(readFileSync(resultFile, "utf8"));
        return ["accepted", "rejected"].includes(acknowledgement.status) ? acknowledgement : undefined;
      }, "child accepted live continuation (pending alone is not success)", 15_000);
      this.save(`continuation-${details.requestId}.json`, accepted);
      assert.equal(accepted.status, "accepted");
    }
    if (details.launchScriptFile) this.registerChild({ ...details, sessionFile: details.sessionPath });
    await this.idle(at);
    return result.data.result.details;
  }
  async capture(label: string) {
    for (const terminal of this.owned) {
      const inspection = await this.hc.inspect(terminal);
      this.save(`${label}-${terminal}.json`, inspection);
      if (inspection.kind === "present") {
        try { writeFileSync(join(this.evidence, `${label}-${terminal}.txt`), await this.hc.readAsync(terminal, 0)); }
        catch (error) { this.save(`${label}-${terminal}-capture-error.json`, { error: String(error) }); }
      }
    }
  }
  async finish(error?: unknown) {
    const outcome = { journey: this.journey, passed: false, assertions: this.assertions, error: error ? String(error) : undefined, at: Date.now(), parentToolOutcomes: this.observed().filter(e => e.session === this.parentSession && e.kind === "tool_end") };
    this.save("assertions.json", outcome);
    const cleanup: any[] = [];
    const unresolved: any[] = [];
    try { await this.capture("final"); } catch (error) { cleanup.push({ captureError: String(error) }); }
    // Recover child ownership even when an assertion failed immediately after launch.
    for (const event of this.results()) {
      try { if (event.data.result.details?.launchScriptFile) this.registerChild(event.data.result.details); } catch { /* Keep cleanup going. */ }
    }
    // Recover only surfaces recorded in this exact parent's prepared durable
    // runs, even if dispatch failed before a tool acknowledgement/start event.
    try {
      const manifest = this.manifestIfPresent();
      // A parent with no launches has no runtime store yet. Absence after a
      // successful launch, however, is lost custody, not an empty successful run.
      if (!manifest && (this.owned.size > (this.parent ? 1 : 0) || this.results().some(event => event.data.result.details?.status === "started"))) {
        throw new Error("Runtime manifest missing after child launch");
      }
      for (const run of Object.values(manifest?.runs ?? {}) as any[]) {
        if (!run.surface || this.owned.has(run.surface)) continue;
        try {
          assert.match(run.surface, /^t[a-z0-9]+$/);
          assert.notEqual(run.surface, process.env.HC_TERMINAL_ID);
          assert.ok(typeof run.launchScriptFile === "string" &&
            resolve(run.launchScriptFile).startsWith(resolve(this.artifactDirectory()) + sep), "Launch artifact outside this parent's custody");
          assert.equal(childSurface(readFileSync(run.launchScriptFile, "utf8")), run.surface);
          this.owned.add(run.surface);
        } catch (ownershipError) {
          // One damaged artifact must neither adopt an unverified surface nor
          // prevent later verifiable children from being cleaned up.
          unresolved.push({ runId: run.id, surface: run.surface, error: String(ownershipError) });
        }
      }
    } catch (ownershipError) { unresolved.push({ error: String(ownershipError) }); }
    for (const event of this.observed()) {
      // Observations are evidence, not permission to adopt an arbitrary terminal.
      if (event.session && event.session !== this.parentSession && this.owned.has(event.terminal) && existsSync(event.session)) {
        try {
          const identity = createHash("sha256").update(canonicalSessionPath(event.session)).digest("hex").slice(0, 16);
          copyFileSync(event.session, join(this.evidence, `session-${event.terminal}-${identity}.jsonl`));
        } catch (copyError) { cleanup.push({ sessionCopyError: String(copyError) }); }
      }
    }
    for (const terminal of [...this.owned].reverse()) {
      try { this.hc.close(terminal); cleanup.push({ terminal, inspection: await this.hc.inspect(terminal) }); }
      catch (error) { cleanup.push({ terminal, error: String(error) }); }
    }
    const allMissing = unresolved.length === 0 && cleanup.filter(x => x.terminal).every(x => x.inspection?.kind === "missing");
    this.save("cleanup.json", { at: Date.now(), allMissing, unresolved, terminals: cleanup });
    this.save("assertions.json", { ...outcome, passed: !error && allMissing, cleanupPassed: allMissing });
    // Retain scratch on failure: gate files and launch inputs are diagnostic evidence.
    // Windows may retain directory handles briefly after HC reports terminal removal.
    if (!error && allMissing) rmSync(this.scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.ok(allMissing, "All owned HC terminals must be removed, with no unresolved ownership");
  }
  parentPid() {
    return this.observed().findLast(e => e.kind === "session_start" && e.terminal === this.parent)?.pid as number;
  }
  async killParent() {
    const pid = this.parentPid(); assert.ok(pid);
    assert.ok(this.owned.has(this.parent)); assert.notEqual(this.parent, process.env.HC_TERMINAL_ID);
    const start = this.observed().findLast(e => e.kind === "session_start" && e.terminal === this.parent);
    const before = probeProcess(pid); assert.equal(before.kind, "present");
    assert.equal(start?.data.process?.kind, "present", "Saved startup PID/birth evidence required");
    assert.ok(before.kind === "present" && sameProcess(before.identity, start.data.process.identity), "Never signal a reused PID");
    assert.equal(isProtectedProcess(pid), false, "Never signal self, ancestor, or uncertain ancestry");
    process.kill(pid, "SIGKILL");
    // OS probe is bounded and does not ask a model to poll. Windows process exit can lag termination.
    const deadline = Date.now() + 10_000;
    let after = probeProcess(pid);
    while (after.kind !== "absent" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); after = probeProcess(pid);
    }
    this.save("parent-death.json", { pid, before, after, at: Date.now() });
    assert.equal(after.kind, "absent", "Old parent OS process must be dead before restart");
  }
  artifactDirectory() {
    const header = jsonLines(this.parentSession).find(e => e.type === "session");
    assert.ok(header?.id);
    return join(dirname(this.parentSession), "artifacts", header.id);
  }
  manifestIfPresent() {
    if (!existsSync(this.parentSession)) return undefined;
    const path = join(this.artifactDirectory(), "subagent-runtime", "manifest.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  }
  manifest() {
    const manifest = this.manifestIfPresent();
    assert.ok(manifest, "Durable manifest required");
    return manifest;
  }
}
