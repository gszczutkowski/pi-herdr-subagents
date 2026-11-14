import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type NotificationReason = "result" | "help" | "blocker" | "question" | "error" | "decision" | "progress" | "stalled" | "recovered" | "presentation";

/** Observed inactivity is not a request for help. Only explicit actionable events wake. */
export function notificationPolicy(reason: NotificationReason): "wake" | "panel" {
  switch (reason) {
    case "result": case "help": case "blocker": case "question": case "error": case "decision":
      return "wake";
    default:
      return "panel";
  }
}

/** Classify at the production outbox boundary, not by matching message prose. */
export function messageNotificationReason(message: Parameters<ExtensionAPI["sendMessage"]>[0]): NotificationReason {
  switch (message.customType) {
    case "subagent_ping": return "help";
    case "subagent_result": {
      const details = message.details as Record<string, unknown> | undefined;
      return details?.error || details?.errorMessage || (typeof details?.exitCode === "number" && details.exitCode !== 0) ? "error" : "result";
    }
    // Reserved event categories, not new child tools or a nonclosing protocol.
    case "subagent_blocker": return "blocker";
    case "subagent_question": return "question";
    case "subagent_decision": return "decision";
    default: return "progress";
  }
}

export function notificationOptions(reason: NotificationReason) {
  return notificationPolicy(reason) === "wake"
    ? { triggerTurn: true, deliverAs: "steer" as const }
    : undefined;
}
