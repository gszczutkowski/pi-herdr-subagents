import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DeliveryEnvelope } from "./delivery.ts";
import { samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import type { PlanSnapshot } from "./plan-store.ts";
import { dispatchFailureEventId as eventId, dispatchFailureSource as source, dispatchOperations, dispatchRunIdPattern, dispatchWriteOperations, hasAfterIntentMarker, isAfterIntentTombstone, isDispatchCode, isUnverifiedIntent,
  maxDispatchEvidenceBytes, maxDispatchEvidenceRecords, resumeIntentBinding, runtimeRenameAttempts, validateDispatchEvidence, verifyResumeImages,
  type DispatchEvidence, type DispatchOperation, type DispatchPhase, type DispatchWriteOperation, type DurableEvent, type DurableRun,
  type RuntimeManifest, type RuntimeStore } from "./runtime-store.ts";

export type { DispatchEvidence, DispatchOperation } from "./runtime-store.ts";
const firstAction = "Reconcile metadata only: use subagents_reconcile or type /subagents-reconcile in the original Pi session.";
export const noRetry = "Do not retry the resume or send a replacement for this run without run-bound evidence.";


export function operationCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : undefined;
}

/** Keep structured causes and known internal refusals, not arbitrary Error
 * text (a transport or child may put a command or credentials in it). */
function refusal(error: unknown, fallback: string): string {
  switch (error instanceof Error ? error.message : undefined) {
    case "Parent session/active branch lost custody": return "BRANCH_CUSTODY_LOST";
    case "Runtime writer lost custody": return "WRITER_CUSTODY_LOST";
    case "Stale runtime revision/generation": return "REVISION_GENERATION_CONFLICT";
    case "Run binding conflict": return "RUN_BINDING_CONFLICT";
    case "Immutable event conflict": return "IMMUTABLE_EVENT_CONFLICT";
    default: return operationCode(error) ?? fallback;
  }
}

function manifestOperation(error: unknown): DispatchWriteOperation {
  const syscall = (error as NodeJS.ErrnoException | undefined)?.syscall as DispatchWriteOperation;
  return dispatchWriteOperations.includes(syscall) ? syscall : "manifest";
}

export interface DispatchIncident {
  runId: string;
  status: "resolved" | "still-blocked" | "dispatch-unknown";
  code: string;
  phase?: DispatchPhase;
  reason?: string;
  recordedAt?: number;
  evidence?: "outbox" | "manifest" | "file" | "memory-only";
  attempts?: number;
  next: string;
}

interface ReadResult {
  records: Map<string, DispatchEvidence>;
  diagnostics: string[];
  conflicts: Set<string>;
  verifiedFiles: Set<string>;
  storeError?: string;
}
export type DispatchEvidenceReader = (manifest: RuntimeManifest) => ReadResult;

export function confirmedUnsent(store: Pick<RuntimeStore, "getEvent">, run: DurableRun): boolean {
  return (run.phase === "prepared" || isUnverifiedIntent(run)) && isUnsentEvent(store.getEvent(eventId(run.id)), run);
}
function isUnsentEvent(event: DurableEvent | undefined, run: DurableRun): boolean {
  const details = event?.envelope.message.details as { eventId?: unknown; error?: unknown } | undefined;
  if (event?.runId !== run.id || event.status !== "handedOff" || event.envelope.message.customType !== "subagent_result" ||
      details?.eventId !== eventId(run.id) || typeof details.error !== "string") return false;
  if (!hasAfterIntentMarker(event.envelope)) return run.phase === "prepared";
  return isAfterIntentTombstone(run, event);
}
const journalDir = (directory: string) => join(directory, "dispatch-evidence");
const journalPath = (directory: string, runId: string) => join(journalDir(directory), `${runId}.json`);
function readRecord(file: string, runId: string): DispatchEvidence {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxDispatchEvidenceBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > maxDispatchEvidenceBytes) throw evidenceReadError("EVIDENCE_TOO_LARGE");
    let record: DispatchEvidence;
    try { record = JSON.parse(buffer.toString("utf8", 0, size)); }
    catch { throw evidenceReadError("EVIDENCE_INVALID_JSON"); }
    try { validateDispatchEvidence(record, runId); }
    catch { throw evidenceReadError("EVIDENCE_INVALID_SCHEMA"); }
    return record;
  } finally { closeSync(fd); }
}

// Never surface parser/validator messages: they can quote journal contents.
const evidenceReadError = (code: string) => Object.assign(new Error(code), { code });

function files(directory: string): string[] {
  try { return readdirSync(journalDir(directory)).filter(name => dispatchRunIdPattern.test(name.replace(/\.json$/, "")) && name.endsWith(".json")); }
  catch (error) { if (operationCode(error) === "ENOENT") return []; throw error; }
}

/** Independent, immutable records. Publish with exclusive link, not replacement;
 * readers never see a partly written record. Same-user artifacts are not a sandbox. */
function save(directory: string, record: DispatchEvidence): void {
  validateDispatchEvidence(record, record.runId);
  const value = JSON.stringify(record);
  mkdirSync(journalDir(directory), { recursive: true, mode: 0o700 });
  const destination = journalPath(directory, record.runId);
  const retained = files(directory);
  if (retained.length >= maxDispatchEvidenceRecords && !retained.includes(`${record.runId}.json`)) throw new Error("Dispatch evidence limit reached");
  const temp = `${destination}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    created = true;
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { linkSync(temp, destination); }
    catch (error) {
      if (operationCode(error) !== "EEXIST") throw error;
      if (!isDeepStrictEqual(readRecord(destination, record.runId), record)) throw new Error("Conflicting immutable dispatch evidence");
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original error */ } }
    if (created) { try { rmSync(temp, { force: true }); } catch { /* never mask publication result */ } }
  }
}

function dispatchEnvelope(runId: string, reason: string, dispatched: boolean,
  incident: Pick<DispatchEvidence, "recordedAt" | "phase" | "cause" | "operation" | "writeOperation" | "writeCode">,
  beforeSendAfterIntent?: ReturnType<typeof resumeIntentBinding>): DeliveryEnvelope {
  const content = `${dispatched ? "Dispatch uncertain; reconcile existing process" : "Dispatch failed before send"}: ${reason}`;
  return { message: { customType: dispatched ? "subagent_ping" : "subagent_result", display: true,
    content, details: { eventId: eventId(runId), ...(dispatched ? { message: content } : { error: content }),
      dispatch: { source, ...incident }, ...(beforeSendAfterIntent ? { beforeSendAfterIntent } : {}) } },
    options: { triggerTurn: true, deliverAs: "steer" } };
}

export function captureDispatchEvidence(memory: Map<string, DispatchEvidence>, store: RuntimeStore,
  info: { runId: string; sessionFile: string; startedAt: number; binding?: PlanTaskBinding; dispatched: boolean; operation?: DispatchOperation },
  dispatchError: unknown, writeError: unknown): { record: DispatchEvidence; retained: "file" | "memory-only" | "none" } {
  const { parent, generation, revision } = store.snapshot();
  const record: DispatchEvidence = { schema: 1, runId: info.runId, eventId: eventId(info.runId), parent, generation, revision,
    ...(info.binding ? { binding: info.binding } : {}), sessionFile: info.sessionFile, startedAt: info.startedAt, recordedAt: Date.now(),
    phase: info.dispatched ? "send-possible" : "before-send",
    operation: info.operation ?? (info.dispatched ? "send-to-terminal" : "prepare-launch"), cause: refusal(dispatchError, "DISPATCH_FAILED"),
    writeOperation: manifestOperation(writeError), writeCode: refusal(writeError, "WRITE_REFUSED") };
  // In-memory custody belongs to the original parent; this map survives /reload.
  const kept = !memory.has(record.runId) && memory.size < maxDispatchEvidenceRecords;
  if (kept) memory.set(record.runId, record);
  try {
    // Don't write even the independent journal with a stale writer/branch.
    store.assertCustody();
    if (memory.has(record.runId) && !isDeepStrictEqual(memory.get(record.runId), record)) throw new Error("Conflicting in-memory dispatch evidence");
    save(store.directory, record);
    return { record, retained: "file" };
  } catch { return { record, retained: kept ? "memory-only" : "none" }; }
}

export function readDispatchEvidence(directory: string, manifest: Pick<RuntimeManifest, "parent" | "retainedDispatchEvidence">,
  memory: ReadonlyMap<string, DispatchEvidence>): ReadResult {
  const { parent, retainedDispatchEvidence } = manifest;
  const records = new Map<string, DispatchEvidence>(Object.entries(retainedDispatchEvidence ?? {}));
  const conflicts = new Set<string>();
  const verifiedFiles = new Set<string>();
  const diagnostics: string[] = [];
  let storeError: string | undefined;
  const merge = (id: string, record: DispatchEvidence) => {
    if (records.has(id) && !isDeepStrictEqual(records.get(id), record)) {
      conflicts.add(id);
      diagnostics.push(`${id}: Conflicting immutable dispatch evidence`);
    } else records.set(id, record);
  };
  for (const [id, record] of memory) if (isDeepStrictEqual(record.parent, parent)) merge(id, record);
  try {
    const paths = files(directory);
    if (paths.length > maxDispatchEvidenceRecords) throw evidenceReadError("EVIDENCE_LIMIT_EXCEEDED");
    for (const path of paths) {
      const id = path.slice(0, -5);
      try {
        const file = join(journalDir(directory), path);
        const disk = readRecord(file, id);
        if (isDeepStrictEqual(disk.parent, parent)) {
          merge(id, disk);
          if (isDeepStrictEqual(records.get(id), disk)) verifiedFiles.add(file);
        } else {
          conflicts.add(id);
          diagnostics.push(`${id}: Dispatch evidence belongs to another branch`);
        }
      } catch (error) {
        const code = operationCode(error) ?? "EVIDENCE_READ_REFUSED";
        conflicts.add(id);
        diagnostics.push(`${id}: ${code}`);
        // An unreadable/invalid record may be evidence from this generation.
        // Do not strand it merely because it could not enter records.
        storeError ??= code;
      }
    }
  } catch (error) {
    // Unreadable/unbounded directory: cannot rule out conflicts with memory.
    for (const id of records.keys()) conflicts.add(id);
    storeError = operationCode(error) ?? "EVIDENCE_READ_REFUSED";
    diagnostics.push(`Dispatch evidence directory: ${storeError}`);
  }
  return { records, conflicts, diagnostics, verifiedFiles, ...(storeError ? { storeError } : {}) };
}

function hasBinding(plan: PlanSnapshot | undefined, runId: string, binding: PlanTaskBinding): boolean {
  return !!plan && plan.planId === binding.planId && isDeepStrictEqual(plan.authority, binding.authority) &&
    !!plan.tasks.find(task => task.taskId === binding.taskId)?.attempts.find(attempt => attempt.attemptId === binding.attemptId)?.runIds.includes(runId);
}

export function dispatchReason(record: Pick<DispatchEvidence, "operation" | "cause" | "writeOperation" | "writeCode">): string {
  return `${record.operation} (${record.cause}); failure evidence ${record.writeOperation} (${record.writeCode})`;
}

function evidenceEnvelope(record: DispatchEvidence): DeliveryEnvelope {
  const { phase, cause, recordedAt, operation, writeOperation, writeCode } = record;
  return dispatchEnvelope(record.runId, dispatchReason(record), phase === "send-possible",
    { phase, cause, recordedAt, operation, writeOperation, writeCode }, operation === verifyResumeImages
      ? resumeIntentBinding({ id: record.runId, sessionFile: record.sessionFile, startTime: record.startedAt, planTask: record.binding }) : undefined);
}

function matchesEvidenceRun(run: DurableRun, record: DispatchEvidence): boolean {
  if (run.id !== record.runId || run.sessionFile !== record.sessionFile || run.startTime !== record.startedAt ||
      !samePlanBinding(run.planTask, record.binding)) return false;
  if (record.operation === verifyResumeImages) {
    return record.phase === "before-send" && isUnverifiedIntent(run) &&
      (!run.eventCursor.length || (run.eventCursor.length === 1 && run.eventCursor[0] === record.eventId));
  }
  return (run.phase === "prepared") === (record.phase === "before-send");
}

function matchesEvidenceOwner(run: DurableRun | undefined, record: DispatchEvidence): boolean {
  // A send requires a committed intent. Never manufacture a gone or unknown
  // intent from a lone side record or from a different run's process exit.
  return run ? matchesEvidenceRun(run, record) : record.phase === "before-send" && record.operation !== verifyResumeImages;
}

function matchesEvidenceEvent(event: DurableEvent, run: DurableRun | undefined, record: DispatchEvidence): boolean {
  return event.runId === record.runId && event.status === "handedOff" && !!run && run.eventCursor.includes(record.eventId) &&
    matchesEvidenceRun(run, record) && isDeepStrictEqual(event.envelope, evidenceEnvelope(record));
}

function incident(record: DispatchEvidence, directory: string, read: ReadResult,
  options: { code?: string; attempts?: number; retained?: boolean } = {}): DispatchIncident {
  // Report the verified location in this read pass, not a second disk read
  // whose failure would be omitted from the evidence view's storage status.
  const onDisk = read.verifiedFiles.has(journalPath(directory, record.runId));
  return { runId: record.runId, status: "still-blocked", phase: record.phase, recordedAt: record.recordedAt,
    code: options.code ?? record.writeCode, reason: dispatchReason(record), ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    evidence: options.retained ? "manifest" : onDisk ? "file" : "memory-only", next: record.phase === "send-possible" || options.code === "EVIDENCE_CONFLICT" ? `${noRetry} ${firstAction}` : firstAction };
}

/** One synchronous, bounded pass. Does not dispatch, notify or acquire custody. */
export function reconcileDispatchEvidence(store: RuntimeStore, read: ReadResult, plan: PlanSnapshot | undefined,
  memory: Map<string, DispatchEvidence>): { incidents: DispatchIncident[]; storeError?: string } {
  store.assertCustody();
  const current = store.snapshot();
  if (current.custodyPaused) throw new Error("Dispatch repair requires current branch custody");
  const incidents: DispatchIncident[] = [];
  let storeError = read.storeError;
  // No writes while journal contents/conflicts are uncertain.
  if (storeError) return { incidents, storeError };
  for (const record of read.records.values()) {
    let attempts = 0;
    let failure = "EVIDENCE_CONFLICT";
    const adopted = current.retainedDispatchEvidence?.[record.runId];
    let retained = !!adopted && isDeepStrictEqual(adopted, record);
    const originalWriter = current.generation === record.generation && current.revision >= record.revision;
    try {
      validateDispatchEvidence(record, record.runId);
      if (!isDeepStrictEqual(record.parent, current.parent)) throw new Error("Wrong parent");
      if (adopted && !retained) throw new Error("Conflicting retained evidence");
      const run = store.getRun(record.runId);
      if (!matchesEvidenceOwner(run, record) || store.hasMalformedAfterIntentCursor(record.runId)) {
        throw new Error("Durable run conflicts with dispatch evidence");
      }
      const committed = store.getEvent(record.eventId);
      if (read.conflicts.has(record.runId)) {
        // Keep the disputed journal intact. If we still have the independently
        // captured original under its writer, pin only that exact run-matched
        // record so a restart doesn't lose it. Neither copy can publish while
        // they disagree, and a disk-only mismatch never inherits custody.
        if (!committed && !retained && originalWriter && isDeepStrictEqual(memory.get(record.runId), record)) {
          attempts++;
          store.retainDispatchEvidence(record);
          retained = true;
        }
        incidents.push(incident(record, store.directory, read, { code: failure, attempts, retained }));
        continue;
      }
      if (committed && !matchesEvidenceEvent(committed, run, record)) throw new Error("Conflicting committed event");
      if (!committed && !originalWriter && !retained) {
        failure = "WRITER_GENERATION_CONFLICT";
        throw new Error("Old writer cannot publish this dispatch evidence");
      }
      if (!committed && record.binding && !hasBinding(plan, record.runId, record.binding)) {
        failure = "BINDING_MISMATCH";
        // Lack of plan selection is not a storage failure. Preserve this exact
        // verified record across rotation, without publishing to another plan.
        if (!retained) {
          attempts++;
          store.retainDispatchEvidence(record);
          retained = true;
        }
        incidents.push(incident(record, store.directory, read, { code: failure, attempts, retained }));
        continue;
      }
      if (!committed) {
        attempts++;
        store.assertCustody();
        store.recordDispatchFailure({ id: record.runId, planTask: record.binding, sessionFile: record.sessionFile,
          name: "Dispatch recovery", task: "Original assignment not duplicated in dispatch evidence", startTime: record.startedAt }, evidenceEnvelope(record), true, record);
      }
      // After successful publication, removal is optional housekeeping. A failed
      // removal leaves a verifiably idempotent duplicate on the next reconcile.
      if (isDeepStrictEqual(memory.get(record.runId), record)) memory.delete(record.runId);
      try { rmSync(journalPath(store.directory, record.runId), { force: true }); } catch { /* committed outbox is canonical */ }
    } catch (error) {
      const syscallCode = operationCode(error);
      if (attempts) storeError = syscallCode ?? "CUSTODY_OR_WRITE_REFUSED";
      // A readable logical disagreement remains local to its run. Only a
      // failed write or unreadable journal requires a global storage pause.
      incidents.push(incident(record, store.directory, read, { code: syscallCode ?? (attempts ? storeError : failure), attempts: runtimeRenameAttempts(error) ?? attempts, retained }));
      if (storeError) break; // one failed logical write is enough to check storage
    }
  }
  return { incidents, storeError };
}

function hasBoundCompletion(manifest: RuntimeManifest, run: RuntimeManifest["runs"][string]): boolean {
  if (run.phase === "prepared") return false;
  const prefix = `subagent:${run.id}:completion:`;
  return run.eventCursor.some(id => {
    if (!id.startsWith(prefix) || id.length <= prefix.length) return false; // no watcher-only exit/exception
    const event = manifest.outbox[id], message = event?.envelope.message;
    const details = message?.details as Record<string, unknown> | undefined;
    return event?.runId === run.id && !hasAfterIntentMarker(event.envelope) && details?.eventId === id && details.sessionFile === run.sessionFile &&
      // Dispatch proof is not task success: a child's run-bound provider error
      // proves execution too. Watcher-only exits have no completion cursor ID.
      ((message?.customType === "subagent_result" && Number.isSafeInteger(details.exitCode)) ||
       (message?.customType === "subagent_ping" && typeof details.message === "string" && details.message.length > 0));
  });
}

export function dispatchIncidents(manifest: RuntimeManifest | undefined, plan: PlanSnapshot | undefined,
  directory: string, read: ReadResult, overrides: DispatchIncident[] = []): DispatchIncident[] {
  const results = new Map(overrides.map(item => [item.runId, item]));
  for (const runId of read.conflicts) if (!results.has(runId)) results.set(runId,
    { runId, status: "still-blocked", code: "EVIDENCE_CONFLICT", next: `Review conflicting evidence. ${noRetry}` });
  for (const record of read.records.values()) if (!results.has(record.runId)) {
    const committed = manifest?.outbox[record.eventId];
    // A matching side file left by failed cleanup cannot mask the outbox, or
    // turn an ambiguous send into proof of execution. A mismatch still blocks.
    const run = manifest?.runs[record.runId];
    if (committed && matchesEvidenceEvent(committed, run, record)) continue;
    const retained = isDeepStrictEqual(manifest?.retainedDispatchEvidence?.[record.runId], record);
    const code = committed || !matchesEvidenceOwner(run, record) ? "EVIDENCE_CONFLICT"
      : !retained && manifest && (record.generation !== manifest.generation || record.revision > manifest.revision) ? "WRITER_GENERATION_CONFLICT"
      : retained && record.binding && !hasBinding(plan, record.runId, record.binding) ? "BINDING_MISMATCH" : undefined;
    results.set(record.runId, incident(record, directory, read, { retained, code }));
  }
  for (const task of plan?.tasks ?? []) for (const attempt of task.attempts) for (const runId of attempt.runIds) {
    const saved = manifest?.runs[runId];
    const binding = { planId: plan!.planId, taskId: task.taskId, attemptId: attempt.attemptId, authority: plan!.authority };
    if ((!saved || !samePlanBinding(saved.planTask, binding)) && !results.has(runId)) {
      results.set(runId, { runId, status: "dispatch-unknown", code: saved ? "BINDING_MISMATCH" : "NO_DURABLE_RUN", next: noRetry });
    }
  }
  for (const run of Object.values(manifest?.runs ?? {})) {
    // Quarantine the whole cursor even if there is a repair override or
    // competing proof. Only the exact sole canonical tombstone is admissible.
    if (run.eventCursor.some(id => {
      const event = manifest?.outbox[id];
      return event && hasAfterIntentMarker(event.envelope) && !isAfterIntentTombstone(run, event);
    })) {
      results.set(run.id, { runId: run.id, status: "still-blocked", code: "EVIDENCE_CONFLICT", next: noRetry });
      continue;
    }
    if (results.has(run.id)) continue;
    const candidate = manifest?.outbox[eventId(run.id)];
    const saved = candidate?.runId === run.id ? candidate : undefined;
    const unknown = saved?.envelope.message.customType === "subagent_ping";
    const unsent = isUnsentEvent(saved, run);
    const proof = run.dispatchVerified ? "RUN_BOUND_VERIFICATION"
      : (run.phase === "dispatch-intent" || unknown) && manifest && hasBoundCompletion(manifest, run) ? "RUN_BOUND_COMPLETION" : undefined;
    // Handoff is independent of execution. A pending/dispatching envelope
    // cannot hide a committed intent or turn an ambiguous send into proof.
    if (!unknown && !unsent && run.phase === "dispatch-intent" && !proof) {
      results.set(run.id, { runId: run.id, status: "dispatch-unknown", code: "DISPATCH_INTENT", phase: "send-possible", next: noRetry });
      continue;
    }
    if (!saved || (!unknown && !unsent)) continue;
    const detail = (saved.envelope.message.details as any)?.dispatch;
    const timestamp = detail?.source === source && Number.isSafeInteger(detail.recordedAt) && detail.recordedAt >= 0 && detail.recordedAt <= 8.64e15 ? detail.recordedAt : undefined;
    const reason = detail?.source === source && dispatchOperations.includes(detail.operation) && dispatchWriteOperations.includes(detail.writeOperation) && isDispatchCode(detail.cause) && isDispatchCode(detail.writeCode)
      ? dispatchReason(detail) : undefined;
    results.set(run.id, { runId: run.id, status: unknown && !proof ? "dispatch-unknown" : "resolved", code: (unknown && proof) || (isDispatchCode(detail?.cause) ? detail.cause : "RETAINED_EVENT"),
      phase: unknown ? "send-possible" : "before-send", ...(reason ? { reason } : {}), ...(timestamp !== undefined ? { recordedAt: timestamp } : {}), evidence: "outbox",
      next: unknown && proof ? "Same-run execution evidence found. Do not replay the original command; any new continuation requires an explicit decision and fresh writer checks."
        : unknown ? noRetry : "Run was not sent. A new launch requires a separate explicit decision." });
  }
  return [...results.values()].sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved"));
}

/** Only consume incidents from a verified, readable evidence view. A clean
 * outbox event alone does not settle a run with contradictory side evidence. */
export function verifiedUnsentRunIds(incidents: readonly DispatchIncident[]): ReadonlySet<string> {
  return new Set(incidents.filter(item => item.status === "resolved" && item.phase === "before-send" && item.evidence === "outbox")
    .map(item => item.runId));
}

/** A marked failure may change the plan only if this exact current outbox
 * event settles the original run, with no contradictory side evidence. */
export function canImportAfterIntentFailure(store: RuntimeStore, plan: PlanSnapshot | undefined,
  memory: ReadonlyMap<string, DispatchEvidence>, overrides: DispatchIncident[], runId: string,
  binding: PlanTaskBinding | undefined, envelope: DeliveryEnvelope, readEvidence?: DispatchEvidenceReader,
  onCustodyError?: (error: unknown) => void): boolean {
  try { store.assertCustody(); } catch (error) {
    onCustodyError?.(error);
    return false;
  }
  const manifest = store.snapshot();
  const run = manifest.runs[runId];
  const saved = manifest.outbox[eventId(runId)];
  if (manifest.custodyPaused || !run || !saved || !hasAfterIntentMarker(saved.envelope) ||
      !isUnsentEvent(saved, run) || !isDeepStrictEqual(saved.envelope, envelope) || !samePlanBinding(run.planTask, binding) ||
      (binding && !hasBinding(plan, runId, binding))) return false;
  const read = readEvidence ? readEvidence(manifest) : readDispatchEvidence(store.directory, manifest, memory);
  if (read.storeError) return false;
  return verifiedUnsentRunIds(dispatchIncidents(manifest, plan, store.directory, read, overrides)).has(runId);
}
