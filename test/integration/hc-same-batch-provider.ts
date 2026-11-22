// Test-only model input for the two HC sibling-settlement journeys. Pi still
// dispatches both real tools and owns the turn, session, and settlement.
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SameBatchIntent = "done" | "ping";
const provider = "hc-same-batch-fixture", modelId = "scripted";
export const sameBatchModel = `${provider}/${modelId}`;

export function sameBatchScenario(intent: SameBatchIntent, runId: string) {
  const gateName = `staged-${intent}`;
  const pingMessage = `HC_PING_AFTER_SIBLING_${runId}`;
  return {
    gateName,
    command: `node gate.mjs ${gateName}`,
    toolName: intent === "done" ? "subagent_done" : "caller_ping",
    args: intent === "done" ? { close: false } : { message: pingMessage },
    finalText: `FINAL_AFTER_${intent.toUpperCase()}_SIBLING`,
    pingMessage,
  };
}

export default function (pi: ExtensionAPI) {
  const intent = process.env.PI_TEST_HC_SAME_BATCH_INTENT, runId = process.env.PI_TEST_HC_SAME_BATCH_RUN;
  assert.ok(process.env.PI_TEST_HC_TUI === "1" && runId && (intent === "done" || intent === "ping"),
    "Scripted sibling input requires an isolated HC TUI journey");
  const { toolName, args, command, finalText } = sameBatchScenario(intent, runId);
  const calls = [
    { type: "toolCall", id: "staged-intent", name: toolName, arguments: args },
    { type: "toolCall", id: "gated-bash", name: "bash", arguments: { command, timeout: 300 } },
  ] as const;
  let requests = 0;
  pi.registerProvider(provider, {
    baseUrl: "https://example.invalid", apiKey: "fixture", api: "hc-same-batch-fixture-api",
    models: [{ id: modelId, name: "HC same-batch fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      assert.ok(process.env.PI_SUBAGENT_ID, "Scripted input is child-only");
      const request = requests++;
      assert.ok(request < 2, "Unexpected extra child model request");
      const results = context.messages.filter(message => message.role === "toolResult");
      assert.equal(results.length, request === 0 ? 0 : calls.length);
      if (request === 1) {
        for (const call of calls) {
          const result = results.find(result => result.toolCallId === call.id);
          assert.equal(result?.toolName, call.name);
          assert.equal(result.isError, false, `${call.name} must actually succeed before the final response`);
        }
      }
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        content: request === 0 ? calls.map(call => ({ ...call, arguments: { ...call.arguments } })) : [{ type: "text", text: finalText }],
        stopReason: request === 0 ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: request === 0 ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
