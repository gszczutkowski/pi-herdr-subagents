import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
