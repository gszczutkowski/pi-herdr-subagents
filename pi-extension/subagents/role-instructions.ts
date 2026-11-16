/** Explicit spawn instructions supplement, never replace, a named agent's role. */
export function resolveRoleInstructions(body?: string | null, systemPrompt?: string): string | null {
  return [body, systemPrompt].filter((text) => typeof text === "string" && text.trim()).join("\n\n") || null;
}
