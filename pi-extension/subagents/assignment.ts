import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isPlanTaskBinding, samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import { isAssignmentContract, type AssignmentContract } from "./contracts.ts";
import { framedMessage } from "./frame.ts";
import { isLineage, type Lineage } from "./lineage.ts";
import { isQueueChildAllocation, type QueueChildAllocation } from "./queue-child-allocation.ts";
import { canonicalSessionPath } from "./ownership.ts";

export const ASSIGNMENT_ENTRY_TYPE = "subagent-assignment";
export const ASSIGNMENT_ENV = "PI_SUBAGENT_ASSIGNMENT_FILE";

export interface SubagentAssignment {
  planTask?: PlanTaskBinding;
  readonly queueAllocation?: QueueChildAllocation;
  assignmentContract?: AssignmentContract;
  version: 1;
  childId: string;
  sessionFile: string;
  sender: string;
  recipient: string;
  role: string;
  task: string;
  skills: string[];
  lineage?: Lineage;
}

export function isSubagentAssignment(value: unknown): value is SubagentAssignment {
  if (!value || typeof value !== "object") return false;
  const data = value as SubagentAssignment;
  return data.version === 1
    && (data.planTask === undefined || isPlanTaskBinding(data.planTask))
    && (data.lineage === undefined || isLineage(data.lineage))
    && (!Object.hasOwn(data, "queueAllocation") || (isQueueChildAllocation(data.queueAllocation) &&
      data.childId === data.queueAllocation.rootRunId && samePlanBinding(data.planTask, data.queueAllocation.binding) &&
      data.lineage?.child.sessionFile === data.sessionFile))
    && (data.assignmentContract === undefined || isAssignmentContract(data.assignmentContract))
    && [data.childId, data.sessionFile, data.sender, data.recipient, data.role, data.task]
      .every((field) => typeof field === "string")
    && Array.isArray(data.skills) && data.skills.every((skill) => typeof skill === "string");
}

const registeredRenderers = new WeakSet<ExtensionAPI>();

/** Also registered by the package entrypoint for ordinary `pi --session` resumes. */
export function registerSubagentAssignmentRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerEntryRenderer !== "function" || registeredRenderers.has(pi)) return;
  registeredRenderers.add(pi);
  pi.registerEntryRenderer<SubagentAssignment>(ASSIGNMENT_ENTRY_TYPE, (entry, _options, theme) => {
    if (!isSubagentAssignment(entry.data)) return new Text("", 0, 0);
    const data = entry.data;
    return framedMessage(`Message from ${data.sender}`, [
      `Sender: ${data.sender}`,
      `Recipient: ${data.recipient}`,
      `Role: ${data.role}`,
      ...(data.planTask ? [`Plan: ${data.planTask.planId} / Task: ${data.planTask.taskId} / Attempt: ${data.planTask.attemptId} / Run: ${data.childId}`] : []),
      ...(data.skills.length ? [`Skills: ${data.skills.join(", ")}`] : []),
      "",
      "Task:",
      data.task,
      ...(data.assignmentContract ? ["", "Assignment contract:", JSON.stringify(data.assignmentContract, null, 2)] : []),
    ].join("\n"), (text) => theme.bg("customMessageBg", text));
  });
}

/** Bootstrap only in the explicitly loaded child extension. */
export function registerSubagentAssignment(pi: ExtensionAPI): void {
  registerSubagentAssignmentRenderer(pi);
  // Older Pi versions cannot render custom entries. Keep ordinary task delivery intact.
  if (typeof pi.registerEntryRenderer !== "function" || typeof pi.appendEntry !== "function") return;

  // Capture once; never consult another child's inherited metadata after startup.
  const metadataFile = process.env[ASSIGNMENT_ENV];
  const childId = process.env.PI_SUBAGENT_ID;
  pi.on("session_start", (_event, ctx) => {
    if (!metadataFile || !childId) return;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(metadataFile, "utf8"));
    } catch {
      return; // Missing/stale metadata must not prevent the actual assignment running.
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!isSubagentAssignment(data) || data.childId !== childId || !sessionFile) return;
    if (data.queueAllocation ? (data.sessionFile !== canonicalSessionPath(sessionFile) ||
      data.lineage?.child.sessionId !== ctx.sessionManager.getSessionId()) : resolve(data.sessionFile) !== resolve(sessionFile)) return;
    const assignment = data;
    // Search all entries, including abandoned branches, so reload/tree/resume cannot
    // append a second launch card. Inherited parent cards have a different child ID.
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "custom"
      && entry.customType === ASSIGNMENT_ENTRY_TYPE
      && isSubagentAssignment(entry.data) && entry.data.childId === assignment.childId)) return;
    pi.appendEntry(ASSIGNMENT_ENTRY_TYPE, assignment);
  });
}
