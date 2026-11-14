import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeliveryEnvelope } from "./delivery.ts";

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
  for (const [id, event] of Object.entries(value.outbox) as [string, any][]) {
    if (!value.runs[event.runId] || !["pending", "dispatching", "handedOff"].includes(event.status) ||
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

  readonly directory: string;

  constructor(directory: string, parent: RuntimeParent) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lease = join(directory, "writer");
    // Never steal a lease based on age. An abandoned/unknown writer fails closed.
    mkdirSync(this.lease, { mode: 0o700 });
    try {
      atomicRuntimeWrite(join(this.lease, "owner.json"), { generation: this.generation, pid: process.pid });
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
    if (this.closed || JSON.parse(readFileSync(join(this.lease, "owner.json"), "utf8")).generation !== this.generation) {
      throw new Error("Runtime writer lost custody");
    }
    const disk = readRuntimeManifest(this.directory);
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

  close(): void {
    this.assertCustody();
    this.closed = true;
    rmSync(this.lease, { recursive: true, force: true });
  }
}
