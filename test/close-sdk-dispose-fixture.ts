import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import fixture from "./close-rpc-fixture.ts";
import { closeDir } from "../pi-extension/subagents/close-control.ts";

// Invoked only by the subprocess regression; no inherited subagent/terminal
// identity or settings/auth discovery is allowed into this SDK host.
const cwd = process.argv[2];
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [fixture] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), settingsManager, resourceLoader,
  sessionManager: SessionManager.open(process.env.PI_SUBAGENT_SESSION!) });
const model = session.extensionRunner!.getModelRegistry().find("close-test", "model");
assert.ok(model);
await session.setModel(model);
const errors: unknown[] = [];
await session.bindExtensions({ onError: error => errors.push(error) });
await session.prompt("Settle once without a network request");
assert.deepEqual(errors, []);
assert.ok(existsSync(join(closeDir(process.env.PI_SUBAGENT_ACTIVITY_FILE!), "current.json")), "CLOSE watcher really started");
session.dispose(); // No session_shutdown event; must exit naturally without process.exit().
process.stdout.write("SDK disposed after live CLOSE publication\n");
