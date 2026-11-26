import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isPlanTaskBinding, samePlanBinding, type PlanTaskBinding } from "./plan-runtime.ts";
import { isAssignmentContract, type AssignmentContract } from "./contracts.ts";
import type { DeliveryEnvelope } from "./delivery.ts";
import { probeProcess, sameProcess } from "./process-identity.ts";
import { isLineage, type Lineage } from "./lineage.ts";

export interface RuntimeParent {
  sessionFile: string;
  headerId: string;
  branchToken: string;
  checkpoint: string;
}
export const maxDispatchEvidenceRecords = 32;
export const maxDispatchEvidenceBytes = 64 * 1024;
export const dispatchRunIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dispatchFailureEventId = (id: string) => `subagent:${id}:dispatch-failure:launch`;
export const verifyResumeImages = "verify-resume-images";
export const dispatchFailureSource = "dispatch-failure-v1";
export const dispatchOperations = ["prepare-launch", "persist-prepared", "prepare-transport", "validate-dispatch", "persist-intent", verifyResumeImages, "send-to-terminal", "persist-supervised", "register-supervision"] as const;
export const dispatchWriteOperations = ["rename", "stat", "open", "write", "fsync", "close", "manifest"] as const;
export type DispatchOperation = (typeof dispatchOperations)[number];
export type DispatchWriteOperation = (typeof dispatchWriteOperations)[number];
export type DispatchPhase = "before-send" | "send-possible";
export interface DispatchEvidence {
  schema: 1;
  runId: string;
  eventId: string;
  parent: RuntimeParent;
  generation: string;
  revision: number;
  binding?: PlanTaskBinding;
  sessionFile: string;
  startedAt: number;
  recordedAt: number;
  phase: DispatchPhase;
  operation: DispatchOperation;
  cause: string;
  writeOperation: DispatchWriteOperation;
  writeCode: string;
}

const bounded = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
export const isDispatchCode = (value: unknown): value is string => bounded(value, 32) && /^[A-Z][A-Z0-9_]*$/.test(value);

/** Common schema for the immutable side journal and exact manifest records. */
export function validateDispatchEvidence(record: DispatchEvidence, runId: string): void {
  if (!record || record.schema !== 1 || record.runId !== runId || !dispatchRunIdPattern.test(runId) || record.eventId !== dispatchFailureEventId(runId) ||
      !record.parent || !["sessionFile", "headerId", "branchToken", "checkpoint"].every(key => bounded(record.parent[key as keyof RuntimeParent])) ||
      Object.keys(record.parent).length !== 4 || !bounded(record.generation, 100) ||
      ![record.revision, record.startedAt, record.recordedAt].every(value => Number.isSafeInteger(value) && value >= 0) || record.recordedAt > 8.64e15 ||
      (record.binding !== undefined && !isPlanTaskBinding(record.binding)) ||
      !bounded(record.sessionFile) || !["before-send", "send-possible"].includes(record.phase) ||
      !dispatchOperations.includes(record.operation) || (record.operation === verifyResumeImages && record.phase !== "before-send") ||
      !dispatchWriteOperations.includes(record.writeOperation) ||
      !isDispatchCode(record.cause) || !isDispatchCode(record.writeCode) ||
      Object.keys(record).some(key => !["schema", "runId", "eventId", "parent", "generation", "revision", "binding", "sessionFile", "startedAt", "recordedAt", "phase", "operation", "cause", "writeOperation", "writeCode"].includes(key)) ||
      Buffer.byteLength(JSON.stringify(record)) > maxDispatchEvidenceBytes) {
    throw new Error("Invalid dispatch evidence; explicit decision required");
  }
}

export interface DurableRun {
  planTask?: PlanTaskBinding;
  id: string;
  sessionFile: string;
  name: string;
  task: string;
  cli?: string;
  surface?: string;
  activityFile?: string;
  sentinelFile?: string;
  launchScriptFile?: string;
  profile?: unknown;
  lineage?: Lineage;
  entryCountBefore?: number;
  continuationRequestId?: string;
  startTime: number;
  phase: "prepared" | "dispatch-intent" | "supervised";
  eventCursor: string[];
  /** Historical proof that this run answered a fresh recovery challenge. */
  dispatchVerified?: true;
  reconciliation?: string;
}
export interface DurableEvent {
  runId: string;
  envelope: DeliveryEnvelope;
  status: "pending" | "dispatching" | "handedOff";
}
/** An immutable outbox claim, scoped to the original intent rather than to a
 * session path or a result that merely says it failed before sending. */
export function resumeIntentBinding(run: Pick<DurableRun, "id" | "sessionFile" | "startTime" | "planTask">) {
  return { runId: run.id, sessionFile: run.sessionFile, startedAt: run.startTime, ...(run.planTask ? { binding: run.planTask } : {}) };
}

export function isUnverifiedIntent(run: DurableRun): boolean {
  return run.phase === "dispatch-intent" && !run.dispatchVerified && run.continuationRequestId === undefined;
}

/** Presence, not validity: malformed claims are also import-only and may not
 * enter the ordinary notification lifecycle. */
export function hasAfterIntentMarker(envelope: DeliveryEnvelope): boolean {
  return (envelope.message.details as { beforeSendAfterIntent?: unknown } | undefined)?.beforeSendAfterIntent !== undefined;
}

/** Canonical writer and reader must agree: an empty error would project as an
 * ordinary result. A marker cannot override evidence of a different boundary. */
export function isAfterIntentFailure(run: DurableRun, envelope: DeliveryEnvelope): boolean {
  const details = envelope.message.details as Record<string, unknown> | undefined;
  if (!isUnverifiedIntent(run) || envelope.message.customType !== "subagent_result" ||
      details?.eventId !== dispatchFailureEventId(run.id) || typeof details.error !== "string" || details.error.length === 0 ||
      !isDeepStrictEqual(details.beforeSendAfterIntent, resumeIntentBinding(run))) return false;
  if (details.dispatch === undefined) return true;
  const dispatch = details.dispatch as Partial<DispatchEvidence> & { source?: unknown };
  return !!dispatch && typeof dispatch === "object" && !Array.isArray(dispatch) &&
    dispatch.source === dispatchFailureSource && dispatch.phase === "before-send" && dispatch.operation === verifyResumeImages &&
    typeof dispatch.recordedAt === "number" && Number.isSafeInteger(dispatch.recordedAt) && dispatch.recordedAt >= 0 && dispatch.recordedAt <= 8.64e15 &&
    isDispatchCode(dispatch.cause) && isDispatchCode(dispatch.writeCode) &&
    dispatch.writeOperation !== undefined && dispatchWriteOperations.includes(dispatch.writeOperation) &&
    Object.keys(dispatch).length === 7;
}

/** A marker is admissible only as the sole canonical, handed-off event. */
export function isAfterIntentTombstone(run: DurableRun, event: DurableEvent): boolean {
  return event.runId === run.id && event.status === "handedOff" && run.eventCursor.length === 1 &&
    run.eventCursor[0] === dispatchFailureEventId(run.id) && isAfterIntentFailure(run, event.envelope);
}

export interface RuntimeManifest {
  schema: 1;
  revision: number;
  generation: string;
  custodyPaused?: string;
  parent: RuntimeParent;
  runs: Record<string, DurableRun>;
  outbox: Record<string, DurableEvent>;
  retainedDispatchEvidence?: Record<string, DispatchEvidence>;
}

const renameAttempts = new WeakMap<object, number>();
export function runtimeRenameAttempts(error: unknown): number | undefined {
  return error && typeof error === "object" ? renameAttempts.get(error) : undefined;
}

/** Same-directory atomic replacement. Synchronous operations serialize local writers.
 * Permissions are advisory on Windows; this is same-user storage, not a sandbox. */
export function atomicRuntimeWrite(file: string, value: unknown, beforeRetry?: () => void): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  let attempts = 0;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const delays = [10, 30, 60];
    for (let attempt = 0; ; attempt++) {
      try {
        attempts++;
        renameSync(temporary, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Only manifest commits supply a custody guard. Never recreate the
        // snapshot/temp or replay a transaction (or its transport side effects).
        if (!beforeRetry || process.platform !== "win32" ||
            (code !== "EPERM" && code !== "EBUSY") || attempt === delays.length) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
        beforeRetry();
      }
    }
  } catch (error) {
    // Cleanup must not replace the publication/custody error. After a successful
    // rename there is no temporary file left and no fallible post-commit work.
    if (fd !== undefined) { try { closeSync(fd); } catch { /* retain original error */ } }
    if (created) { try { rmSync(temporary, { force: true }); } catch { /* retain original error */ } }
    if (attempts && beforeRetry && error && typeof error === "object") renameAttempts.set(error, attempts);
    throw error;
  }
}

function validate(value: any): asserts value is RuntimeManifest {
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.generation !== "string" || !value.parent ||
      !["sessionFile", "headerId", "branchToken", "checkpoint"].every((key) => typeof value.parent[key] === "string" && value.parent[key]) ||
      !value.runs || Array.isArray(value.runs) || !value.outbox || Array.isArray(value.outbox)) {
    throw new Error("Invalid or unsupported runtime manifest; explicit reconciliation required");
  }
  const retained = value.retainedDispatchEvidence;
  if (retained !== undefined) {
    if (!retained || typeof retained !== "object" || Array.isArray(retained) || Object.keys(retained).length > maxDispatchEvidenceRecords) {
      throw new Error("Invalid retained dispatch evidence");
    }
    for (const [id, record] of Object.entries(retained) as [string, DispatchEvidence][]) {
      validateDispatchEvidence(record, id);
      if (!isDeepStrictEqual(record.parent, value.parent) || record.revision > value.revision || value.outbox[record.eventId]) {
        throw new Error("Conflicting retained dispatch evidence");
      }
    }
  }
  for (const [id, run] of Object.entries(value.runs) as [string, any][]) {
    if ((run.planTask !== undefined && !isPlanTaskBinding(run.planTask)) ||
        (run.lineage !== undefined && !isLineage(run.lineage)) ||
        (run.profile?.assignmentContract !== undefined && !isAssignmentContract(run.profile.assignmentContract)) || run.id !== id || typeof run.sessionFile !== "string" || typeof run.name !== "string" || typeof run.task !== "string" ||
        !Number.isFinite(run.startTime) || !["prepared", "dispatch-intent", "supervised"].includes(run.phase) ||
        (run.dispatchVerified !== undefined && (run.dispatchVerified !== true || run.phase === "prepared")) ||
        !Array.isArray(run.eventCursor) || !run.eventCursor.every((event: unknown) => typeof event === "string")) {
      throw new Error("Invalid durable run");
    }
  }
  const cursors = new Map<string, Set<string>>();
  for (const [id, run] of Object.entries(value.runs) as [string, any][]) {
    const cursor = new Set<string>(run.eventCursor);
    cursors.set(id, cursor);
    if (cursor.size !== run.eventCursor.length ||
        run.eventCursor.some((eventId: string) => value.outbox[eventId]?.runId !== id)) {
      throw new Error("Stale or invalid event cursor");
    }
  }
  for (const [id, event] of Object.entries(value.outbox) as [string, any][]) {
    if (!cursors.get(event.runId)?.has(id) || !["pending", "dispatching", "handedOff"].includes(event.status) ||
        event.envelope?.message?.details?.eventId !== id || typeof event.envelope.message.customType !== "string" ||
        !event.envelope.options || event.envelope.options.triggerTurn !== true || event.envelope.options.deliverAs !== "steer") {
      throw new Error("Invalid durable event");
    }
  }
}

export function readRuntimeManifest(directory: string): RuntimeManifest | undefined {
  const file = join(directory, "manifest.json");
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8"));
  validate(value);
  return value;
}

/** ctime detects same-size edits even if mtime was restored; inode/dev detect
 * atomic replacement. Metadata is a local I/O optimization, not an adversarial
 * filesystem integrity boundary. Changed files are always parsed/validated. */
function fileStamp(file: string): string {
  const stat = statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export interface EventMembership { readonly size: number; has(eventId: string): boolean }

export class RuntimeStore {
  readonly generation = randomUUID();
  private manifest: RuntimeManifest;
  private readonly outboxOrder: string[];
  private readonly markedRuns = new Set<string>();
  private readonly lease: string;
  private closed = false;
  private initialized = false;
  private ownerStamp?: string;
  private manifestStamp?: string;
  private readonly cursors = new Map<string, { ids: Set<string>; view: EventMembership }>();
  isCurrent?: () => boolean;

  readonly directory: string;

  constructor(directory: string, parent: RuntimeParent, beforeGenerationChange?: (store: RuntimeStore) => void) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lease = join(directory, "writer");
    try { mkdirSync(this.lease, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize reapers too. A crash holding this guard requires a human;
      // timestamps are never evidence of death or permission to steal custody.
      const recovery = join(directory, "reconciling-writer");
      mkdirSync(recovery, { mode: 0o700 });
      try {
        const owner = JSON.parse(readFileSync(join(this.lease, "owner.json"), "utf8"));
        if (!owner.identity?.birth) throw new Error("Unverified legacy writer; explicit reconciliation required");
        const probe = probeProcess(owner.identity.pid);
        if (probe.kind === "unverified" || (probe.kind === "present" && sameProcess(probe.identity, owner.identity))) {
          throw new Error("Runtime writer is live or unverified; cannot acquire custody");
        }
        rmSync(this.lease, { recursive: true });
        mkdirSync(this.lease, { mode: 0o700 });
      } finally { rmSync(recovery, { recursive: true, force: true }); }
    }
    try {
      const self = probeProcess(process.pid);
      atomicRuntimeWrite(join(this.lease, "owner.json"), { generation: this.generation,
        identity: self.kind === "present" ? self.identity : null });
      const previous = readRuntimeManifest(directory);
      if (previous && JSON.stringify(previous.parent) !== JSON.stringify(parent)) throw new Error("Runtime parent/branch custody mismatch");
      this.manifest = previous ?? { schema: 1, revision: 0, generation: this.generation, parent, runs: {}, outbox: {} };
      this.outboxOrder = Object.keys(this.manifest.outbox);
      for (const event of Object.values(this.manifest.outbox)) {
        if (hasAfterIntentMarker(event.envelope)) this.markedRuns.add(event.runId);
      }
      this.initialized = !!previous;
      // The new lease is ours, while the verified manifest still has its old
      // generation. Publish or retain exact restart evidence before advancing;
      // the rotation atomically carries retained records into the new manifest.
      if (previous && beforeGenerationChange) {
        this.assertCustody();
        beforeGenerationChange(this);
      }
      this.commit({ ...this.manifest, generation: this.generation });
    } catch (error) {
      try {
        const owner = JSON.parse(readFileSync(join(this.lease, "owner.json"), "utf8"));
        if (owner.generation === this.generation) rmSync(this.lease, { recursive: true, force: true });
      } catch {
        // If publication of the owner failed, the lease directory was created
        // by this constructor. Only remove an empty lease; never erase a replacement.
        try { rmdirSync(this.lease); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  snapshot(): RuntimeManifest { return structuredClone(this.manifest); }

  /** Small defensive selectors; full snapshots belong at restoration boundaries. */
  dispatchCustody(): Pick<RuntimeManifest, "parent" | "custodyPaused"> {
    this.assertCustody();
    return { parent: { ...this.manifest.parent }, custodyPaused: this.manifest.custodyPaused };
  }
  getRun(id: string): DurableRun | undefined { return structuredClone(this.manifest.runs[id]); }
  listRuns(): DurableRun[] { return structuredClone(Object.values(this.manifest.runs)); }
  runBinding(id: string): PlanTaskBinding | undefined { return structuredClone(this.manifest.runs[id]?.planTask); }
  getEvent(id: string): DurableEvent | undefined { return structuredClone(this.manifest.outbox[id]); }
  /** Marker membership is append-only. Test current run/cursor validity without
   * scanning history on each delivery or plan projection. */
  hasMalformedAfterIntentCursor(runId: string): boolean {
    if (!this.markedRuns.has(runId)) return false;
    const run = this.manifest.runs[runId];
    const failure = this.manifest.outbox[dispatchFailureEventId(runId)];
    return !failure || !isAfterIntentTombstone(run, failure);
  }
  outboxIds(): readonly string[] { return this.outboxIdsSince(); }
  /** Offset is local to this store instance. Seed once at restoration, then
   * advance by returned count; an empty poll never enumerates historical events. */
  outboxIdsSince(offset = 0): readonly string[] {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Outbox offset must be a nonnegative safe integer");
    return this.outboxOrder.slice(offset);
  }
  committedEventIds(runId: string): EventMembership {
    let cursor = this.cursors.get(runId);
    if (!cursor) {
      const ids = new Set<string>();
      cursor = { ids, view: Object.freeze({ get size() { return ids.size; }, has: (id: string) => ids.has(id) }) };
      this.cursors.set(runId, cursor);
    }
    // Cursors are append-only and transactional with the immutable outbox.
    const events = this.manifest.runs[runId]?.eventCursor ?? [];
    for (let i = cursor.ids.size; i < events.length; i++) cursor.ids.add(events[i]);
    return cursor.view;
  }

  assertCustody(): void {
    if (this.isCurrent && !this.isCurrent()) throw new Error("Parent session/active branch lost custody");
    this.assertWriterCustody();
  }

  private assertWriterCustody(): void {
    if (this.closed) throw new Error("Runtime writer lost custody");
    const ownerFile = join(this.lease, "owner.json");
    const ownerStamp = fileStamp(ownerFile);
    if (ownerStamp !== this.ownerStamp) {
      if (JSON.parse(readFileSync(ownerFile, "utf8")).generation !== this.generation) throw new Error("Runtime writer lost custody");
      this.ownerStamp = ownerStamp;
    }
    const file = join(this.directory, "manifest.json");
    if (!existsSync(file)) {
      if (this.initialized) throw new Error("Runtime manifest disappeared; explicit reconciliation required");
      return;
    }
    const stamp = fileStamp(file);
    if (stamp === this.manifestStamp) return;
    const disk = readRuntimeManifest(this.directory)!;
    if (disk.generation !== this.manifest.generation || disk.revision !== this.manifest.revision) {
      throw new Error("Stale runtime revision/generation");
    }
    if (JSON.stringify(disk) !== JSON.stringify(this.manifest)) throw new Error("Runtime manifest changed without revision; explicit reconciliation required");
    this.manifestStamp = stamp;
  }

  private commit(next: RuntimeManifest, requireActiveBranch = true): void {
    if (requireActiveBranch) this.assertCustody();
    else this.assertWriterCustody();
    next.revision = this.manifest.revision + 1;
    validate(next);
    atomicRuntimeWrite(join(this.directory, "manifest.json"), next, () => {
      if (requireActiveBranch) this.assertCustody();
      else this.assertWriterCustody();
    });
    this.manifest = next;
    this.initialized = true;
    // Invalidate rather than stat after publication: a post-write stat failure
    // must not make a successful durable transaction look uncommitted.
    this.manifestStamp = undefined;
  }

  prepare(run: Omit<DurableRun, "phase" | "eventCursor">): void {
    const next = this.snapshot();
    if (next.runs[run.id]) throw new Error("Run already recorded");
    next.runs[run.id] = { ...structuredClone(run), phase: "prepared", eventCursor: [] };
    this.commit(next);
  }

  bindRun(id: string, binding: PlanTaskBinding, assignmentContract?: AssignmentContract): void {
    const next = this.snapshot();
    const run = next.runs[id];
    if (!run || !isPlanTaskBinding(binding)) throw new Error("Invalid run binding");
    if (run.planTask) {
      if (JSON.stringify(run.planTask) !== JSON.stringify(binding)) throw new Error("Run binding conflict");
      if (!assignmentContract) return;
    }
    if (assignmentContract && !isAssignmentContract(assignmentContract)) throw new Error("Invalid assignment contract");
    run.planTask = structuredClone(binding);
    if (run.profile && typeof run.profile === "object") run.profile = { ...run.profile, planTask: binding,
      ...(assignmentContract ? { assignmentContract: structuredClone(assignmentContract) } : {}) };
    this.commit(next);
  }

  /** Last synchronous write before a *fresh* terminal send. This cannot turn
   * a retained failure, continuation or already-dispatched run back into work. */
  commitFreshDispatch(id: string, sessionFile: string, binding: PlanTaskBinding | undefined): void {
    this.assertCustody();
    const next = this.snapshot();
    const run = next.runs[id];
    if (next.custodyPaused !== undefined || !run || run.phase !== "prepared" || run.sessionFile !== sessionFile ||
        !samePlanBinding(run.planTask, binding) || run.eventCursor.length || run.continuationRequestId !== undefined ||
        run.reconciliation !== undefined || next.retainedDispatchEvidence?.[id]) {
      throw new Error("Fresh dispatch requires the original prepared run under active custody with no prior disposition");
    }
    run.phase = "dispatch-intent";
    this.commit(next);
  }

  phase(id: string, phase: DurableRun["phase"]): void {
    const next = this.snapshot();
    if (!next.runs[id]) throw new Error("Unrecorded run");
    next.runs[id].phase = phase;
    this.commit(next);
  }

  enqueue(id: string, runId: string, envelope: DeliveryEnvelope): void {
    if (hasAfterIntentMarker(envelope)) throw new Error("After-intent dispatch failure evidence is import-only");
    if (this.hasMalformedAfterIntentCursor(runId)) throw new Error("Conflicting after-intent event cursor");
    const next = this.snapshot();
    if (!next.runs[runId]) throw new Error("Unrecorded event owner");
    if (next.outbox[id]) {
      if (JSON.stringify(next.outbox[id].envelope) !== JSON.stringify(envelope)) throw new Error("Immutable event conflict");
      return;
    }
    next.outbox[id] = { runId, envelope: structuredClone(envelope), status: "pending" };
    // Envelope and cursor are one transaction, before acknowledging any evidence.
    next.runs[runId].eventCursor.push(id);
    this.commit(next);
    this.outboxOrder.push(id);
  }

  /** Called only after reconciliation verifies the journal and run. Never
   * extend the validity of a generation; pin just this exact record. */
  retainDispatchEvidence(record: DispatchEvidence): void {
    this.assertCustody();
    const next = this.snapshot();
    if (next.custodyPaused || record.generation !== next.generation || record.revision > next.revision ||
        !isDeepStrictEqual(record.parent, next.parent) || next.outbox[record.eventId] || next.retainedDispatchEvidence?.[record.runId]) {
      throw new Error("Cannot retain dispatch evidence outside its writer custody");
    }
    (next.retainedDispatchEvidence ??= {})[record.runId] = structuredClone(record);
    this.commit(next);
  }

  /** Failure evidence is retained under original writer custody even while the
   * parent has navigated away. It is import-only, not a notification/relaunch. */
  recordDispatchFailure(run: Omit<DurableRun, "phase" | "eventCursor">, envelope: DeliveryEnvelope, requireActiveBranch = false,
    evidence?: DispatchEvidence): void {
    const next = this.snapshot();
    const id = String((envelope.message.details as { eventId: string }).eventId);
    const existing = next.runs[run.id];
    const committed = next.outbox[id];
    if (!hasAfterIntentMarker(envelope) && this.hasMalformedAfterIntentCursor(run.id)) throw new Error("Conflicting after-intent event cursor");
    if (existing && JSON.stringify(existing.planTask) !== JSON.stringify(run.planTask)) throw new Error("Run binding conflict");
    if (hasAfterIntentMarker(envelope) &&
        (!existing || !isAfterIntentFailure(existing, envelope) ||
         !isDeepStrictEqual(resumeIntentBinding(existing), resumeIntentBinding(run)) ||
         (committed ? committed.status !== "handedOff" || existing.eventCursor.length !== 1 || existing.eventCursor[0] !== id : existing.eventCursor.length !== 0))) {
      throw new Error("Run intent conflicts with before-send evidence");
    }
    if (committed) {
      if (committed.runId !== run.id || JSON.stringify(committed.envelope) !== JSON.stringify(envelope)) throw new Error("Immutable event conflict");
      return;
    }
    const retained = next.retainedDispatchEvidence?.[run.id];
    if (retained) {
      if (!requireActiveBranch || retained.eventId !== id || !isDeepStrictEqual(retained, evidence)) {
        throw new Error("Canonical publication conflicts with retained dispatch evidence");
      }
      delete next.retainedDispatchEvidence![run.id];
      if (!Object.keys(next.retainedDispatchEvidence!).length) delete next.retainedDispatchEvidence;
    }
    next.runs[run.id] ??= { ...structuredClone(run), phase: "prepared", eventCursor: [] };
    next.runs[run.id].eventCursor.push(id);
    next.runs[run.id].reconciliation = "Dispatch ended with failure/uncertainty; never automatically relaunch";
    next.outbox[id] = { runId: run.id, envelope: structuredClone(envelope), status: "handedOff" };
    this.commit(next, requireActiveBranch);
    this.outboxOrder.push(id);
    if (hasAfterIntentMarker(envelope)) this.markedRuns.add(run.id);
  }

  delivery(id: string, status: DurableEvent["status"]): void {
    const event = this.manifest.outbox[id];
    if (!event) throw new Error("Unrecorded delivery");
    if (hasAfterIntentMarker(event.envelope)) throw new Error("After-intent dispatch failure evidence is import-only");
    if (this.hasMalformedAfterIntentCursor(event.runId)) throw new Error("Conflicting after-intent event cursor");
    if (event.status === "handedOff" && status !== "handedOff") throw new Error("Cannot replay a tombstone");
    const next = this.snapshot();
    next.outbox[id].status = status;
    this.commit(next);
  }

  pauseCustody(reason: string): void {
    // Revocation is valid after confirmed navigation away from our branch.
    // It still requires the exact writer lease and manifest revision; no event
    // publication or other mutation may bypass the active-branch fence.
    this.commit({ ...this.snapshot(), custodyPaused: reason }, false);
  }

  continuation(id: string, requestId: string): void {
    const next = this.snapshot();
    if (!next.runs[id]) throw new Error("Unrecorded continuation owner");
    next.runs[id].continuationRequestId = requestId;
    this.commit(next);
  }

  settleContinuation(id: string, requestId: string): void {
    const next = this.snapshot();
    const run = next.runs[id];
    if (!run) throw new Error("Unrecorded continuation owner");
    if (!run.continuationRequestId) return;
    if (run.continuationRequestId !== requestId) throw new Error("Continuation request ownership changed");
    delete run.continuationRequestId;
    this.commit(next);
  }

  reconcileRun(id: string, reconciliation: string, verifiedLive = false): void {
    const next = this.snapshot();
    const run = next.runs[id];
    if (!run) throw new Error("Unrecorded run");
    run.reconciliation = reconciliation;
    // Keep historical execution proof distinct from the latest liveness
    // observation and from the original writer's dispatch phase.
    if (verifiedLive && run.phase !== "prepared") run.dispatchVerified = true;
    this.commit(next);
  }

  close(): void {
    // Release only our own lease even after navigation invalidates the branch.
    const current = this.isCurrent;
    this.isCurrent = undefined;
    try { this.assertCustody(); } finally { this.isCurrent = current; }
    this.closed = true;
    rmSync(this.lease, { recursive: true, force: true });
  }
}
