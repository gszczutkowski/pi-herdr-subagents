import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalSessionPath } from "./ownership.ts";

const text = Type.String({ minLength: 1, maxLength: 4096 });
const identity = Type.Object({ sessionId: text, sessionFile: text }, { additionalProperties: false });
export const LineageSchema = Type.Object({
  version: Type.Literal(1), parent: identity, root: identity, child: identity,
  rootAssignmentId: text, rootCheckpoint: text, rootBranchToken: text, eventDirectory: text,
}, { additionalProperties: false });
export type Lineage = Static<typeof LineageSchema>;
export function isLineage(value: unknown): value is Lineage {
  return Value.Check(LineageSchema, value) && [value.parent, value.root, value.child].every(i => isAbsolute(i.sessionFile))
    && isAbsolute(value.eventDirectory);
}
export const LINEAGE_ASSIGNMENT = "subagent-lineage-assignment/v1";

/** Only this session's own assignment is inherited; forked parent cards are not identity. */
export function sessionLineage(manager: any): Lineage | undefined {
  const file = manager.getSessionFile();
  if (!file || typeof manager.getBranch !== "function") return undefined;
  return manager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === "subagent-assignment"
    && isLineage(e.data?.lineage) && e.data.lineage.child.sessionFile === canonicalSessionPath(file)
    && e.data.lineage.child.sessionId === manager.getSessionId())?.data.lineage;
}

export function createLineage(manager: any, childFile: string, childCwd: string, artifactDirectory: string,
  custody?: { checkpoint: string; branchToken: string }, append?: (type: string, data: unknown) => void): Lineage | undefined {
  if (!custody || typeof manager.getBranch !== "function") return undefined;
  // Pi needs a stable header ID even in standalone mode. No conversation is copied.
  let childId: string;
  try { childId = JSON.parse(readFileSync(childFile, "utf8").split("\n")[0]).id; }
  catch {
    childId = randomUUID();
    mkdirSync(dirname(childFile), { recursive: true });
    writeFileSync(childFile, JSON.stringify({ type: "session", version: 3, id: childId,
      timestamp: new Date().toISOString(), cwd: childCwd }) + "\n", { flag: "wx", mode: 0o600 });
  }
  const inherited = sessionLineage(manager);
  const parent = { sessionId: manager.getSessionId(), sessionFile: canonicalSessionPath(manager.getSessionFile()) };
  const lineage: Lineage = {
    version: 1, parent, root: inherited?.root ?? parent,
    child: { sessionId: childId, sessionFile: canonicalSessionPath(childFile) },
    rootAssignmentId: inherited?.rootAssignmentId ?? randomUUID(),
    rootCheckpoint: inherited?.rootCheckpoint ?? custody.checkpoint,
    rootBranchToken: inherited?.rootBranchToken ?? custody.branchToken,
    eventDirectory: inherited?.eventDirectory ?? join(artifactDirectory, "subagent-history"),
  };
  if (!inherited) append?.(LINEAGE_ASSIGNMENT, lineage);
  return lineage;
}
