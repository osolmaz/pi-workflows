import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StateDatabase, workflowStatePath } from "./database.js";
import { recordViewerDeltas } from "./viewer.js";

type LeaseRow = {
  generation: number;
  ownerType: string | null;
  ownerId: string | null;
  tokenHash: Buffer | null;
  expiresAt: number | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLeaseRow(value: unknown): value is LeaseRow {
  return isRecord(value);
}

function isProjectRow(value: unknown): value is { projectId: string } {
  return isRecord(value);
}

function isRevisionRow(value: unknown): value is { revision: number } {
  return isRecord(value);
}

export function isSequenceRow(value: unknown): value is { seq: number } {
  return isRecord(value);
}

function projectIdFor(canonicalPath: string): string {
  return `project-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 40)}`;
}

function canonicalProjectPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

export function validTimestamp(value?: string): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp");
  return date.toISOString();
}

export function epoch(value: string): number {
  return Date.parse(value);
}

/** Shared connection, project, and revision operations; domain stores own their rows. */
export abstract class ProjectStore {
  readonly filePath: string;

  readonly state: StateDatabase;

  private readonly ownsState: boolean;

  protected readonly projectId: string | null;

  private closed = false;

  constructor(
    filePath: string = workflowStatePath(),
    options: {
      readOnly?: boolean;
      projectPath?: string;
      state?: StateDatabase;
      /** Server-only global view. Project-scoped mutations still require projectPath. */
      global?: boolean;
    } = {},
  ) {
    this.ownsState = options.state === undefined;
    this.state =
      options.state ??
      new StateDatabase({
        filePath,
        mode: options.readOnly === true ? "read-only" : "read-write",
        checkLegacyState: filePath === workflowStatePath(),
      });
    this.filePath = this.state.filePath;
    if (options.global === true) {
      this.projectId = null;
    } else {
      const projectPath = options.projectPath === undefined ? process.cwd() : options.projectPath;
      this.projectId =
        this.state.mode === "read-only"
          ? this.findProject(projectPath)
          : this.ensureProject(projectPath);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsState) this.state.close();
  }

  private ensureProject(projectPath: string): string {
    const canonicalPath = canonicalProjectPath(projectPath);
    const projectId = projectIdFor(canonicalPath);
    this.state.connection
      .prepare(
        `INSERT INTO projects(project_id, canonical_path, created_at)
         VALUES (?, ?, ?) ON CONFLICT(project_id) DO NOTHING`,
      )
      .run(projectId, canonicalPath, Date.now());
    return projectId;
  }

  private findProject(projectPath: string): string | null {
    const row = this.state.connection
      .prepare("SELECT project_id AS projectId FROM projects WHERE canonical_path = ?")
      .get(canonicalProjectPath(projectPath));
    return isProjectRow(row) ? row.projectId : null;
  }

  protected requireProjectId(): string {
    if (this.projectId === null) throw new Error("Project is not registered in the state database");
    return this.projectId;
  }

  protected requireLease(resourceId: string): LeaseRow {
    const row = this.state.connection
      .prepare(
        `SELECT generation, owner_type AS ownerType, owner_id AS ownerId,
                token_hash AS tokenHash, expires_at AS expiresAt
         FROM leases WHERE resource_id = ?`,
      )
      .get(resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isLeaseRow(row)) throw new Error(`Lease is missing: ${resourceId}`);
    return row;
  }

  protected resourceRevision(resourceId: string): number {
    const row = this.state.connection
      .prepare("SELECT revision FROM resources WHERE resource_id = ?")
      .get(resourceId);
    /* istanbul ignore if -- exact schema and internal query shape */
    /* istanbul ignore if -- impossible after exact schema and transaction checks */
    if (!isRevisionRow(row)) throw new Error(`Resource is missing: ${resourceId}`);
    return row.revision;
  }

  protected bumpResource(resourceId: string, expectedRevision: number, now: number): void {
    const result = this.state.connection
      .prepare(
        "UPDATE resources SET revision = revision + 1, updated_at = ? WHERE resource_id = ? AND revision = ?",
      )
      .run(now, resourceId, expectedRevision);
    if (result.changes !== 1) throw new Error("Resource revision conflict");
    const run = this.state.connection
      .prepare(
        `SELECT r.run_id AS runId
         FROM runs r JOIN viewer_runs v ON v.run_id = r.run_id
         WHERE r.resource_id = ?`,
      )
      .get(resourceId);
    if (isRecord(run) && typeof run.runId === "string") {
      recordViewerDeltas(
        this.state,
        run.runId,
        [
          { targetType: "summary" },
          { targetType: "graph" },
          { targetType: "replay" },
          { targetType: "inspector", targetKey: "run" },
        ],
        now,
      );
    }
  }

  protected insertEvent(
    resourceId: string,
    revision: number,
    type: string,
    actorType: string,
    actorId: string | null,
    payload: unknown,
    now: number,
    leaseGeneration?: number,
  ): string {
    const eventId = `event-${randomUUID()}`;
    const payloadHash = this.state.putJson(payload, now);
    this.state.connection
      .prepare(
        `INSERT INTO events(
           event_id, resource_id, resource_revision, event_type, actor_type,
           actor_id, lease_generation, payload_hash, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        resourceId,
        revision,
        type,
        actorType,
        actorId,
        leaseGeneration ?? null,
        payloadHash,
        now,
      );
    return eventId;
  }

  protected assertWritable(): void {
    if (this.state.mode === "read-only") throw new Error("State store is read-only");
  }
}
