import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import { runCompletionFile, writeRunCompletion } from "../pi-extension/subagents/run-artifacts.ts";
import { canonicalSessionPath, releaseSession, reserveSession, sessionOwners } from "../pi-extension/subagents/ownership.ts";

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
