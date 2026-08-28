import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { resourceIdFor } from "../src/state/mutation.js";
import { initializeViewerRun } from "../src/state/viewer.js";

const output = path.resolve(process.argv[2] ?? "viewer-benchmark.sqlite");
const runCount = positiveInteger(process.argv[3], 44);
const traceCount = positiveInteger(process.argv[4], 405);
const entryCount = positiveInteger(process.argv[5], 211);
const eventCount = positiveInteger(process.argv[6], 1_105);
const payloadBytes = positiveInteger(process.argv[7], 512);

fs.rmSync(output, { force: true });
const state = new StateDatabase({ filePath: output, checkLegacyState: false });
const snapshot = {
  schema: "pi-workflows.definition-snapshot.v1",
  name: "synthetic-viewer-benchmark",
  startAt: "work",
  nodes: { work: { nodeType: "compute" } },
  edges: [],
};
const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest();
const now = Date.now();
state.transaction(() => {
  const definitionHash = state.putJson(snapshot, now);
  state.connection
    .prepare(
      `INSERT INTO workflow_definitions(
         definition_digest, workflow_name, definition_hash, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(definitionDigest, snapshot.name, definitionHash, now);
});

for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
  const runId = `synthetic-${runIndex.toString().padStart(4, "0")}`;
  state.transaction(() => {
    const createdAt = now + runIndex;
    const runResourceId = resourceIdFor("run", runId);
    const inputHash = state.putJson({ runIndex }, createdAt);
    const launchHash = state.putJson({}, createdAt);
    state.connection
      .prepare(
        `INSERT INTO resources(
           resource_id, resource_type, aggregate_key, revision, created_at, updated_at
         ) VALUES (?, 'run', ?, ?, ?, ?)`,
      )
      .run(runResourceId, runId, traceCount, createdAt, createdAt);
    state.connection
      .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
      .run(runResourceId);
    state.connection
      .prepare(
        `INSERT INTO runs(
           run_id, resource_id, definition_digest, workflow_ref, launch_options_hash,
           status, paused, input_hash, created_at, updated_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        runResourceId,
        definitionDigest,
        snapshot.name,
        launchHash,
        inputHash,
        createdAt,
        createdAt,
        createdAt,
      );
    initializeViewerRun(state, runId, createdAt);
    state.connection
      .prepare(
        `INSERT INTO run_sources(
           run_id, mount_path, source_type, source_ref, source_revision
         ) VALUES (?, '', 'file', ?, 'synthetic')`,
      )
      .run(runId, `inline:${snapshot.name}`);

    for (let sequence = 1; sequence <= traceCount; sequence += 1) {
      const payloadHash = state.putJson(
        syntheticPayload(runIndex, sequence, payloadBytes),
        createdAt + sequence,
      );
      state.connection
        .prepare(
          `INSERT INTO events(
             event_id, resource_id, resource_revision, event_type, actor_type,
             payload_hash, recorded_at
           ) VALUES (?, ?, ?, 'synthetic', 'system', ?, ?)`,
        )
        .run(
          `event-${runIndex}-${sequence}`,
          runResourceId,
          sequence,
          payloadHash,
          createdAt + sequence,
        );
    }

    const segmentId = `segment-${runIndex}`;
    const sessionResourceId = resourceIdFor("session", segmentId);
    state.connection
      .prepare(
        `INSERT INTO resources(
           resource_id, resource_type, aggregate_key, revision, created_at, updated_at
         ) VALUES (?, 'session', ?, 1, ?, ?)`,
      )
      .run(sessionResourceId, segmentId, createdAt, createdAt);
    state.connection
      .prepare("INSERT INTO leases(resource_id, generation) VALUES (?, 0)")
      .run(sessionResourceId);
    state.connection
      .prepare(
        `INSERT INTO session_segments(
           segment_id, run_id, capture_key, session_id, resource_id, status,
           entry_count, event_count, created_at, finished_at
         ) VALUES (?, ?, NULL, ?, ?, 'complete', ?, ?, ?, ?)`,
      )
      .run(
        segmentId,
        runId,
        `session-${runIndex}`,
        sessionResourceId,
        entryCount,
        eventCount,
        createdAt,
        createdAt,
      );
    for (let sequence = 1; sequence <= entryCount; sequence += 1) {
      const entryHash = state.putJson(
        {
          id: `entry-${runIndex}-${sequence}`,
          type: "message",
          content: syntheticPayload(runIndex, sequence, payloadBytes),
        },
        createdAt + sequence,
      );
      state.connection
        .prepare(
          `INSERT INTO session_entries(
             segment_id, run_id, entry_seq, run_seq, entry_id, entry_hash, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          segmentId,
          runId,
          sequence,
          sequence,
          `entry-${runIndex}-${sequence}`,
          entryHash,
          createdAt + sequence,
        );
    }
    for (let sequence = 1; sequence <= eventCount; sequence += 1) {
      const payloadHash = state.putJson(
        syntheticPayload(runIndex, sequence, payloadBytes),
        createdAt + sequence,
      );
      state.connection
        .prepare(
          `INSERT INTO session_events(
             segment_id, run_id, event_seq, run_seq, event_type, node_id,
             attempt_id, payload_hash, recorded_at
           ) VALUES (?, ?, ?, ?, 'synthetic', 'work', '', ?, ?)`,
        )
        .run(segmentId, runId, sequence, sequence, payloadHash, createdAt + sequence);
    }
  });
}
state.close();

const size = fs.statSync(output).size;
console.log(
  JSON.stringify({
    schema: "pi-workflows.viewer-benchmark-fixture.v1",
    databaseBytes: size,
    runCount,
    traceRows: runCount * traceCount,
    sessionEntryRows: runCount * entryCount,
    sessionEventRows: runCount * eventCount,
    payloadBytes,
  }),
);

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function syntheticPayload(runIndex: number, sequence: number, bytes: number): object {
  return {
    runIndex,
    sequence,
    text: "x".repeat(bytes),
  };
}
