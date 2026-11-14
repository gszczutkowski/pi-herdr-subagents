import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPlanCommand } from "../pi-extension/subagents/plan-preflight.ts";

test("registered /plan preflight gates promises on current tools, roles, skills and readable instructions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-preflight-"));
  try {
    const skillPath = join(dir, "plan.md");
    writeFileSync(skillPath, "---\r\nname: plan\r\n---\r\n# Real instructions");
    let active = ["plan_read", "plan_update", "subagent", "read", "bash", "write", "edit"];
    let roles = ["scout", "planner", "worker", "reviewer"].map(name => ({ name, body: "Instructions", skills: "" }));
    let terminal = true;
    const notices: string[] = [], sent: string[] = [];
    let handler: any;
    registerPlanCommand({ getActiveTools: () => active, registerCommand: (name, command) => { assert.equal(name, "plan"); handler = command.handler; }, sendUserMessage: text => sent.push(text) } as any,
      { skillPath, discoverRoles: () => roles, terminalAvailable: () => terminal, terminalHint: () => "Install/configure herdr" });
    const skills: any[] = [];
    const ctx: any = { ui: { notify: (text: string) => notices.push(text) }, getSystemPromptOptions: () => ({ skills }) };
    const blocked = async (pattern: RegExp) => { const n = sent.length; await handler("Build", ctx); assert.equal(sent.length, n); assert.match(notices.at(-1)!, pattern); };
    await handler("", ctx); assert.match(notices.pop()!, /Usage/);
    active = active.filter(name => name !== "plan_update"); await blocked(/Missing active tools: plan_update/);
    active.push("plan_update");
    roles = roles.filter(role => role.name !== "planner"); await blocked(/Required role 'planner'/);
    roles.push({ name: "planner", body: "Instructions", skills: "required-helper" }); await blocked(/Required skill 'required-helper'.*not loaded/);
    skills.push({ name: "required-helper", filePath: join(dir, "missing") }); await blocked(/cannot be read/);
    skills[0].filePath = skillPath;
    terminal = false; await blocked(/Install\/configure herdr/); terminal = true;
    roles[3].skills = "";
    rmSync(skillPath); await blocked(/Cannot read bundled planning instructions.*Restore/);
    writeFileSync(skillPath, " "); await blocked(/instructions are empty/);
    writeFileSync(skillPath, "---\r\nname: plan\r\n---\r\n# Real instructions");
    await handler("Build", ctx);
    assert.equal(sent.length, 1); assert.match(sent[0], /# Real instructions/); assert.doesNotMatch(sent[0], /name: plan\r/);
    // Optional helpers are not required; this fixture has no commit/task-writing skill.
    roles[3].skills = ""; skills.length = 0; await handler("Build again", ctx); assert.equal(sent.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
