import { StateDatabase } from "./database.js";
import { canonicalJson, parseJson, type JsonValue } from "./json.js";

export const VIEWER_DELTA_RETENTION = 256;
export const VIEWER_PAGE_SIZE = 256;

export type ViewerTargetType =
  | "summary"
  | "graph"
  | "replay"
  | "timeline"
  | "conversation"
  | "inspector";

export type ViewerPatchOperation =
  | { op: "add" | "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "append"; path: string; value: JsonValue[] };

export type ViewerDeltaDraft = {
  targetType: ViewerTargetType;
  targetKey?: string;
  patch?: ViewerPatchOperation[];
};

export type ViewerTailItem = JsonValue;

export type ViewerDeltaRecord = {
  runId: string;
  presentationRevision: number;
  deltaIndex: number;
  targetType: ViewerTargetType;
  targetKey: string;
  patch: ViewerPatchOperation[];
  recordedAt: number;
};

export type ViewerCursorResult =
  | {
      kind: "deltas";
      currentRevision: number;
      retainedFromRevision: number;
      deltas: ViewerDeltaRecord[];
    }
  | {
      kind: "snapshot_required";
      currentRevision: number;
      retainedFromRevision: number;
    };

type ViewerRunRow = {
  presentationRevision: number;
  retainedFromRevision: number;
};

type ViewerDeltaRow = {
  runId: string;
  presentationRevision: number;
  deltaIndex: number;
  targetType: string;
  targetKey: string;
  patchHash: Buffer;
  recordedAt: number;
};

export function initializeViewerRun(state: StateDatabase, runId: string, now: number): number {
  state.connection
    .prepare(
      `INSERT INTO viewer_runs(
         run_id, presentation_revision, retained_from_revision, updated_at
       ) VALUES (?, 1, 1, ?)
       ON CONFLICT(run_id) DO NOTHING`,
    )
    .run(runId, now);
  const row = state.connection
    .prepare(
      `SELECT presentation_revision AS presentationRevision,
              retained_from_revision AS retainedFromRevision
       FROM viewer_runs WHERE run_id = ?`,
    )
    .get(runId);
  if (!isViewerRunRow(row)) {
    throw new Error(`Viewer projection could not be initialized for workflow run: ${runId}`);
  }
  return row.presentationRevision;
}

export function recordViewerDeltas(
  state: StateDatabase,
  runId: string,
  drafts: readonly ViewerDeltaDraft[],
  now: number = Date.now(),
): number {
  if (!state.connection.inTransaction) {
    throw new Error("Viewer changes must be recorded inside the durable state transaction");
  }
  if (drafts.length === 0) {
    throw new Error("Viewer change must name at least one bounded target");
  }
  const row = state.connection
    .prepare(
      `SELECT presentation_revision AS presentationRevision,
              retained_from_revision AS retainedFromRevision
       FROM viewer_runs WHERE run_id = ?`,
    )
    .get(runId);
  if (!isViewerRunRow(row)) {
    throw new Error(`Viewer projection does not exist for workflow run: ${runId}`);
  }
  const revision = row.presentationRevision + 1;
  for (const [index, draft] of drafts.entries()) {
    const patch: ViewerPatchOperation[] = [
      {
        op: "replace",
        path: "/presentationRevision",
        value: revision,
      },
      ...(draft.patch ?? []),
    ];
    const patchHash = state.putJson(patch, now);
    state.connection
      .prepare(
        `INSERT INTO viewer_deltas(
           run_id, presentation_revision, delta_index, target_type,
           target_key, patch_hash, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, revision, index, draft.targetType, draft.targetKey ?? "", patchHash, now);
  }
  const retainedFromRevision = Math.max(1, revision - VIEWER_DELTA_RETENTION + 1);
  const update = state.connection
    .prepare(
      `UPDATE viewer_runs
       SET presentation_revision = ?, retained_from_revision = ?, updated_at = ?
       WHERE run_id = ? AND presentation_revision = ?`,
    )
    .run(revision, retainedFromRevision, now, runId, row.presentationRevision);
  if (update.changes !== 1) {
    throw new Error(`Viewer projection revision conflict for workflow run: ${runId}`);
  }
  state.connection
    .prepare(
      `DELETE FROM viewer_deltas
       WHERE run_id = ? AND presentation_revision < ?`,
    )
    .run(runId, retainedFromRevision);
  return revision;
}

export function viewerTailPatch(
  oldTotal: number,
  items: readonly ViewerTailItem[],
): ViewerPatchOperation[] {
  if (!Number.isInteger(oldTotal) || oldTotal < 0) {
    throw new Error("Viewer page total must be a non-negative integer");
  }
  if (items.length === 0) return [];
  const nextTotal = oldTotal + items.length;
  const previousStart = Math.max(0, oldTotal - VIEWER_PAGE_SIZE);
  const nextStart = Math.max(0, nextTotal - VIEWER_PAGE_SIZE);
  const patch: ViewerPatchOperation[] = [];
  if (items.length >= VIEWER_PAGE_SIZE) {
    patch.push({
      op: "replace",
      path: "/items",
      value: items.slice(-VIEWER_PAGE_SIZE),
    });
  } else {
    const retainedBefore = oldTotal - previousStart;
    const removed = Math.min(nextStart - previousStart, retainedBefore);
    for (let index = 0; index < removed; index += 1) {
      patch.push({ op: "remove", path: "/items/0" });
    }
    patch.push({ op: "append", path: "/items", value: [...items] });
  }
  if (nextStart !== previousStart) {
    patch.push({ op: "replace", path: "/start", value: nextStart });
  }
  patch.push({ op: "replace", path: "/total", value: nextTotal });
  return patch;
}

export function readViewerDeltas(
  state: StateDatabase,
  runId: string,
  afterRevision: number,
): ViewerCursorResult {
  if (!Number.isInteger(afterRevision) || afterRevision < 0) {
    throw new Error("Viewer cursor must be a non-negative integer");
  }
  const row = state.connection
    .prepare(
      `SELECT presentation_revision AS presentationRevision,
              retained_from_revision AS retainedFromRevision
       FROM viewer_runs WHERE run_id = ?`,
    )
    .get(runId);
  if (!isViewerRunRow(row)) {
    throw new Error(`Viewer projection does not exist for workflow run: ${runId}`);
  }
  if (
    afterRevision === 0 ||
    afterRevision > row.presentationRevision ||
    afterRevision < row.retainedFromRevision - 1
  ) {
    return {
      kind: "snapshot_required",
      currentRevision: row.presentationRevision,
      retainedFromRevision: row.retainedFromRevision,
    };
  }
  const rows = state.connection
    .prepare(
      `SELECT run_id AS runId, presentation_revision AS presentationRevision,
              delta_index AS deltaIndex, target_type AS targetType,
              target_key AS targetKey, patch_hash AS patchHash,
              recorded_at AS recordedAt
       FROM viewer_deltas
       WHERE run_id = ? AND presentation_revision > ?
       ORDER BY presentation_revision, delta_index`,
    )
    .all(runId, afterRevision);
  const deltas: ViewerDeltaRecord[] = [];
  for (const value of rows) {
    if (!isViewerDeltaRow(value) || !isViewerTargetType(value.targetType)) {
      throw new Error("Viewer delta row is invalid");
    }
    deltas.push({
      runId: value.runId,
      presentationRevision: value.presentationRevision,
      deltaIndex: value.deltaIndex,
      targetType: value.targetType,
      targetKey: value.targetKey,
      patch: parsePatch(state.readJson(value.patchHash)),
      recordedAt: value.recordedAt,
    });
  }
  const revisions = [...new Set(deltas.map((delta) => delta.presentationRevision))];
  const expectedCount = row.presentationRevision - afterRevision;
  if (
    revisions.length !== expectedCount ||
    revisions.some((revision, index) => revision !== afterRevision + index + 1)
  ) {
    return {
      kind: "snapshot_required",
      currentRevision: row.presentationRevision,
      retainedFromRevision: row.retainedFromRevision,
    };
  }
  return {
    kind: "deltas",
    currentRevision: row.presentationRevision,
    retainedFromRevision: row.retainedFromRevision,
    deltas,
  };
}

function parsePatch(value: JsonValue): ViewerPatchOperation[] {
  if (!Array.isArray(value)) throw new Error("Viewer delta patch is not an array");
  const operations: ViewerPatchOperation[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.op !== "string" || typeof item.path !== "string") {
      throw new Error("Viewer delta patch operation is invalid");
    }
    if (item.op === "remove") {
      operations.push({ op: "remove", path: item.path });
      continue;
    }
    if ((item.op === "add" || item.op === "replace") && "value" in item) {
      operations.push({
        op: item.op,
        path: item.path,
        value: parseJson(canonicalJson(item.value)),
      });
      continue;
    }
    if (item.op === "append" && Array.isArray(item.value)) {
      operations.push({
        op: "append",
        path: item.path,
        value: item.value.map((entry) => parseJson(canonicalJson(entry))),
      });
      continue;
    }
    throw new Error("Viewer delta patch operation is unsupported");
  }
  return operations;
}

function isViewerRunRow(value: unknown): value is ViewerRunRow {
  return (
    isRecord(value) &&
    typeof value.presentationRevision === "number" &&
    typeof value.retainedFromRevision === "number"
  );
}

function isViewerDeltaRow(value: unknown): value is ViewerDeltaRow {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.presentationRevision === "number" &&
    typeof value.deltaIndex === "number" &&
    typeof value.targetType === "string" &&
    typeof value.targetKey === "string" &&
    Buffer.isBuffer(value.patchHash) &&
    typeof value.recordedAt === "number"
  );
}

function isViewerTargetType(value: string): value is ViewerTargetType {
  return ["summary", "graph", "replay", "timeline", "conversation", "inspector"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
