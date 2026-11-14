import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeliveryEnvelope } from "./delivery.ts";
import { probeProcess, sameProcess } from "./process-identity.ts";

export interface RuntimeParent {
  sessionFile: string;
  headerId: string;
  branchToken: string;
  checkpoint: string;
}
export interface DurableRun {
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
  entryCountBefore?: number;
  continuationRequestId?: string;
  startTime: number;
  phase: "prepared" | "dispatch-intent" | "supervised";
  eventCursor: string[];
  reconciliation?: string;
}
export interface DurableEvent {
  runId: string;
  envelope: DeliveryEnvelope;
  status: "pending" | "dispatching" | "handedOff";
}
export interface RuntimeManifest {
  schema: 1;
  revision: number;
  generation: string;
  custodyPaused?: string;
  parent: RuntimeParent;
  runs: Record<string, DurableRun>;
  outbox: Record<string, DurableEvent>;
}

/** Same-directory atomic replacement. Synchronous operations serialize local writers.
 * Permissions are advisory on Windows; this is same-user storage, not a sandbox. */
export function atomicRuntimeWrite(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function validate(value: any): asserts value is RuntimeManifest {
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.generation !== "string" || !value.parent ||
      !["sessionFile", "headerId", "branchToken", "checkpoint"].every((key) => typeof value.parent[key] === "string" && value.parent[key]) ||
      !value.runs || Array.isArray(value.runs) || !value.outbox || Array.isArray(value.outbox)) {
    throw new Error("Invalid or unsupported runtime manifest; explicit reconciliation required");
  }
  for (const [id, run] of Object.entries(value.runs) as [string, any][]) {
    if (run.id !== id || typeof run.sessionFile !== "string" || typeof run.name !== "string" || typeof run.task !== "string" ||
        !Number.isFinite(run.startTime) || !["prepared", "dispatch-intent", "supervised"].includes(run.phase) ||
        !Array.isArray(run.eventCursor) || !run.eventCursor.every((event: unknown) => typeof event === "string")) {
      throw new Error("Invalid durable run");
    }
  }
  for (const [id, run] of Object.entries(value.runs) as [string, any][]) {
    if (new Set(run.eventCursor).size !== run.eventCursor.length ||
        run.eventCursor.some((eventId: string) => value.outbox[eventId]?.runId !== id)) {
      throw new Error("Stale or invalid event cursor");
    }
  }
  for (const [id, event] of Object.entries(value.outbox) as [string, any][]) {
    if (!value.runs[event.runId]?.eventCursor.includes(id) || !["pending", "dispatching", "handedOff"].includes(event.status) ||
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

export class RuntimeStore {
  readonly generation = randomUUID();
  private manifest: RuntimeManifest;
  private readonly lease: string;
  private closed = false;
  private initialized = false;
  isCurrent?: () => boolean;

  readonly directory: string;

  constructor(directory: string, parent: RuntimeParent) {
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
      this.commit({ ...this.manifest, generation: this.generation });
    } catch (error) {
      rmSync(this.lease, { recursive: true, force: true });
      throw error;
    }
  }

  snapshot(): RuntimeManifest { return structuredClone(this.manifest); }

  assertCustody(): void {
    if (this.isCurrent && !this.isCurrent()) throw new Error("Parent session/active branch lost custody");
    if (this.closed || JSON.parse(readFileSync(join(this.lease, "owner.json"), "utf8")).generation !== this.generation) {
      throw new Error("Runtime writer lost custody");
    }
    const disk = readRuntimeManifest(this.directory);
    if (this.initialized && !disk) throw new Error("Runtime manifest disappeared; explicit reconciliation required");
    if (disk && (disk.generation !== this.manifest.generation || disk.revision !== this.manifest.revision)) {
      throw new Error("Stale runtime revision/generation");
    }
  }

  private commit(next: RuntimeManifest): void {
    this.assertCustody();
    next.revision = this.manifest.revision + 1;
    validate(next);
    atomicRuntimeWrite(join(this.directory, "manifest.json"), next);
    this.manifest = next;
    this.initialized = true;
  }

  prepare(run: Omit<DurableRun, "phase" | "eventCursor">): void {
    const next = this.snapshot();
    if (next.runs[run.id]) throw new Error("Run already recorded");
    next.runs[run.id] = { ...structuredClone(run), phase: "prepared", eventCursor: [] };
    this.commit(next);
  }

  phase(id: string, phase: DurableRun["phase"]): void {
    const next = this.snapshot();
    if (!next.runs[id]) throw new Error("Unrecorded run");
    next.runs[id].phase = phase;
    this.commit(next);
  }

  enqueue(id: string, runId: string, envelope: DeliveryEnvelope): void {
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
  }

  delivery(id: string, status: DurableEvent["status"]): void {
    const next = this.snapshot();
    if (!next.outbox[id]) throw new Error("Unrecorded delivery");
    if (next.outbox[id].status === "handedOff" && status !== "handedOff") throw new Error("Cannot replay a tombstone");
    next.outbox[id].status = status;
    this.commit(next);
  }

  pauseCustody(reason: string): void {
    this.commit({ ...this.snapshot(), custodyPaused: reason });
  }

  continuation(id: string, requestId: string): void {
    const next = this.snapshot();
    if (!next.runs[id]) throw new Error("Unrecorded continuation owner");
    next.runs[id].continuationRequestId = requestId;
    this.commit(next);
  }

  reconcileRun(id: string, reconciliation: string): void {
    const next = this.snapshot();
    if (!next.runs[id]) throw new Error("Unrecorded run");
    next.runs[id].reconciliation = reconciliation;
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
