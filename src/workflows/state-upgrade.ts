import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, parseJson } from "../state/json.js";
import {
  PRE_VIEWER_STATE_SCHEMA_DIGEST,
  STATE_APPLICATION_ID,
  STATE_APP_VERSION,
  STATE_SCHEMA_DIGEST,
  STATE_SCHEMA_NAME,
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_VERSION,
} from "../state/schema.js";
import { VIEWER_PAGE_SIZE } from "../state/viewer.js";
import {
  boundedTemporalCheckpoint,
  reduceSessionEvents,
  reduceSessionEventsFromCheckpoint,
  type TemporalSessionState,
} from "./session-reducer.js";
import type { WorkflowSessionEventRecord, WorkflowSessionEventType } from "./types.js";

const BUSY_TIMEOUT_MS = 5_000;
const PRE_VIEWER_STATE_SCHEMA_SHAPE =
  "f0f415da472883fe413850009adcde85bc74d7223d6323c11e55f0260c05e138";
const UPGRADE_SQL = String.raw`
CREATE TEMP TABLE state_upgrade_session_entries AS
SELECT e.segment_id, s.run_id, e.entry_seq,
       row_number() OVER (
         PARTITION BY s.run_id
         ORDER BY e.recorded_at, e.segment_id, e.entry_seq
       ) AS run_seq,
       e.entry_id, e.entry_hash, e.recorded_at
FROM session_entries e
JOIN session_segments s ON s.segment_id = e.segment_id;

DROP TABLE session_entries;

CREATE TABLE session_entries (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  entry_seq INTEGER NOT NULL CHECK (entry_seq > 0),
  run_seq INTEGER NOT NULL CHECK (run_seq > 0),
  entry_id TEXT NOT NULL,
  entry_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, entry_seq),
  UNIQUE (segment_id, entry_id),
  UNIQUE (run_id, run_seq)
) STRICT;

CREATE INDEX session_entries_run_idx ON session_entries(run_id, run_seq);

INSERT INTO session_entries(
  segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at
)
SELECT segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at
FROM state_upgrade_session_entries;

DROP TABLE state_upgrade_session_entries;

CREATE TEMP TABLE state_upgrade_session_events AS
SELECT e.segment_id, s.run_id, e.event_seq,
       row_number() OVER (
         PARTITION BY s.run_id
         ORDER BY e.recorded_at, e.segment_id, e.event_seq
       ) AS run_seq,
       e.event_type, e.node_id, e.attempt_id, e.turn_id, e.message_id,
       e.tool_call_id, e.payload_hash, e.recorded_at
FROM session_events e
JOIN session_segments s ON s.segment_id = e.segment_id;

DROP TABLE session_events;

CREATE TABLE session_events (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  run_seq INTEGER NOT NULL CHECK (run_seq > 0),
  event_type TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  tool_call_id TEXT,
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, event_seq),
  UNIQUE (run_id, run_seq)
) STRICT;

CREATE INDEX session_events_run_idx ON session_events(run_id, run_seq);

INSERT INTO session_events(
  segment_id, run_id, event_seq, run_seq, event_type, node_id, attempt_id,
  turn_id, message_id, tool_call_id, payload_hash, recorded_at
)
SELECT segment_id, run_id, event_seq, run_seq, event_type, node_id, attempt_id,
       turn_id, message_id, tool_call_id, payload_hash, recorded_at
FROM state_upgrade_session_events;

DROP TABLE state_upgrade_session_events;

CREATE TABLE viewer_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  presentation_revision INTEGER NOT NULL CHECK (presentation_revision >= 1),
  retained_from_revision INTEGER NOT NULL CHECK (
    retained_from_revision >= 1 AND retained_from_revision <= presentation_revision
  ),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE viewer_deltas (
  run_id TEXT NOT NULL REFERENCES viewer_runs(run_id) ON DELETE CASCADE,
  presentation_revision INTEGER NOT NULL CHECK (presentation_revision >= 1),
  delta_index INTEGER NOT NULL CHECK (delta_index >= 0),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'summary', 'graph', 'replay', 'timeline', 'conversation', 'inspector'
  )),
  target_key TEXT NOT NULL,
  patch_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, presentation_revision, delta_index)
) STRICT;

CREATE INDEX viewer_deltas_resume_idx
  ON viewer_deltas(run_id, presentation_revision, delta_index);

CREATE TABLE viewer_session_checkpoints (
  run_id TEXT NOT NULL REFERENCES viewer_runs(run_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  state_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, event_seq)
) STRICT;
`;

const LEGACY_ENTRY_DIGEST_SQL = `
  SELECT segment_id AS segmentId, entry_seq AS entrySeq, entry_id AS entryId,
         hex(entry_hash) AS entryHash, recorded_at AS recordedAt
  FROM session_entries ORDER BY segment_id, entry_seq
`;
const LEGACY_EVENT_DIGEST_SQL = `
  SELECT segment_id AS segmentId, event_seq AS eventSeq, event_type AS eventType,
         node_id AS nodeId, attempt_id AS attemptId, turn_id AS turnId,
         message_id AS messageId, tool_call_id AS toolCallId,
         hex(payload_hash) AS payloadHash, recorded_at AS recordedAt
  FROM session_events ORDER BY segment_id, event_seq
`;

export type StateUpgradeReport = {
  backupPath: string;
  backupSha256: string;
  sourceSchemaDigest: string;
  targetSchemaDigest: string;
  runs: number;
  sessionEntries: number;
  sessionEvents: number;
  replayCheckpoints: number;
};

type SchemaMetaRow = {
  schemaName: string;
  schemaVersion: number;
  schemaDigest: Buffer;
  appVersion: string;
};

type CountRow = { count: number };

type RunIdRow = { runId: string };

type SessionEventUpgradeRow = {
  runId: string;
  runSeq: number;
  eventType: string;
  nodeId: string;
  attemptId: string;
  turnId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  payloadContent: Buffer;
  payloadMediaType: string;
  recordedAt: number;
};

type BlobRow = {
  mediaType: string;
  byteLength: number;
  content: Buffer;
};

type SchemaObjectRow = {
  type: string;
  name: string;
  tableName: string;
  sql: string;
};

let expectedShape: string | undefined;

/** Upgrade only the exact pre-viewer alpha schema after making a stable backup. */
export function upgradePreViewerStateDatabase(
  databasePath: string,
  backupPath: string,
): StateUpgradeReport {
  const source = path.resolve(databasePath);
  if (!path.isAbsolute(backupPath)) {
    throw new Error("State upgrade backup path must be absolute");
  }
  const backup = path.resolve(backupPath);
  if (source === backup) {
    throw new Error("State upgrade backup must differ from the live database");
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Pi Workflows state database does not exist: ${source}`);
  }
  if (fs.existsSync(backup)) {
    throw new Error(`State upgrade backup already exists: ${backup}`);
  }

  const database = new Database(source, { timeout: BUSY_TIMEOUT_MS });
  let backupComplete = false;
  try {
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    verifyPreViewerSchema(database);
    verifyIntegrity(database);
    assertNoActiveLeases(database);
    checkpointWal(database);

    database.pragma("foreign_keys = OFF");
    database.exec("BEGIN EXCLUSIVE");
    try {
      verifyPreViewerSchema(database);
      assertNoActiveLeases(database);
      const sourceEntries = tableDigest(database, LEGACY_ENTRY_DIGEST_SQL);
      const sourceEvents = tableDigest(database, LEGACY_EVENT_DIGEST_SQL);
      const runs = rowCount(database, "runs");
      const sessionEntries = rowCount(database, "session_entries");
      const sessionEvents = rowCount(database, "session_events");

      backupComplete = copyAndVerifyBackup(database, source, backup);
      database.exec(UPGRADE_SQL);
      database
        .prepare(
          `INSERT INTO viewer_runs(
             run_id, presentation_revision, retained_from_revision, updated_at
           )
           SELECT run_id, 1, 1, updated_at FROM runs`,
        )
        .run();
      const replayCheckpoints = backfillReplayCheckpoints(database);
      database
        .prepare(
          `UPDATE schema_meta
           SET schema_digest = ?, app_version = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(STATE_SCHEMA_DIGEST, STATE_APP_VERSION, Date.now());

      if (rowCount(database, "runs") !== runs || rowCount(database, "viewer_runs") !== runs) {
        throw new Error("State upgrade did not preserve every workflow run");
      }
      if (rowCount(database, "session_entries") !== sessionEntries) {
        throw new Error("State upgrade changed the session entry count");
      }
      if (rowCount(database, "session_events") !== sessionEvents) {
        throw new Error("State upgrade changed the session event count");
      }
      if (tableDigest(database, LEGACY_ENTRY_DIGEST_SQL) !== sourceEntries) {
        throw new Error("State upgrade changed existing session entry data");
      }
      if (tableDigest(database, LEGACY_EVENT_DIGEST_SQL) !== sourceEvents) {
        throw new Error("State upgrade changed existing session event data");
      }
      verifyCurrentSchema(database);
      verifyIntegrity(database);
      database.exec("COMMIT");
      database.pragma("foreign_keys = ON");
      verifyCurrentSchema(database);
      verifyIntegrity(database);

      return {
        backupPath: backup,
        backupSha256: fileSha256(backup),
        sourceSchemaDigest: PRE_VIEWER_STATE_SCHEMA_DIGEST.toString("hex"),
        targetSchemaDigest: STATE_SCHEMA_DIGEST.toString("hex"),
        runs,
        sessionEntries,
        sessionEvents,
        replayCheckpoints,
      };
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      database.pragma("foreign_keys = ON");
      throw error;
    }
  } catch (error) {
    if (!backupComplete && fs.existsSync(backup)) fs.rmSync(backup);
    throw error;
  } finally {
    database.close();
  }
}

function verifyPreViewerSchema(database: Database.Database): void {
  const applicationId = database.pragma("application_id", { simple: true });
  const userVersion = database.pragma("user_version", { simple: true });
  const row = readSchemaMeta(database);
  if (
    applicationId !== STATE_APPLICATION_ID ||
    userVersion !== STATE_SCHEMA_VERSION ||
    row.schemaName !== STATE_SCHEMA_NAME ||
    row.schemaVersion !== STATE_SCHEMA_VERSION ||
    row.appVersion !== STATE_APP_VERSION ||
    !row.schemaDigest.equals(PRE_VIEWER_STATE_SCHEMA_DIGEST)
  ) {
    if (row.schemaDigest.equals(STATE_SCHEMA_DIGEST)) {
      throw new Error("Pi Workflows state already uses the current viewer schema");
    }
    throw new Error("Pi Workflows state is not the exact supported pre-viewer alpha schema");
  }
  assertTableColumns(database, "session_entries", [
    "segment_id",
    "entry_seq",
    "entry_id",
    "entry_hash",
    "recorded_at",
  ]);
  assertTableColumns(database, "session_events", [
    "segment_id",
    "event_seq",
    "event_type",
    "node_id",
    "attempt_id",
    "turn_id",
    "message_id",
    "tool_call_id",
    "payload_hash",
    "recorded_at",
  ]);
  for (const table of ["viewer_runs", "viewer_deltas", "viewer_session_checkpoints"]) {
    if (tableExists(database, table)) {
      throw new Error(`Pre-viewer state unexpectedly contains ${table}`);
    }
  }
  if (schemaShape(database) !== PRE_VIEWER_STATE_SCHEMA_SHAPE) {
    throw new Error("Pi Workflows state is not the exact supported pre-viewer alpha schema");
  }
}

function verifyCurrentSchema(database: Database.Database): void {
  const row = readSchemaMeta(database);
  if (
    row.schemaName !== STATE_SCHEMA_NAME ||
    row.schemaVersion !== STATE_SCHEMA_VERSION ||
    row.appVersion !== STATE_APP_VERSION ||
    !row.schemaDigest.equals(STATE_SCHEMA_DIGEST) ||
    schemaShape(database) !== expectedSchemaShape()
  ) {
    throw new Error("State upgrade did not produce the exact current Pi Workflows schema");
  }
}

function readSchemaMeta(database: Database.Database): SchemaMetaRow {
  const row = database
    .prepare(
      `SELECT schema_name AS schemaName, schema_version AS schemaVersion,
              schema_digest AS schemaDigest, app_version AS appVersion
       FROM schema_meta WHERE id = 1`,
    )
    .get();
  if (!isSchemaMetaRow(row)) {
    throw new Error("Pi Workflows state schema metadata is invalid");
  }
  return row;
}

function assertNoActiveLeases(database: Database.Database): void {
  const row = database
    .prepare(
      `SELECT count(*) AS count FROM leases
       WHERE owner_id IS NOT NULL AND expires_at > ?`,
    )
    .get(Date.now());
  if (!isCountRow(row)) throw new Error("Pi Workflows active lease count is invalid");
  if (row.count !== 0) {
    throw new Error("Stop all active Pi Workflows runs and hosts before upgrading state");
  }
}

function checkpointWal(database: Database.Database): void {
  const rows = database.pragma("wal_checkpoint(TRUNCATE)");
  if (!Array.isArray(rows) || rows.length !== 1 || !isCheckpointResult(rows[0])) {
    throw new Error("Pi Workflows state WAL checkpoint returned an invalid result");
  }
  if (rows[0].busy !== 0 || rows[0].log !== rows[0].checkpointed) {
    throw new Error("Pi Workflows state is busy; stop its writers and retry the upgrade");
  }
}

function copyAndVerifyBackup(
  sourceDatabase: Database.Database,
  sourcePath: string,
  backupPath: string,
): boolean {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);
  if (fileSha256(sourcePath) !== fileSha256(backupPath)) {
    throw new Error("State upgrade backup does not match the stable source database");
  }
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    backup.pragma("foreign_keys = ON");
    verifyPreViewerSchema(backup);
    verifyIntegrity(backup);
  } finally {
    backup.close();
  }
  verifyPreViewerSchema(sourceDatabase);
  return true;
}

function backfillReplayCheckpoints(database: Database.Database): number {
  const runRows = database
    .prepare("SELECT DISTINCT run_id AS runId FROM session_events ORDER BY run_id")
    .all();
  const pageStatement = database.prepare(
    `SELECT e.run_id AS runId, e.run_seq AS runSeq, e.event_type AS eventType,
            e.node_id AS nodeId, e.attempt_id AS attemptId, e.turn_id AS turnId,
            e.message_id AS messageId, e.tool_call_id AS toolCallId,
            b.content AS payloadContent, b.media_type AS payloadMediaType,
            e.recorded_at AS recordedAt
     FROM session_events e
     JOIN blobs b ON b.blob_hash = e.payload_hash
     WHERE e.run_id = ? AND e.run_seq > ?
     ORDER BY e.run_seq LIMIT ?`,
  );
  let checkpointCount = 0;
  for (const runValue of runRows) {
    if (!isRunIdRow(runValue)) throw new Error("State upgrade found an invalid run row");
    let checkpoint: TemporalSessionState = reduceSessionEvents([], [], 0);
    let afterSequence = 0;
    while (true) {
      const values = pageStatement.all(runValue.runId, afterSequence, VIEWER_PAGE_SIZE);
      if (values.length < VIEWER_PAGE_SIZE) break;
      const page = values.map(sessionEventUpgradeRecord);
      const last = page.at(-1);
      if (last === undefined) throw new Error("State upgrade found an empty replay page");
      checkpoint = reduceSessionEventsFromCheckpoint([], page, last.seq, checkpoint);
      checkpoint = boundedTemporalCheckpoint(checkpoint);
      const recordedAt = Date.parse(last.at);
      if (!Number.isFinite(recordedAt)) {
        throw new Error("State upgrade found an invalid session event timestamp");
      }
      putReplayCheckpoint(database, runValue.runId, last.seq, checkpoint, recordedAt);
      checkpointCount += 1;
      afterSequence = last.seq;
    }
  }
  return checkpointCount;
}

function sessionEventUpgradeRecord(value: unknown): WorkflowSessionEventRecord {
  if (!isSessionEventUpgradeRow(value)) {
    throw new Error("State upgrade found an invalid session event row");
  }
  if (value.payloadMediaType !== "application/json") {
    throw new Error("State upgrade found a session event payload with the wrong media type");
  }
  const payload = parseJson(value.payloadContent.toString("utf8"));
  if (!isRecord(payload)) {
    throw new Error("State upgrade found a session event payload that is not an object");
  }
  return {
    seq: value.runSeq,
    at: new Date(value.recordedAt).toISOString(),
    nodeId: value.nodeId,
    attemptId: value.attemptId,
    ...(value.turnId === null ? {} : { turnId: value.turnId }),
    ...(value.messageId === null ? {} : { messageId: value.messageId }),
    ...(value.toolCallId === null ? {} : { toolCallId: value.toolCallId }),
    type: sessionEventType(value.eventType),
    payload,
  };
}

function putReplayCheckpoint(
  database: Database.Database,
  runId: string,
  eventSequence: number,
  checkpoint: TemporalSessionState,
  recordedAt: number,
): void {
  const content = Buffer.from(canonicalJson(checkpoint), "utf8");
  const hash = createHash("sha256").update(content).digest();
  database
    .prepare(
      `INSERT INTO blobs(blob_hash, media_type, byte_length, content, created_at)
       VALUES (?, 'application/json', ?, ?, ?)
       ON CONFLICT(blob_hash) DO NOTHING`,
    )
    .run(hash, content.byteLength, content, recordedAt);
  const row = database
    .prepare(
      `SELECT media_type AS mediaType, byte_length AS byteLength, content
       FROM blobs WHERE blob_hash = ?`,
    )
    .get(hash);
  if (
    !isBlobRow(row) ||
    row.mediaType !== "application/json" ||
    row.byteLength !== content.byteLength ||
    !row.content.equals(content)
  ) {
    throw new Error("State upgrade found a replay checkpoint blob conflict");
  }
  database
    .prepare(
      `INSERT INTO viewer_session_checkpoints(run_id, event_seq, state_hash, recorded_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(runId, eventSequence, hash, recordedAt);
}

function verifyIntegrity(database: Database.Database): void {
  const integrity = database.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error("Pi Workflows SQLite integrity check failed");
  const foreignKeys = database.pragma("foreign_key_check");
  if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0) {
    throw new Error("Pi Workflows SQLite foreign-key check failed");
  }
}

function rowCount(database: Database.Database, table: string): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid state table name");
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get();
  if (!isCountRow(row)) throw new Error(`State upgrade count is invalid for ${table}`);
  return row.count;
}

function tableDigest(database: Database.Database, sql: string): string {
  const hash = createHash("sha256");
  for (const row of database.prepare(sql).iterate()) {
    hash.update(canonicalJson(row));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function fileSha256(filePath: string): string {
  const descriptor = fs.openSync(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function tableExists(database: Database.Database, table: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function assertTableColumns(
  database: Database.Database,
  table: string,
  expected: readonly string[],
): void {
  const columns = database.pragma(`table_info(${table})`);
  if (!Array.isArray(columns)) throw new Error(`State upgrade cannot inspect ${table}`);
  const names = columns.map((value) => {
    if (!isRecord(value) || typeof value.name !== "string") {
      throw new Error(`State upgrade found an invalid ${table} column`);
    }
    return value.name;
  });
  if (canonicalJson(names) !== canonicalJson(expected)) {
    throw new Error(`State upgrade found an unsupported ${table} shape`);
  }
}

function expectedSchemaShape(): string {
  if (expectedShape !== undefined) return expectedShape;
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(STATE_SCHEMA_SQL);
    expectedShape = schemaShape(database);
    return expectedShape;
  } finally {
    database.close();
  }
}

function schemaShape(database: Database.Database): string {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
  const normalized: SchemaObjectRow[] = [];
  for (const row of rows) {
    if (!isSchemaObjectRow(row)) {
      throw new Error("Pi Workflows database contains an invalid schema object");
    }
    normalized.push(row);
  }
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function sessionEventType(value: string): WorkflowSessionEventType {
  switch (value) {
    case "turn_started":
    case "turn_finished":
    case "message_started":
    case "assistant_event":
    case "message_finished":
    case "tool_execution_started":
    case "tool_execution_finished":
      return value;
    default:
      throw new Error(`State upgrade found an unknown session event type: ${value}`);
  }
}

function isSchemaMetaRow(value: unknown): value is SchemaMetaRow {
  return (
    isRecord(value) &&
    typeof value.schemaName === "string" &&
    typeof value.schemaVersion === "number" &&
    Buffer.isBuffer(value.schemaDigest) &&
    typeof value.appVersion === "string"
  );
}

function isCountRow(value: unknown): value is CountRow {
  return isRecord(value) && typeof value.count === "number";
}

function isCheckpointResult(
  value: unknown,
): value is { busy: number; log: number; checkpointed: number } {
  return (
    isRecord(value) &&
    typeof value.busy === "number" &&
    typeof value.log === "number" &&
    typeof value.checkpointed === "number"
  );
}

function isRunIdRow(value: unknown): value is RunIdRow {
  return isRecord(value) && typeof value.runId === "string";
}

function isSessionEventUpgradeRow(value: unknown): value is SessionEventUpgradeRow {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.runSeq === "number" &&
    typeof value.eventType === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.attemptId === "string" &&
    (typeof value.turnId === "string" || value.turnId === null) &&
    (typeof value.messageId === "string" || value.messageId === null) &&
    (typeof value.toolCallId === "string" || value.toolCallId === null) &&
    Buffer.isBuffer(value.payloadContent) &&
    typeof value.payloadMediaType === "string" &&
    typeof value.recordedAt === "number"
  );
}

function isBlobRow(value: unknown): value is BlobRow {
  return (
    isRecord(value) &&
    typeof value.mediaType === "string" &&
    typeof value.byteLength === "number" &&
    Buffer.isBuffer(value.content)
  );
}

function isSchemaObjectRow(value: unknown): value is SchemaObjectRow {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.name === "string" &&
    typeof value.tableName === "string" &&
    typeof value.sql === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
