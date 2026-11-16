import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentDefinition, discoverAgentDefinitions, loadAgentDefaults, buildAvailableAgentCatalog, getAgentConfigDir } from "../pi-extension/subagents/discovery.ts";

test("discovery helper preserves CRLF parsing and catalog/lookup precedence at current cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-boundary-"));
  const cwd = process.cwd();
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const global = join(root, "global");
    const project = join(root, "project");
    mkdirSync(join(global, "agents"), { recursive: true });
    mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = global;
    process.chdir(project);
    const globalContent = "---\r\nname: boundary-alias\r\nmodel: test/global\r\nauto-exit: true\r\nsession-mode: lineage-only\r\n---\r\nGlobal body";
    const localContent = "---\r\nname: boundary-alias\r\nmodel: test/local\r\ncwd: relative-role\r\ncommand: 'run --flag'\r\n---\nLocal body";
    writeFileSync(join(global, "agents", "different-filename.md"), globalContent);
    writeFileSync(join(project, ".pi", "agents", "local.md"), localContent);
    writeFileSync(join(project, ".pi", "agents", "invalid.md"), "No frontmatter");
    mkdirSync(join(project, ".pi", "agents", "unreadable.md"));
    assert.equal(getAgentConfigDir(), global);
    assert.equal(parseAgentDefinition(globalContent, "fallback")?.sessionMode, "lineage-only");
    assert.equal(parseAgentDefinition("invalid", "fallback"), null);
    const options = { cwd: project, projectAgents: true };
    const found = discoverAgentDefinitions(options).filter((agent) => agent.name === "boundary-alias");
    assert.equal(found.length, 1);
    assert.equal(found[0].source, "project");
    assert.equal(found[0].body, "Local body");
    assert.equal(found[0].commandTemplate, "run --flag");
    assert.equal(found[0].cwd, "relative-role", "discovery does not reinterpret launch paths");
    assert.deepEqual(loadAgentDefaults("boundary-alias", options), found[0]);
    assert.equal(loadAgentDefaults("different-filename", options), null);
    assert.match(buildAvailableAgentCatalog(found, 24, { agents: {} }), /test\/local/);
    process.chdir(root);
    assert.equal(loadAgentDefaults("boundary-alias", { cwd: root, projectAgents: true })?.model, "test/global", "authorized cwd is explicit, never inferred from process.cwd");
  } finally {
    process.chdir(cwd);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("index keeps discovery aliases wired to the extracted helpers", async () => {
  const { __test__ } = await import("../pi-extension/subagents/index.ts");
  assert.equal(__test__.loadAgentDefaults, loadAgentDefaults);
  assert.equal(__test__.discoverAgentDefinitions, discoverAgentDefinitions);
  assert.equal(__test__.buildAvailableAgentCatalog, buildAvailableAgentCatalog);
});
