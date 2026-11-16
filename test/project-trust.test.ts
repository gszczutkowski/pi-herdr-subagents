import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultResourceLoader, SettingsManager, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { authorizedDiscovery, assertAgentDirectoryAuthorized, assertDefinitionAuthorized, sourceAuthorized } from "../pi-extension/subagents/project-trust.ts";
import { discoverAgentDefinitions, loadAgentDefaults } from "../pi-extension/subagents/discovery.ts";

function fixture(run: (f: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-project-trust-"));
  const base = join(dir, "user"), cwd = join(dir, "checkout"), target = join(dir, "target");
  const source = join(cwd, ".pi", "agents"), local = join(target, ".pi", "agent");
  for (const path of [join(base, "agents"), source, local]) mkdirSync(path, { recursive: true });
  writeFileSync(join(base, "agents", "alias.md"), "---\nname: trust-alias\n---\nGlobal role");
  writeFileSync(join(source, "alias.md"), "---\nname: trust-alias\ncli: sh\ncommand: dangerous {task}\n---\nProject role");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  const grant = (agents: string[] = [], dirs: string[] = []) => writeFileSync(join(base, "subagent-trust.json"),
    JSON.stringify({ projectAgentDirectories: agents, agentDirectories: dirs }));
  const ctx = { cwd, isProjectTrusted: () => true };
  try { run({ base, cwd, target, source, local, grant, ctx }); }
  finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
}

test("agents-only checkout needs explicit exact-source approval even if host returns trusted", () => fixture(({ ctx, base, source, grant }: any) => {
  assert.equal(loadAgentDefaults("trust-alias", authorizedDiscovery(ctx, base))?.body, "Global role");
  grant([source]);
  assert.equal(loadAgentDefaults("trust-alias", authorizedDiscovery(ctx, base))?.body, "Project role");
  const denied = { ...ctx, isProjectTrusted: () => false };
  assert.equal(loadAgentDefaults("trust-alias", authorizedDiscovery(denied, base))?.body, "Global role");
  assert.equal(authorizedDiscovery({ cwd: ctx.cwd }, base).projectAgents, false);
  grant([ctx.cwd]);
  assert.equal(authorizedDiscovery(ctx, base).projectAgents, false, "ancestor path is not an exact source approval");
}));

test("discovery takes authorized cwd, never implicitly process.cwd or project overrides", () => fixture(({ ctx, base, source, grant }: any) => {
  grant([source]);
  const agents = discoverAgentDefinitions(authorizedDiscovery(ctx, base));
  assert.equal(agents.find(agent => agent.name === "trust-alias")?.source, "project");
  assert.equal(discoverAgentDefinitions({ cwd: ctx.cwd }).find(agent => agent.name === "trust-alias")?.source, "global");
}));

test("target .pi/agent never promoted without explicit approval; saved denial wins and revocation is immediate", () => fixture(({ ctx, base, target, local, grant }: any) => {
  assertAgentDirectoryAuthorized(ctx, base, base, target);
  assert.throws(() => assertAgentDirectoryAuthorized(ctx, base, local, target), /not explicitly authorized/);
  grant([], [local]);
  assertAgentDirectoryAuthorized(ctx, base, local, target);
  new ProjectTrustStore(base).set(target, false);
  assert.throws(() => assertAgentDirectoryAuthorized(ctx, base, local, target), /not explicitly authorized/);
  new ProjectTrustStore(base).set(target, null);
  grant();
  assert.equal(sourceAuthorized(ctx, base, local, "agentDirectories", target), false);
}));

test("native trust bootstrap cannot load a checkout's unapproved user-level extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-trust-bootstrap-"));
  const base = join(dir, "user"), cwd = join(dir, "checkout"), local = join(cwd, ".pi", "agent");
  const marker = join(dir, "UNEXPECTED-EXTENSION-LOAD");
  mkdirSync(base); mkdirSync(join(local, "extensions"), { recursive: true });
  writeFileSync(join(local, "extensions", "payload.ts"), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport default function () {}`);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = base;
  try {
    const { __test__ } = await import("../pi-extension/subagents/index.ts");
    const ctx = { cwd, isProjectTrusted: () => false };
    const paths = __test__.resolveSubagentPaths({ name: "Trust", task: "noop", cwd }, null, ctx);
    assert.equal(paths.effectiveAgentDir, base);
    const loader = new DefaultResourceLoader({ cwd, agentDir: paths.effectiveAgentDir,
      settingsManager: SettingsManager.inMemory(), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload({ resolveProjectTrust: async () => false });
    assert.equal(loader.getExtensions().errors.length, 0);
    assert.equal(existsSync(marker), false, "unapproved checkout code must not execute even during bootstrap");
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("junction-backed roles retain the originating checkout's trust decision on resume from another cwd", () => fixture(({ ctx, base, cwd, source, target, grant }: any) => {
  const shared = join(target, "shared-roles"); mkdirSync(shared);
  writeFileSync(join(shared, "role.md"), "---\nname: shared-role\n---\nSHARED");
  rmSync(source, { recursive: true });
  symlinkSync(shared, source, process.platform === "win32" ? "junction" : "dir");
  grant([shared]);
  const definition = loadAgentDefaults("shared-role", authorizedDiscovery(ctx, base))!;
  assert.ok(definition);
  const other = { cwd: target, isProjectTrusted: () => true };
  assertDefinitionAuthorized(other, base, definition);
  new ProjectTrustStore(base).set(cwd, false);
  assert.throws(() => assertDefinitionAuthorized(other, base, definition), /no longer authorized/);
}));

test("invalid policy fails closed rather than falling back to project executable definitions", () => fixture(({ ctx, base }: any) => {
  writeFileSync(join(base, "subagent-trust.json"), '{"projectAgentDirectories":["relative"]}');
  assert.throws(() => authorizedDiscovery(ctx, base), /absolute/);
}));
