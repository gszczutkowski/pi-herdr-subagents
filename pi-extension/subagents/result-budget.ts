import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];

export const DEFAULT_MAX_REPORT_BYTES = 12_000;

export interface ResultBudgetOptions {
  artifactDir: string;
  runId: string;
  /** Stable delivery/completion identity; use a different ID for each report. */
  eventId: string;
  maxReportBytes?: number;
  /** Used if archiving fails; otherwise read from message.details.sessionFile. */
  sessionFile?: string;
}

function utf8Head(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = Math.min(Math.max(0, bytes), buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  let start = Math.max(0, buffer.length - Math.max(0, bytes));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function preview(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  const gap = "\n[...]\n";
  if (bytes < Buffer.byteLength(gap) + 8) return utf8Head(text, bytes);
  const available = bytes - Buffer.byteLength(gap);
  const headBytes = Math.ceil(available * 0.75);
  // Keep both the identifying header and trailing diagnostics/references.
  return utf8Head(text, headBytes) + gap + utf8Tail(text, available - headBytes);
}

function archiveReport(message: Message, options: ResultBudgetOptions): string {
  const payload = JSON.stringify({ version: 1, runId: options.runId, eventId: options.eventId, message }, null, 2) + "\n";
  const digest = createHash("sha256").update(payload).digest("hex");
  const directory = resolve(options.artifactDir, "subagent-reports");
  // Content-addressing also protects against a reused event ID with a different payload.
  const target = join(directory, `${digest}.json`);
  mkdirSync(directory, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Publish a complete artifact without ever overwriting existing evidence.
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readFileSync(target, "utf8") !== payload) {
        throw Object.assign(new Error("Existing immutable report differs"), { code: "ECONFLICT" });
      }
    }
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Cleanup cannot suppress report delivery. */ }
  }
  return target;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code) ? code : "storage/serialization error";
}

/**
 * Bound model-facing content before taking the durable outbox snapshot.
 * Short messages are returned verbatim. Oversized arrays become a text preview;
 * their complete original blocks and details are archived, not sent to the model.
 * Details and all other envelope fields are left untouched (including proposals).
 *
 * maxReportBytes counts UTF-8 text bytes; input arrays are conservatively measured
 * as JSON, including images/block overhead. Invalid limits use the default. For
 * limits too small to fit a full reference, the notice points to session/details
 * rather than emitting a misleading partial artifact path.
 */
export function boundSubagentMessage(message: Message, options: ResultBudgetOptions): Message {
  const configured = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  const maxBytes = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_REPORT_BYTES;
  const contentBytes = Buffer.byteLength(typeof message.content === "string" ? message.content : JSON.stringify(message.content), "utf8");
  if (contentBytes <= maxBytes) return message;

  const details = message.details as { sessionFile?: unknown } | undefined;
  const sessionFile = options.sessionFile ?? (typeof details?.sessionFile === "string" ? details.sessionFile : undefined);
  let notices: string[];
  try {
    const archivePath = archiveReport(message, options);
    notices = [
      `[Report truncated (${contentBytes} bytes). Full content and details: ${archivePath}]`,
      `[Truncated. Full report: ${archivePath}]`,
      "[Report truncated; artifact path exceeds budget. See child session/details.]",
      "[Truncated; see session/details.]",
    ];
  } catch (error) {
    const failure = `archive failed (${errorCode(error)})`;
    notices = [
      `[Report truncated; ${failure}.${sessionFile ? ` Session: ${sessionFile}` : " See child session/details."}]`,
      `[Truncated; archive failed.${sessionFile ? ` Session: ${sessionFile}` : " See child session/details."}]`,
      "[Report truncated; archive failed. See child session/details.]",
      "[Archive failed; see session.]",
    ];
  }
  const notice = notices.find((candidate) => Buffer.byteLength(candidate, "utf8") <= maxBytes)
    ?? utf8Head("Truncated; see session/details.", maxBytes);
  const text = typeof message.content === "string" ? message.content : message.content.map((part) =>
    part.type === "text" ? part.text : "[Image omitted from preview; see full report/session]",
  ).join("\n");
  const remaining = maxBytes - Buffer.byteLength(notice, "utf8") - 2;
  const excerpt = remaining > 0 ? preview(text, remaining) : "";
  return { ...message, content: excerpt ? `${excerpt}\n\n${notice}` : notice };
}
