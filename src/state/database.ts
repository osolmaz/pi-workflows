import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, parseJson, type JsonValue } from "./json.js";
import {
  STATE_APPLICATION_ID,
  STATE_APP_VERSION,
  STATE_SCHEMA_DIGEST,
  STATE_SCHEMA_NAME,
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_VERSION,
} from "./schema.js";

const DATABASE_FILE = "state.sqlite";
const BUSY_TIMEOUT_MS = 5_000;
const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;
const RESET_INSTRUCTION =
  "Pi Workflows durable state is incompatible. Move or remove the old workflow state, then create a new state.sqlite database.";

export type StateDatabaseMode = "read-write" | "read-only";

export type OpenStateDatabaseOptions = {
  filePath?: string;
  homeDir?: string;
  mode?: StateDatabaseMode;
  checkLegacyState?: boolean;
};

export type BlobRecord = {
  hash: Buffer;
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

type SchemaMetaRow = {
  schemaName: string;
  schemaVersion: number;
  schemaDigest: Buffer;
  appVersion: string;
};

type BlobRow = {
  blobHash: Buffer;
  mediaType: string;
  byteLength: number;
  content: Buffer;
};

let expectedShape: string | undefined;

export function workflowStatePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", "workflows", DATABASE_FILE);
}

export class StateDatabase {
  readonly filePath: string;
  readonly mode: StateDatabaseMode;
  readonly connection: Database.Database;

  constructor(options: OpenStateDatabaseOptions = {}) {
    this.filePath = path.resolve(options.filePath ?? workflowStatePath(options.homeDir));
    this.mode = options.mode ?? "read-write";
    const existed = fs.existsSync(this.filePath);
    if (this.mode === "read-only" && !existed) {
      throw new Error(`Pi Workflows state database does not exist: ${this.filePath}`);
    }
    if (!existed && this.mode === "read-write") {
      if (options.checkLegacyState ?? options.filePath === undefined) {
        assertNoLegacyState(this.filePath, options.homeDir ?? os.homedir());
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(this.filePath), 0o700);
    }

    this.connection = new Database(this.filePath, {
      readonly: this.mode === "read-only",
      fileMustExist: this.mode === "read-only",
      timeout: BUSY_TIMEOUT_MS,
    });

    try {
      this.configure(existed);
      if (this.mode === "read-write") {
        this.prepareSchema(!existed);
      }
      this.verifySchema();
      if (this.mode === "read-only") {
        this.connection.pragma("query_only = ON");
      } else {
        this.pruneUnreferencedBlobs();
        fs.chmodSync(this.filePath, 0o600);
      }
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    if (this.mode === "read-only") {
      throw new Error("Cannot mutate a read-only Pi Workflows database");
    }
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.connection.inTransaction) {
        this.connection.exec("ROLLBACK");
      }
      throw error;
    }
  }

  putJson(value: unknown, now: number = Date.now()): Buffer {
    return this.putBlob(Buffer.from(canonicalJson(value), "utf8"), "application/json", now);
  }

  putText(value: string, now: number = Date.now()): Buffer {
    return this.putBlob(Buffer.from(value, "utf8"), "text/plain", now);
  }

  putBlob(content: Buffer, mediaType: string, now: number = Date.now()): Buffer {
    if (this.mode === "read-only") {
      throw new Error("Cannot write a blob through a read-only Pi Workflows database");
    }
    const hash = createHash("sha256").update(content).digest();
    this.connection
      .prepare(
        `INSERT INTO blobs(blob_hash, media_type, byte_length, content, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(blob_hash) DO NOTHING`,
      )
      .run(hash, mediaType, content.byteLength, content, now);
    const stored = this.readBlob(hash);
    if (
      stored === undefined ||
      stored.mediaType !== mediaType ||
      stored.byteLength !== content.byteLength ||
      !stored.content.equals(content)
    ) {
      throw new Error("Content-addressed blob conflict");
    }
    return hash;
  }

  readBlob(hash: Buffer): BlobRecord | undefined {
    const row = this.connection
      .prepare(
        `SELECT blob_hash AS blobHash, media_type AS mediaType,
                byte_length AS byteLength, content
         FROM blobs WHERE blob_hash = ?`,
      )
      .get(hash);
    if (!isBlobRow(row)) {
      return undefined;
    }
    return {
      hash: row.blobHash,
      mediaType: row.mediaType,
      byteLength: row.byteLength,
      content: row.content,
    };
  }

  readJson(hash: Buffer): JsonValue {
    const blob = this.readBlob(hash);
    if (blob === undefined || blob.mediaType !== "application/json") {
      throw new Error("JSON blob is missing or has the wrong media type");
    }
    return parseJson(blob.content.toString("utf8"));
  }

  integrityCheck(): void {
    const result = this.connection.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`Pi Workflows SQLite integrity check failed: ${String(result)}`);
    }
    const foreignKeys = this.connection.pragma("foreign_key_check");
    if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0) {
      throw new Error("Pi Workflows SQLite foreign-key check failed");
    }
  }

  pruneUnreferencedBlobs(): number {
    if (this.mode === "read-only") {
      throw new Error("Cannot prune blobs through a read-only Pi Workflows database");
    }
    return this.transaction(() => {
      this.connection.exec(
        "CREATE TEMP TABLE referenced_blobs(blob_hash BLOB PRIMARY KEY) WITHOUT ROWID",
      );
      const tables = this.connection
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'blobs'`,
        )
        .all()
        .filter(isTableNameRow);
      for (const table of tables) {
        const columns = this.connection
          .prepare(
            `SELECT "from" AS columnName FROM pragma_foreign_key_list(?)
             WHERE "table" = 'blobs' AND "to" = 'blob_hash'`,
          )
          .all(table.name)
          .filter(isColumnNameRow);
        for (const column of columns) {
          this.connection
            .prepare(
              `INSERT OR IGNORE INTO referenced_blobs(blob_hash)
               SELECT ${quoteIdentifier(column.columnName)} FROM ${quoteIdentifier(table.name)}
               WHERE ${quoteIdentifier(column.columnName)} IS NOT NULL`,
            )
            .run();
        }
      }
      const result = this.connection
        .prepare(
          `DELETE FROM blobs
           WHERE NOT EXISTS (
             SELECT 1 FROM referenced_blobs r WHERE r.blob_hash = blobs.blob_hash
           )`,
        )
        .run();
      this.connection.exec("DROP TABLE referenced_blobs");
      return result.changes;
    });
  }

  async backup(destination: string): Promise<void> {
    if (path.resolve(destination) === this.filePath) {
      throw new Error("Backup destination must differ from the live database");
    }
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true, mode: 0o700 });
    this.integrityCheck();
    await this.connection.backup(destination);
    fs.chmodSync(destination, 0o600);
    const backup = new StateDatabase({ filePath: destination, mode: "read-only" });
    try {
      backup.integrityCheck();
    } finally {
      backup.close();
    }
  }

  private configure(existed: boolean): void {
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (this.mode === "read-write") {
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("synchronous = FULL");
      this.connection.pragma("wal_autocheckpoint = 1000");
      this.connection.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
    } else if (existed) {
      this.connection.pragma("synchronous = FULL");
    }
  }

  private prepareSchema(allowInitialize: boolean): void {
    this.connection.exec("BEGIN EXCLUSIVE");
    try {
      const schema = this.connection
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
        )
        .get();
      if (schema === undefined) {
        if (!allowInitialize) throw new Error(RESET_INSTRUCTION);
        this.initialize();
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      if (this.connection.inTransaction) this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize(): void {
    this.connection.exec(STATE_SCHEMA_SQL);
    this.connection.pragma(`application_id = ${STATE_APPLICATION_ID}`);
    this.connection.pragma(`user_version = ${STATE_SCHEMA_VERSION}`);
    const now = Date.now();
    this.connection
      .prepare(
        `INSERT INTO schema_meta(
           id, schema_name, schema_version, schema_digest, app_version, created_at, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        STATE_SCHEMA_NAME,
        STATE_SCHEMA_VERSION,
        STATE_SCHEMA_DIGEST,
        STATE_APP_VERSION,
        now,
        now,
      );
  }

  private verifySchema(): void {
    const applicationId = this.connection.pragma("application_id", { simple: true });
    const userVersion = this.connection.pragma("user_version", { simple: true });
    if (applicationId !== STATE_APPLICATION_ID || userVersion !== STATE_SCHEMA_VERSION) {
      throw new Error(RESET_INSTRUCTION);
    }
    const row = this.connection
      .prepare(
        `SELECT schema_name AS schemaName, schema_version AS schemaVersion,
                schema_digest AS schemaDigest, app_version AS appVersion
         FROM schema_meta WHERE id = 1`,
      )
      .get();
    if (
      !isSchemaMetaRow(row) ||
      row.schemaName !== STATE_SCHEMA_NAME ||
      row.schemaVersion !== STATE_SCHEMA_VERSION ||
      !row.schemaDigest.equals(STATE_SCHEMA_DIGEST) ||
      row.appVersion !== STATE_APP_VERSION
    ) {
      throw new Error(RESET_INSTRUCTION);
    }
    if (schemaShape(this.connection) !== expectedSchemaShape()) {
      throw new Error(RESET_INSTRUCTION);
    }
  }
}

function expectedSchemaShape(): string {
  if (expectedShape !== undefined) {
    return expectedShape;
  }
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

function assertNoLegacyState(databasePath: string, homeDir: string): void {
  const root = path.dirname(databasePath);
  const legacy = [
    path.join(root, "runs"),
    path.join(root, "decisions"),
    path.join(root, "controllers"),
  ];
  const telegramState = path.join(homeDir, ".config", "pi-workflows", "telegram-state.sqlite");
  if (legacy.some((candidate) => fs.existsSync(candidate)) || fs.existsSync(telegramState)) {
    throw new Error(RESET_INSTRUCTION);
  }
}

function isSchemaObjectRow(value: unknown): value is SchemaObjectRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === "string" &&
    typeof value.name === "string" &&
    typeof value.tableName === "string" &&
    typeof value.sql === "string"
  );
}

function isSchemaMetaRow(value: unknown): value is SchemaMetaRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.schemaName === "string" &&
    typeof value.schemaVersion === "number" &&
    Buffer.isBuffer(value.schemaDigest) &&
    typeof value.appVersion === "string"
  );
}

function isBlobRow(value: unknown): value is BlobRow {
  if (!isRecord(value)) return false;
  return (
    Buffer.isBuffer(value.blobHash) &&
    typeof value.mediaType === "string" &&
    typeof value.byteLength === "number" &&
    Buffer.isBuffer(value.content)
  );
}

function isTableNameRow(value: unknown): value is { name: string } {
  return isRecord(value) && typeof value.name === "string";
}

function isColumnNameRow(value: unknown): value is { columnName: string } {
  return isRecord(value) && typeof value.columnName === "string";
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
