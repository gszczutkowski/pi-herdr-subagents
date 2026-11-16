// Test-only native authentication bridge. Credentials stay in the original
// profile; no credential values/files are copied into scratch or evidence.
import { join } from "node:path";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function sourceAuth(runtime: Pick<ModelRuntime, "hasConfiguredAuth" | "getAuth">, provider: string) {
  return {
    apiKey: {
      name: "Existing verification credentials",
      async login(): Promise<never> { throw new Error("Live verification never logs in or stores credentials"); },
      async check() {
        return runtime.hasConfiguredAuth(provider) ? { type: "api_key" as const, source: "original profile" } : undefined;
      },
      async resolve(input: { signal?: AbortSignal }) {
        return runtime.getAuth(provider, { signal: input.signal });
      },
    },
  };
}

export default async function (pi: ExtensionAPI) {
  const original = process.env.PI_TEST_HC_AUTH_DIR;
  if (!original || process.env.PI_TEST_HC_TUI !== "1") throw new Error("HC authentication bridge requires explicit live opt-in");
  const model = process.env.PI_TEST_MODEL || "openai-codex/gpt-6.1-sol";
  const providerId = model.slice(0, model.indexOf("/"));
  const runtime = await ModelRuntime.create({
    authPath: join(original, "auth.json"), modelsPath: join(original, "models.json"),
    allowModelNetwork: false, signal: AbortSignal.timeout(15_000),
  });
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`Live verification provider unavailable: ${providerId}`);
  // Keep the actual native catalog and transport. Only credential lookup is
  // delegated to the original store, including its normal OAuth refresh locking.
  pi.registerProvider({ ...provider, auth: sourceAuth(runtime, providerId) });
}
