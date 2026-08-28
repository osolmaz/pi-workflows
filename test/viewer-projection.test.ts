import { describe, expect, it } from "vitest";
import workflow from "../examples/workflows/echo.workflow.js";
import { StateDatabase } from "../src/state/database.js";
import {
  VIEWER_DELTA_RETENTION,
  VIEWER_PAGE_SIZE,
  readViewerDeltas,
  recordViewerDeltas,
  viewerTailPatch,
} from "../src/state/viewer.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";

describe("revisioned viewer projection", () => {
  it("records ordered bounded target patches without reconstructing a run view", async () => {
    const databasePath = await makeStateDatabasePath("viewer-deltas");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, { task: "reply" });
    const state = new StateDatabase({ filePath: databasePath });
    const before = state.connection
      .prepare("SELECT presentation_revision AS revision FROM viewer_runs WHERE run_id = ?")
      .get(result.runId);
    expect(before).toEqual({ revision: expect.any(Number) });
    const revision = state.transaction(() =>
      recordViewerDeltas(state, result.runId, [
        {
          targetType: "graph",
          patch: [{ op: "replace", path: "/state/status", value: "completed" }],
        },
        {
          targetType: "conversation",
          targetKey: "entries:tail",
          patch: viewerTailPatch(0, [{ seq: 1, entry: { type: "message" } }]),
        },
      ]),
    );

    expect(readViewerDeltas(state, result.runId, 0).kind).toBe("snapshot_required");
    const resultFromCursor = readViewerDeltas(state, result.runId, revision - 1);
    expect(resultFromCursor.kind).toBe("deltas");
    if (resultFromCursor.kind === "deltas") {
      expect(resultFromCursor.currentRevision).toBe(revision);
      expect(resultFromCursor.deltas).toHaveLength(2);
      expect(resultFromCursor.deltas.map((delta) => delta.deltaIndex)).toEqual([0, 1]);
      expect(resultFromCursor.deltas[0]?.patch).toEqual([
        { op: "replace", path: "/presentationRevision", value: revision },
        { op: "replace", path: "/graphRevision", value: revision },
        { op: "replace", path: "/state/status", value: "completed" },
      ]);
    }
    state.close();
  });

  it("emits direct bounded patches for ordinary workflow changes", async () => {
    const databasePath = await makeStateDatabasePath("viewer-direct-run-update");
    const result = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, { task: "reply" });
    const state = new StateDatabase({ filePath: databasePath });
    const row = state.connection
      .prepare("SELECT presentation_revision AS revision FROM viewer_runs WHERE run_id = ?")
      .get(result.runId);
    if (
      typeof row !== "object" ||
      row === null ||
      !("revision" in row) ||
      typeof row.revision !== "number"
    ) {
      throw new Error("Viewer revision row is invalid");
    }
    const latest = readViewerDeltas(state, result.runId, row.revision - 1);
    const history = readViewerDeltas(state, result.runId, 1);
    expect(latest.kind).toBe("deltas");
    expect(history.kind).toBe("deltas");
    if (latest.kind === "deltas") {
      const graph = latest.deltas.find((delta) => delta.targetType === "graph");
      const timeline = latest.deltas.find((delta) => delta.targetType === "timeline");
      expect(graph?.patch).toContainEqual({
        op: "replace",
        path: "/state/status",
        value: "completed",
      });
      if (history.kind === "deltas") {
        expect(history.deltas).toContainEqual(
          expect.objectContaining({ targetType: "replay", targetKey: "steps:reload" }),
        );
      }
      expect(graph?.patch).toContainEqual(
        expect.objectContaining({ op: "add", path: "/state/updates" }),
      );
      expect(timeline?.patch).toContainEqual(
        expect.objectContaining({ op: "append", path: "/items" }),
      );
      const append = timeline?.patch.find(
        (operation) => operation.op === "append" && operation.path === "/items",
      );
      const eventRow = state.connection
        .prepare(
          `SELECT e.payload_hash AS payloadHash
           FROM events e JOIN runs r ON r.resource_id = e.resource_id
           WHERE r.run_id = ? ORDER BY e.resource_revision DESC LIMIT 1`,
        )
        .get(result.runId);
      if (
        append?.op !== "append" ||
        typeof append.value[0] !== "object" ||
        append.value[0] === null ||
        Array.isArray(append.value[0]) ||
        typeof eventRow !== "object" ||
        eventRow === null ||
        !("payloadHash" in eventRow) ||
        !Buffer.isBuffer(eventRow.payloadHash)
      ) {
        throw new Error("Viewer trace patch evidence is invalid");
      }
      const storedEvent = state.readJson(eventRow.payloadHash);
      if (typeof storedEvent !== "object" || storedEvent === null || Array.isArray(storedEvent)) {
        throw new Error("Stored trace event is invalid");
      }
      expect(append.value[0].payload).toEqual(storedEvent.payload);
      expect(latest.deltas.every((delta) => delta.patch.length > 1)).toBe(true);
    }
    state.close();
  });

  it("requires a bounded snapshot after the retained revision window", async () => {
    const databasePath = await makeStateDatabasePath("viewer-retention");
    const run = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, { task: "reply" });
    const state = new StateDatabase({ filePath: databasePath });
    for (let index = 0; index < VIEWER_DELTA_RETENTION + 2; index += 1) {
      state.transaction(() =>
        recordViewerDeltas(state, run.runId, [
          {
            targetType: "summary",
            patch: [{ op: "replace", path: "/tick", value: index }],
          },
        ]),
      );
    }
    const stale = readViewerDeltas(state, run.runId, 1);
    expect(stale.kind).toBe("snapshot_required");
    state.close();
  });

  it("keeps a tail page bounded while preserving append operations", () => {
    const full = Array.from({ length: VIEWER_PAGE_SIZE }, (_, index) => index);
    const shifted = viewerTailPatch(VIEWER_PAGE_SIZE, [VIEWER_PAGE_SIZE]);
    expect(shifted[0]).toEqual({ op: "remove", path: "/items/0" });
    expect(shifted).toContainEqual({
      op: "append",
      path: "/items",
      value: [VIEWER_PAGE_SIZE],
    });
    expect(shifted).toContainEqual({ op: "replace", path: "/start", value: 1 });
    expect(shifted).toContainEqual({
      op: "replace",
      path: "/total",
      value: VIEWER_PAGE_SIZE + 1,
    });

    const replacement = viewerTailPatch(10, [...full, VIEWER_PAGE_SIZE]);
    const items = replacement.find(
      (operation) => operation.op === "replace" && operation.path === "/items",
    );
    expect(items).toEqual({
      op: "replace",
      path: "/items",
      value: [...full, VIEWER_PAGE_SIZE].slice(-VIEWER_PAGE_SIZE),
    });
  });
});
