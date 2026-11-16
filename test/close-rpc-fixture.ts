import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerRecoveryIdentity } from "../pi-extension/subagents/recovery-identity.ts";
import { registerCloseControl } from "../pi-extension/subagents/close-control.ts";

/** Real Pi lifecycle/ctx.shutdown, deterministic local provider; no network/model service. */
export default function (pi: ExtensionAPI) {
  registerRecoveryIdentity(pi);
  registerCloseControl(pi);
  pi.registerProvider("close-test", {
    baseUrl: "https://example.invalid", apiKey: "fixture", api: "close-test-api",
    models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const message: any = { role: "assistant", content: [{ type: "text", text: "Idle fixture" }],
        provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
}
