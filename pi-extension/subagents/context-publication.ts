import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Messages = ContextEvent["messages"];
export interface PublicationState { customType: string; identity: string; previousIdentity?: string }
interface Receipt { contentHash: string; states: PublicationState[]; callHash?: string }
interface Publication extends PublicationState { content: string }

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function publicationState(customType: string, content: string): PublicationState {
  return { customType, identity: digest(content) };
}
/** Details remain UI/session data; only the concise content reaches the model. */
export function contextReceipt(content: unknown, states: PublicationState[], callArguments?: unknown) {
  return { contextReceipt: { contentHash: digest(content), states,
    ...(callArguments === undefined ? {} : { callHash: digest(callArguments) }) } satisfies Receipt };
}
function latestIdentity(messages: Messages, customType: string): string | undefined {
  let identity: string | undefined;
  const calls = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "assistant") {
      // Keep references only. Ordinary tools and receipts for other publication
      // channels do not need their (potentially large) arguments serialized.
      for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block.arguments);
    }
    if (message.role === "custom" && message.customType === customType) {
      const marker = (message.details as { publication?: Receipt } | undefined)?.publication;
      const state = marker && Array.isArray(marker.states)
        ? marker.states.find(state => state?.customType === customType && typeof state.identity === "string") : undefined;
      if (marker && state && marker.contentHash === digest(message.content)) identity = state.identity;
    }
    if (message.role === "toolResult" && !message.isError) {
      const marker = (message.details as { contextReceipt?: Receipt } | undefined)?.contextReceipt;
      // Edits may retain details but remove/replace the visible receipt or the
      // assistant call carrying the replacement notes/definition. Neither counts.
      const state = marker && Array.isArray(marker.states)
        ? marker.states.find(state => state?.customType === customType && typeof state.identity === "string") : undefined;
      if (marker && state && (!state.previousIdentity || state.previousIdentity === identity) &&
          marker.contentHash === digest(message.content) && (!marker.callHash ||
            (calls.has(message.toolCallId) && digest(calls.get(message.toolCallId)) === marker.callHash))) {
        identity = state.identity;
      }
    }
  }
  return identity;
}
function message(publication: Publication, transient = false) {
  return { customType: publication.customType, content: publication.content, display: false,
    details: { publication: { contentHash: digest(publication.content), states: [publicationState(publication.customType, publication.content)] },
      ...(transient ? { transient: true } : {}) } };
}
function pending(messages: Messages, customType: string, content: string | undefined, absent: string): Publication | undefined {
  const latest = latestIdentity(messages, customType);
  if (content === undefined && latest === undefined) return;
  const next = content ?? absent;
  if (latest === digest(next)) return;
  return { ...publicationState(customType, next), content: next };
}

/**
 * Publish at native append-only boundaries, never request-time during ordinary
 * flow. Presence is checked in the active *projected* context, not a process
 * cache or raw branch entries (both survive compaction/context_edit omissions).
 *
 * Pi 1.3/1.5 have no actionable post-compaction/pre-request boundary. Until the
 * next native boundary, a narrowly scoped read-only fallback preserves exact
 * state after compaction. This fallback can reset provider continuation; it is
 * deliberately NOT presented as a full auto-compaction/delta solution.
 */
export function registerContextPublication(pi: ExtensionAPI, options: {
  customType: string;
  read: (ctx: ExtensionContext) => string | undefined;
  absent: string;
}): void {
  const prepare = (messages: Messages, ctx: ExtensionContext) => pending(messages, options.customType, options.read(ctx), options.absent);
  pi.on("before_agent_start", (_event, ctx) => {
    const next = prepare(ctx.sessionManager.buildSessionProjection().messages, ctx);
    if (next) return { message: message(next) };
  });
  pi.on("turn_end", (event, ctx) => {
    const next = prepare(event.context.contextMessages, ctx);
    if (next) return { entries: [...event.entries, { type: "custom_message", ...message(next) }] };
  });
  pi.on("context", (event, ctx) => {
    // Only remove our own temporary fallback, never durable publications, tool
    // results, other extensions' messages, or historical provider dependencies.
    const retained = event.messages.filter(item => !(item.role === "custom" && item.customType === options.customType &&
      (item.details as { transient?: boolean; publication?: unknown } | undefined)?.transient === true &&
      (item.details as { publication?: unknown }).publication));
    if (!retained.some(item => item.role === "compactionSummary")) return;
    const next = prepare(retained, ctx);
    if (!next) return retained.length === event.messages.length ? undefined : { messages: retained };
    return { messages: [...retained, { role: "custom", ...message(next, true), timestamp: 0 }] };
  });
}
