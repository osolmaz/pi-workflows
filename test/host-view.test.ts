import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { ORIGIN_ACTIVITY_LEASE_MS } from "../src/client/activity.js";
import {
  CLIENT_PROTOCOL_SCHEMA,
  MAX_PROTOCOL_MESSAGE_BYTES,
  encodeProtocolLine,
} from "../src/client/protocol.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { HostStateStore } from "../src/host/state.js";
import {
  HostViewStore,
  reduceWorkflowDisplay,
  workflowPageStart,
  type WorkflowDisplayFacts,
} from "../src/host/view.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const base: WorkflowDisplayFacts = {
  queueStatus: "parked",
  durableStatus: "waiting",
  paused: false,
  ambiguous: false,
  workerActive: false,
  originTurnActive: false,
  pendingInteraction: true,
  errorMessage: null,
};

function display(changes: Partial<WorkflowDisplayFacts>) {
  return reduceWorkflowDisplay({ ...base, ...changes });
}

describe("host workflow display reducer", () => {
  it("applies the documented status precedence", () => {
    expect(
      display({
        ambiguous: true,
        durableStatus: "completed",
        paused: true,
        workerActive: true,
      }).status,
    ).toBe("ambiguous");
    expect(display({ durableStatus: "failed", paused: true, workerActive: true }).status).toBe(
      "failed",
    );
    expect(display({ paused: true, workerActive: true }).status).toBe("paused");
    expect(display({ workerActive: true }).status).toBe("running");
    expect(display({ originTurnActive: true }).status).toBe("running");
    expect(display({}).status).toBe("waiting");
    expect(
      display({ durableStatus: "running", pendingInteraction: false, queueStatus: "parked" })
        .status,
    ).toBe("queued");
    expect(
      display({ durableStatus: "running", pendingInteraction: false, queueStatus: "queued" })
        .status,
    ).toBe("queued");
  });

  it("reports exact activity and allowed controls", () => {
    expect(display({ workerActive: true })).toMatchObject({
      status: "running",
      activity: "supervised_worker",
      controls: ["pause", "cancel"],
    });
    expect(display({ originTurnActive: true })).toMatchObject({
      status: "running",
      activity: "origin_turn",
    });
    expect(display({ paused: true })).toMatchObject({
      status: "paused",
      activity: null,
      controls: ["resume", "cancel"],
    });
    expect(display({ ambiguous: true })).toMatchObject({
      controls: ["review"],
    });
    expect(
      display({ durableStatus: "running", pendingInteraction: false, queueStatus: "queued" })
        .controls,
    ).toEqual(["cancel"]);
  });

  it("keeps every large history reachable through bounded pages", () => {
    expect(workflowPageStart(300)).toBe(44);
    expect(workflowPageStart(300, 0)).toBe(0);
    expect(workflowPageStart(300, 150)).toBe(22);
    expect(workflowPageStart(300, 299)).toBe(44);
  });

  it("keeps large content and replay history reachable through bounded host views", async () => {
    const projectPath = await makeTempDir("host-view-large-project");
    const databasePath = path.join(await makeTempDir("host-view-large-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new SqliteControllerStore(databasePath, { state, projectPath });
    const hostState = new HostStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const largeInput = { task: "request ".repeat(300_000) };
    queue.enqueueWorkflowRun({
      runId: "run-large-view",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: largeInput,
      runnerId: "host-view",
      claimToken: "claim-large-view",
      leaseMs: 60_000,
      originSessionId: "session-large-view",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("run-large-view", "claim-large-view"),
    });
    expect(queue.getWorkflowRunView("missing-run")).toBeUndefined();
    expect(queue.findSessionReservationView("missing-session")).toBeUndefined();
    expect(queue.latestSessionWorkflowRunView("missing-session")).toBeUndefined();
    expect(runs.readRunViewCounts("missing-run")).toBeNull();
    expect(
      runs.readRunView("missing-run", {
        steps: { start: 0, limit: 1 },
        trace: { start: 0, limit: 1 },
        sessionEntries: { start: 0, limit: 1 },
        sessionEvents: { start: 0, limit: 1 },
        settings: { start: 0, limit: 1 },
        followUps: { start: 0, limit: 1 },
        updates: { start: 0, limit: 1 },
        graphCursor: 0,
      }),
    ).toBeNull();
    expect(runs.readContentBlob("missing-run", "0".repeat(64))).toBeUndefined();
    expect(runs.readContentBlob("run-large-view", "invalid")).toBeUndefined();
    const largeOutput = {
      text: "x".repeat(2 * 1024 * 1024),
      userArtifact: { $artifact: { path: "user-data", note: "not a host reference" } },
    };
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: largeOutput }),
    }).run(workflow, largeInput, { runId: "run-large-view" });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    await runs.writeSessionBinding("run-large-view", {
      schema: "pi-workflows.session-binding.v1",
      runId: "run-large-view",
      piSessionId: "session-large-view",
      cwd: projectPath,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    const events: WorkflowSessionEventRecord[] = Array.from({ length: 300 }, (_, index) => {
      const turn = Math.floor(index / 2);
      const started = index % 2 === 0;
      return {
        seq: index + 1,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
        nodeId: "reply",
        attemptId,
        turnId: `turn-${turn}`,
        type: started ? "turn_started" : "turn_finished",
        payload: started
          ? { turnIndex: turn }
          : { turnIndex: turn, messageId: `message-${turn}`, toolCallIds: [] },
      };
    });
    await runs.appendSessionEventBatch("run-large-view", events);

    const views = new HostViewStore(state, queue, hostState, runs, () => false);
    const legacyRead = vi.spyOn(runs, "readRun");
    const boundedRead = vi.spyOn(runs, "readRunView");
    const view = views.run("run-large-view");
    if (view === null) throw new Error("run view missing");
    expect(legacyRead).not.toHaveBeenCalled();
    expect(boundedRead).toHaveBeenCalledTimes(1);
    expect(boundedRead.mock.calls[0]?.[1]).toMatchObject({
      steps: { limit: 1 },
      sessionEvents: { limit: 256 },
    });
    expect(views.run("run-large-view")).toBe(view);
    expect(boundedRead).toHaveBeenCalledTimes(1);
    expect(
      views.page("run-large-view", { kind: "trace_at_step", cursor: 0 })?.tracePage,
    ).toMatchObject({ total: expect.any(Number), items: expect.any(Array) });
    expect(runs.traceCursorForStep("run-large-view", 99, 10)).toBe(9);
    const outputDigest = createHash("sha256").update(canonicalJson(largeOutput)).digest("hex");
    expect(runs.readContentBlob("run-large-view", outputDigest)).toMatchObject({
      mediaType: "application/json",
    });
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "event",
      subscriptionId: "large-view",
      event: "run_snapshot",
      revision: 1,
      runId: view.runId,
      payload: view as unknown as never,
    });
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PROTOCOL_MESSAGE_BYTES + 1);

    const stateView = view.state as { steps?: Array<{ output?: unknown }> };
    const artifact = stateView.steps?.[0]?.output as {
      $artifact?: { path?: string; bytes?: number; sha256?: string };
    };
    const contentPath = artifact.$artifact?.path;
    if (contentPath === undefined) throw new Error("large output was not externalized");
    expect(views.content(view.runId, "not-a-content-path", 0)).toBeNull();
    expect(() => views.content(view.runId, contentPath, -1)).toThrow(/offset/);
    const coldViews = new HostViewStore(state, queue, hostState, runs, () => false);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = coldViews.content(view.runId, contentPath, offset) as {
        data: string;
        nextOffset: number;
        complete: boolean;
      };
      chunks.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
      if (chunk.complete) break;
    }
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(largeOutput);

    const session = view.session as {
      eventPage?: { start?: number; items?: unknown[] };
      replayCheckpoint?: { throughSeq?: number } | null;
    };
    expect(session.eventPage?.items).toHaveLength(256);
    expect(session.eventPage?.start).toBeGreaterThan(0);
    expect(session.replayCheckpoint?.throughSeq).toBe(session.eventPage?.start);
    state.close();
  });

  it("keeps a terminal queue result correct before a run state is available", () => {
    expect(
      display({
        queueStatus: "done",
        durableStatus: undefined,
        pendingInteraction: false,
      }).status,
    ).toBe("completed");
  });

  it("binds origin activity to one connection and gives durable pause precedence", async () => {
    const projectPath = await makeTempDir("host-view-project");
    const databasePath = path.join(await makeTempDir("host-view-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new SqliteControllerStore(databasePath, { state, projectPath });
    const hostState = new HostStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    queue.enqueueWorkflowRun({
      runId: "run-view",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "host-view",
      claimToken: "claim-view",
      leaseMs: 60_000,
      originSessionId: "session-view",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("run-view", "claim-view"),
    });
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "done" } }),
    }).run(workflow, {}, { runId: "run-view" });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', paused = 0 WHERE run_id = ?")
      .run("run-view");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("run-view");
    const request = hostState.createInteractiveRequest({
      requestId: "request-view",
      runId: "run-view",
      attemptId,
      targetSessionId: "session-view",
      kind: "agent",
      contract: { prompt: "Continue" },
    });
    const claim = hostState.claimInteractionPresentation({
      requestId: request.requestId,
      expectedRevision: request.revision,
      presenterId: "extension-view",
      leaseMs: 60_000,
    });
    hostState.markInteractionPresented({
      requestId: request.requestId,
      expectedRevision: claim.revision,
      sessionEntryId: "entry-view",
    });
    const views = new HostViewStore(state, queue, hostState, runs, () => false);
    const readRun = vi.spyOn(runs, "readRun");
    const initialList = views.list();
    expect(initialList.items).toHaveLength(1);
    expect(readRun).not.toHaveBeenCalled();
    readRun.mockRestore();
    const activity = {
      sessionId: "session-view",
      runId: "run-view",
      requestId: "request-view",
      deliveryId: "interaction:request-view",
      sessionEntryId: "entry-view",
      sequence: 0,
      state: "started" as const,
    };

    expect(views.run("run-view")).toMatchObject({
      display: { status: "waiting" },
      manifest: {
        workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      },
      state: {
        workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      },
    });
    views.reportActivity("connection-one", activity);
    expect(views.run("run-view")?.display).toMatchObject({
      status: "running",
      activity: "origin_turn",
    });
    const runningList = views.list();
    expect(runningList.revision).not.toBe(initialList.revision);
    expect(runningList.items).toMatchObject([
      { display: { status: "running", activity: "origin_turn" } },
    ]);
    expect(() => views.reportActivity("connection-one", activity)).toThrow(/sequence/);
    views.reportActivity("connection-one", {
      ...activity,
      sequence: 1,
      state: "refresh",
    });
    views.clearConnection("connection-two");
    expect(views.run("run-view")?.display.status).toBe("running");
    views.expireActivity(Date.now() + ORIGIN_ACTIVITY_LEASE_MS / 2);
    expect(views.run("run-view")?.display.status).toBe("running");
    views.expireActivity(Date.now() + ORIGIN_ACTIVITY_LEASE_MS + 1);
    expect(views.run("run-view")?.display.status).toBe("waiting");

    views.reportActivity("connection-one", activity);
    state.connection.prepare("UPDATE runs SET paused = 1 WHERE run_id = ?").run("run-view");
    expect(views.run("run-view")?.display.status).toBe("paused");
    views.clearConnection("connection-one");
    state.close();
  });
});
