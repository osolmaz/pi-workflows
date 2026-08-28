import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { StateDatabase } from "../src/state/database.js";
import { PRE_VIEWER_STATE_SCHEMA_DIGEST } from "../src/state/schema.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { upgradePreViewerStateDatabase } from "../src/workflows/state-upgrade.js";
import {
  SESSION_BINDING_SCHEMA,
  SESSION_CAPTURE_SCHEMA,
  SESSION_EVENT_SCHEMA,
  WorkflowRunStore,
} from "../src/workflows/store.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";

const OLD_SESSION_SCHEMA_SQL = String.raw`
CREATE TEMP TABLE state_test_session_entries AS
SELECT segment_id, entry_seq, entry_id, entry_hash, recorded_at FROM session_entries;
DROP TABLE session_entries;
CREATE TABLE session_entries (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  entry_seq INTEGER NOT NULL CHECK (entry_seq > 0),
  entry_id TEXT NOT NULL,
  entry_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, entry_seq),
  UNIQUE (segment_id, entry_id)
) STRICT;
INSERT INTO session_entries(segment_id, entry_seq, entry_id, entry_hash, recorded_at)
SELECT segment_id, entry_seq, entry_id, entry_hash, recorded_at
FROM state_test_session_entries;
DROP TABLE state_test_session_entries;

CREATE TEMP TABLE state_test_session_events AS
SELECT segment_id, event_seq, event_type, node_id, attempt_id, turn_id,
       message_id, tool_call_id, payload_hash, recorded_at FROM session_events;
DROP TABLE session_events;
CREATE TABLE session_events (
  segment_id TEXT NOT NULL REFERENCES session_segments(segment_id) ON DELETE CASCADE,
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  event_type TEXT NOT NULL,
  node_id TEXT,
  attempt_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  tool_call_id TEXT,
  payload_hash BLOB NOT NULL REFERENCES blobs(blob_hash),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, event_seq)
) STRICT;
INSERT INTO session_events(
  segment_id, event_seq, event_type, node_id, attempt_id, turn_id,
  message_id, tool_call_id, payload_hash, recorded_at
)
SELECT segment_id, event_seq, event_type, node_id, attempt_id, turn_id,
       message_id, tool_call_id, payload_hash, recorded_at
FROM state_test_session_events;
DROP TABLE state_test_session_events;
`;

async function makePreViewerDatabase(label: string): Promise<string> {
  const databasePath = await makeStateDatabasePath(label);
  const result = await new WorkflowEngine({
    databasePath,
    executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
  }).run(workflow, { task: "preserve" });
  const attemptId = result.state.steps[0]?.attemptId;
  if (attemptId === undefined) throw new Error("test workflow attempt is missing");
  const store = new WorkflowRunStore(databasePath);
  const binding = {
    schema: SESSION_BINDING_SCHEMA,
    runId: result.runId,
    piSessionId: "preserved-session",
    cwd: "/tmp/preserved-project",
    boundAt: "2026-08-28T00:00:00.000Z",
  } as const;
  await store.writeSessionBinding(result.runId, binding);
  await store.appendSessionEntry(result.runId, { id: "preserved-entry", type: "message" });
  await store.appendSessionEventBatch(
    result.runId,
    Array.from({ length: 300 }, (_, index) => ({
      seq: index + 1,
      at: new Date(Date.parse("2026-08-28T00:00:01.000Z") + index).toISOString(),
      nodeId: "reply",
      attemptId,
      turnId: `turn-${index + 1}`,
      type: "turn_started" as const,
      payload: { turnIndex: index + 1 },
    })),
  );
  await store.writeSessionCapture(result.runId, {
    schema: SESSION_CAPTURE_SCHEMA,
    eventSchema: SESSION_EVENT_SCHEMA,
    status: "complete",
    eventCount: 300,
    entryCount: 1,
    lastEventSeq: 300,
  });
  await store.writeSessionBinding(
    result.runId,
    {
      ...binding,
      piSessionId: "preserved-attempt-session",
      boundAt: "2026-08-28T00:00:02.000Z",
    },
    attemptId,
  );
  await store.appendSessionEntry(
    result.runId,
    { id: "preserved-attempt-entry", type: "message" },
    attemptId,
  );
  await store.appendSessionEventBatch(
    result.runId,
    [
      {
        seq: 1,
        at: "2026-08-28T00:00:03.000Z",
        nodeId: "reply",
        attemptId,
        turnId: "attempt-turn",
        type: "turn_finished",
        payload: { turnIndex: 301 },
      },
    ],
    attemptId,
  );
  await store.writeSessionCapture(
    result.runId,
    {
      schema: SESSION_CAPTURE_SCHEMA,
      eventSchema: SESSION_EVENT_SCHEMA,
      status: "complete",
      eventCount: 1,
      entryCount: 1,
      lastEventSeq: 1,
    },
    attemptId,
  );
  store.state.connection
    .prepare(
      `INSERT INTO attempt_entries(attempt_id, role, segment_id, entry_id)
       SELECT ?, 'prompt', segment_id, 'preserved-attempt-entry'
       FROM session_entries WHERE entry_id = 'preserved-attempt-entry'`,
    )
    .run(attemptId);
  store.close();

  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = OFF");
    database.exec("BEGIN EXCLUSIVE");
    database.exec(
      "DROP TABLE viewer_session_checkpoints; DROP TABLE viewer_deltas; DROP TABLE viewer_runs;",
    );
    database.exec(OLD_SESSION_SCHEMA_SQL);
    database
      .prepare("UPDATE schema_meta SET schema_digest = ? WHERE id = 1")
      .run(PRE_VIEWER_STATE_SCHEMA_DIGEST);
    database.exec("COMMIT");
    database.pragma("foreign_keys = ON");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  } finally {
    database.close();
  }
  return databasePath;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("pre-viewer state upgrade", () => {
  it("preserves runs and session rows while backfilling bounded viewer state", async () => {
    const databasePath = await makePreViewerDatabase("state-upgrade");
    const backupPath = path.join(path.dirname(databasePath), "state-before-viewer.sqlite");

    expect(() => new StateDatabase({ filePath: databasePath, mode: "read-only" })).toThrow(
      /state upgrade/,
    );
    const report = upgradePreViewerStateDatabase(databasePath, backupPath);

    expect(report).toMatchObject({
      backupPath,
      runs: 1,
      sessionEntries: 2,
      sessionEvents: 301,
      replayCheckpoints: 1,
    });
    expect(report.backupSha256).toBe(sha256(backupPath));
    const state = new StateDatabase({ filePath: databasePath, mode: "read-only" });
    try {
      state.integrityCheck();
      expect(
        state.connection
          .prepare(
            `SELECT presentation_revision AS presentationRevision,
                    retained_from_revision AS retainedFromRevision
             FROM viewer_runs`,
          )
          .all(),
      ).toEqual([{ presentationRevision: 1, retainedFromRevision: 1 }]);
      expect(
        state.connection
          .prepare("SELECT min(run_seq) AS first, max(run_seq) AS last FROM session_events")
          .get(),
      ).toEqual({ first: 1, last: 301 });
      expect(
        state.connection
          .prepare("SELECT event_seq AS eventSeq FROM viewer_session_checkpoints")
          .all(),
      ).toEqual([{ eventSeq: 256 }]);
      expect(
        state.connection
          .prepare("SELECT entry_id AS entryId FROM attempt_entries WHERE role = 'prompt'")
          .all(),
      ).toEqual([{ entryId: "preserved-attempt-entry" }]);
      expect(state.connection.prepare("SELECT count(*) AS count FROM viewer_deltas").get()).toEqual(
        {
          count: 0,
        },
      );
    } finally {
      state.close();
    }
    expect(() =>
      upgradePreViewerStateDatabase(
        databasePath,
        path.join(path.dirname(databasePath), "second-backup.sqlite"),
      ),
    ).toThrow(/already uses/);
    await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "after upgrade" } }),
    }).run(workflow, { task: "after upgrade" });
    const reopened = new StateDatabase({ filePath: databasePath, mode: "read-only" });
    try {
      expect(reopened.connection.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({
        count: 2,
      });
      expect(
        reopened.connection.prepare("SELECT count(*) AS count FROM viewer_runs").get(),
      ).toEqual({ count: 2 });
    } finally {
      reopened.close();
    }

    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 1 });
      expect(backup.prepare("SELECT count(*) AS count FROM session_events").get()).toEqual({
        count: 301,
      });
      expect(
        backup.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'viewer_runs'").get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
  });

  it("refuses active writers before creating a backup", async () => {
    const databasePath = await makePreViewerDatabase("state-upgrade-active");
    const backupPath = path.join(path.dirname(databasePath), "state-before-viewer.sqlite");
    const database = new Database(databasePath);
    try {
      database
        .prepare(
          `UPDATE leases SET generation = generation + 1, owner_type = 'host', owner_id = 'active',
             token_hash = zeroblob(32), acquired_at = ?, heartbeat_at = ?, expires_at = ?
           WHERE resource_id = (SELECT resource_id FROM runs LIMIT 1)`,
        )
        .run(Date.now(), Date.now(), Date.now() + 60_000);
    } finally {
      database.close();
    }

    expect(() => upgradePreViewerStateDatabase(databasePath, backupPath)).toThrow(
      /Stop all active/,
    );
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("rolls back a failed backfill and keeps its verified backup", async () => {
    const databasePath = await makePreViewerDatabase("state-upgrade-rollback");
    const backupPath = path.join(path.dirname(databasePath), "state-before-viewer.sqlite");
    const database = new Database(databasePath);
    try {
      database
        .prepare("UPDATE session_events SET event_type = 'unsupported' WHERE rowid = 1")
        .run();
    } finally {
      database.close();
    }

    expect(() => upgradePreViewerStateDatabase(databasePath, backupPath)).toThrow(/unknown/);
    expect(fs.existsSync(backupPath)).toBe(true);
    const rolledBack = new Database(databasePath, { readonly: true });
    try {
      expect(
        rolledBack.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'viewer_runs'").get(),
      ).toBeUndefined();
      expect(
        rolledBack
          .prepare("SELECT hex(schema_digest) AS digest FROM schema_meta WHERE id = 1")
          .get(),
      ).toEqual({ digest: PRE_VIEWER_STATE_SCHEMA_DIGEST.toString("hex").toUpperCase() });
    } finally {
      rolledBack.close();
    }
  });

  it("rejects an unsupported source shape before creating a backup", async () => {
    const databasePath = await makePreViewerDatabase("state-upgrade-shape");
    const backupPath = path.join(path.dirname(databasePath), "state-before-viewer.sqlite");
    const database = new Database(databasePath);
    try {
      database.exec("CREATE TABLE unsupported_state(value TEXT) STRICT;");
    } finally {
      database.close();
    }

    expect(() => upgradePreViewerStateDatabase(databasePath, backupPath)).toThrow(
      /exact supported/,
    );
    expect(fs.existsSync(backupPath)).toBe(false);
    const rolledBack = new Database(databasePath, { readonly: true });
    try {
      expect(
        rolledBack.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'viewer_runs'").get(),
      ).toBeUndefined();
    } finally {
      rolledBack.close();
    }
  });
});
