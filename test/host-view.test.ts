import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
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
import { compute, defineWorkflow } from "../src/workflows/definition.js";
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
      "running",
    );
    expect(display({ paused: true, workerActive: true }).status).toBe("running");
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
    expect(runs.readContentBlob("missing-run", "0".repeat(64), "application/json")).toBeUndefined();
    expect(runs.readContentBlob("run-large-view", "invalid", "application/json")).toBeUndefined();
    const largeOutput = {
      text: "x".repeat(2 * 1024 * 1024),
      userArtifact: { $artifact: { path: "user-data", note: "not a host reference" } },
    };
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: largeOutput }),
    }).run(workflow, largeInput, { runId: "run-large-view" });
    const collidingText = canonicalJson(largeInput);
    const collidingDigest = runs.persistViewContent(
      "run-large-view",
      Buffer.from(collidingText, "utf8"),
      "text/plain",
    );
    expect(runs.readContentBlob("run-large-view", collidingDigest, "text/plain")?.content).toEqual(
      Buffer.from(collidingText, "utf8"),
    );
    const unlinkedContent = Buffer.from("unlinked view content", "utf8");
    const unlinkedDigest = runs.persistViewContent("run-large-view", unlinkedContent, "text/plain");
    state.connection
      .prepare(
        `DELETE FROM run_view_content
         WHERE run_id = ? AND content_hash = ? AND media_type = ?`,
      )
      .run("run-large-view", Buffer.from(unlinkedDigest, "hex"), "text/plain");
    expect(runs.readContentBlob("run-large-view", unlinkedDigest, "text/plain")).toBeUndefined();
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    await runs.writeSessionBinding("run-large-view", {
      schema: "pi-workflows.session-binding.v1",
      runId: "run-large-view",
      piSessionId: "session-large-view",
      cwd: projectPath,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    const largeStreamingTexts = Array.from(
      { length: 4 },
      (_, index) => `message-${index} ${"stream ".repeat(55_000)}`,
    );
    const streamingEvents = largeStreamingTexts.flatMap(
      (content, messageIndex): WorkflowSessionEventRecord[] => {
        const seq = messageIndex * 3 + 1;
        const messageId = `large-streaming-message-${messageIndex}`;
        return [
          {
            seq,
            at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq - 1)).toISOString(),
            nodeId: "reply",
            attemptId,
            messageId,
            type: "message_started",
            payload: { role: "assistant" },
          },
          {
            seq: seq + 1,
            at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq)).toISOString(),
            nodeId: "reply",
            attemptId,
            messageId,
            type: "assistant_event",
            payload: { type: "text_start", contentIndex: 0 },
          },
          {
            seq: seq + 2,
            at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq + 1)).toISOString(),
            nodeId: "reply",
            attemptId,
            messageId,
            type: "assistant_event",
            payload: { type: "text_end", contentIndex: 0, content },
          },
        ];
      },
    );
    const events: WorkflowSessionEventRecord[] = [
      ...streamingEvents,
      ...Array.from({ length: 300 }, (_, index): WorkflowSessionEventRecord => {
        const turn = Math.floor(index / 2);
        const started = index % 2 === 0;
        return {
          seq: index + streamingEvents.length + 1,
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index + streamingEvents.length)).toISOString(),
          nodeId: "reply",
          attemptId,
          turnId: `turn-${turn}`,
          type: started ? "turn_started" : "turn_finished",
          payload: started
            ? { turnIndex: turn }
            : { turnIndex: turn, messageId: `message-${turn}`, toolCallIds: [] },
        };
      }),
    ];
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
      runs.readContentBlob("run-large-view", collidingDigest, "application/json")?.content,
    ).toEqual(Buffer.from(collidingText, "utf8"));
    expect(
      views.page("run-large-view", { kind: "trace_at_step", cursor: 0 })?.tracePage,
    ).toMatchObject({ total: expect.any(Number), items: expect.any(Array) });
    expect(runs.traceCursorForStep("run-large-view", 99, 10)).toBe(9);
    const outputDigest = createHash("sha256").update(canonicalJson(largeOutput)).digest("hex");
    expect(runs.readContentBlob("run-large-view", outputDigest, "application/json")).toMatchObject({
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

    const stateView = view.state as {
      steps?: Array<{ output?: unknown }>;
      outputs?: unknown;
    };
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

    const outputsArtifact = stateView.outputs as {
      $artifact?: { path?: string; sha256?: string };
    };
    const outputsPath = outputsArtifact.$artifact?.path;
    const outputsDigest = outputsArtifact.$artifact?.sha256;
    if (outputsPath === undefined || outputsDigest === undefined) {
      throw new Error("large aggregate outputs were not externalized");
    }
    expect(runs.readContentBlob(view.runId, outputsDigest, "application/json")).toMatchObject({
      mediaType: "application/json",
    });
    const outputChunks: Buffer[] = [];
    let outputsOffset = 0;
    for (;;) {
      const chunk = coldViews.content(view.runId, outputsPath, outputsOffset) as {
        data: string;
        nextOffset: number;
        complete: boolean;
      };
      outputChunks.push(Buffer.from(chunk.data, "base64"));
      outputsOffset = chunk.nextOffset;
      if (chunk.complete) break;
    }
    expect(JSON.parse(Buffer.concat(outputChunks).toString("utf8"))).toEqual(result.state.outputs);

    const session = view.session as {
      eventPage?: { start?: number; items?: unknown[] };
      replayCheckpoint?: {
        $artifact?: { path?: string; bytes?: number; sha256?: string };
      } | null;
    };
    expect(session.eventPage?.items).toHaveLength(256);
    expect(session.eventPage?.start).toBeGreaterThan(0);
    const checkpointPath = session.replayCheckpoint?.$artifact?.path;
    expect(session.replayCheckpoint?.$artifact?.bytes).toBeGreaterThan(MAX_PROTOCOL_MESSAGE_BYTES);
    if (checkpointPath === undefined)
      throw new Error("large replay checkpoint was not externalized");
    const checkpointChunks: Buffer[] = [];
    let checkpointOffset = 0;
    for (;;) {
      const chunk = coldViews.content(view.runId, checkpointPath, checkpointOffset) as {
        data: string;
        nextOffset: number;
        complete: boolean;
      };
      checkpointChunks.push(Buffer.from(chunk.data, "base64"));
      checkpointOffset = chunk.nextOffset;
      if (chunk.complete) break;
    }
    const checkpoint = JSON.parse(Buffer.concat(checkpointChunks).toString("utf8")) as {
      throughSeq?: number;
      messages?: Array<{ blocks?: Array<{ text?: string }> }>;
    };
    expect(checkpoint.throughSeq).toBe(session.eventPage?.start);
    expect(checkpoint.messages?.[0]?.blocks?.[0]?.text).toBe(largeStreamingTexts[0]);

    const selectedTraceCursor = runs.traceCursorForStep("run-large-view", 0, 10_000);
    const runRow = state.connection
      .prepare("SELECT resource_id AS resourceId FROM runs WHERE run_id = ?")
      .get("run-large-view") as { resourceId: string };
    const revisionRow = state.connection
      .prepare("SELECT max(resource_revision) AS revision FROM events WHERE resource_id = ?")
      .get(runRow.resourceId) as { revision: number };
    const laterPayload = state.putJson({
      scope: "node",
      nodeId: "reply",
      attemptId: "later-repeated-attempt",
      payload: {},
    });
    state.connection
      .prepare(
        `INSERT INTO events(
           event_id, resource_id, resource_revision, event_type,
           actor_type, payload_hash, recorded_at
         ) VALUES (?, ?, ?, 'node_started', 'system', ?, ?)`,
      )
      .run(
        "later-repeated-attempt-event",
        runRow.resourceId,
        revisionRow.revision + 1,
        laterPayload,
        Date.now(),
      );
    expect(runs.traceCursorForStep("run-large-view", 0, 10_000)).toBe(selectedTraceCursor);
    state.close();
  }, 60_000);

  it("keeps complete graph history reachable outside the bounded snapshot", async () => {
    const projectPath = await makeTempDir("host-view-graph-project");
    const databasePath = path.join(await makeTempDir("host-view-graph-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new SqliteControllerStore(databasePath, { state, projectPath });
    const hostState = new HostStateStore(databasePath, { state });
    const nodeCount = 257;
    const workflow = defineWorkflow({
      name: "large-graph-history",
      startAt: "node-0",
      maxSteps: nodeCount + 1,
      nodes: Object.fromEntries(
        Array.from({ length: nodeCount }, (_, index) => [
          `node-${index}`,
          compute({ run: () => index }),
        ]),
      ),
      edges: Array.from({ length: nodeCount - 1 }, (_, index) => ({
        from: `node-${index}`,
        to: `node-${index + 1}`,
      })),
    });
    const compiled = compileWorkflowDefinition(workflow);
    const snapshot = createDefinitionSnapshot(compiled);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    queue.enqueueWorkflowRun({
      runId: "run-large-graph",
      workflowName: compiled.name,
      workflowSourceRef: "builtin:large-graph",
      workflowSource: {
        root: { kind: "builtin", id: "large-graph", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "host-view",
      claimToken: "claim-large-graph",
      leaseMs: 60_000,
      originSessionId: "session-large-graph",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("run-large-graph", "claim-large-graph"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      compiled,
      {},
      { runId: "run-large-graph" },
    );
    const views = new HostViewStore(state, queue, hostState, runs, () => false);
    const view = views.run("run-large-graph");
    if (view === null) throw new Error("large graph view missing");
    expect(view.graphStepTotal).toBe(nodeCount);
    expect(view.graphSteps.length).toBeLessThan(nodeCount);
    expect(view.takenTransitionTotal).toBe(nodeCount - 1);
    const historyReference = view.graphHistory as {
      $artifact?: { sha256?: string };
    };
    const digest = historyReference.$artifact?.sha256;
    if (digest === undefined) throw new Error("complete graph history reference missing");
    const history = JSON.parse(
      runs.readContentBlob(view.runId, digest, "application/json")?.content.toString("utf8") ??
        "null",
    ) as {
      steps?: unknown[];
      transitions?: unknown[];
    };
    expect(history.steps).toHaveLength(nodeCount);
    expect(history.transitions).toHaveLength(nodeCount - 1);
    state.close();
  }, 60_000);

  it("bounds large workflow topology and keeps the full definition reachable", async () => {
    const projectPath = await makeTempDir("host-view-topology-project");
    const databasePath = path.join(await makeTempDir("host-view-topology-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new SqliteControllerStore(databasePath, { state, projectPath });
    const hostState = new HostStateStore(databasePath, { state });
    const baseSnapshot = createDefinitionSnapshot(compileWorkflowDefinition(rawWorkflow));
    const template = Object.values(baseSnapshot.nodes)[0];
    if (template === undefined) throw new Error("node template missing");
    const nodeCount = 20_000;
    const nodes = Object.fromEntries(
      Array.from({ length: nodeCount }, (_, index) => [`node-${index}`, template]),
    );
    const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
      from: `node-${index}`,
      to: `node-${index + 1}`,
    }));
    const snapshot = {
      ...baseSnapshot,
      name: "large-topology",
      startAt: "node-0",
      nodes,
      edges,
      operatorData: { $artifact: { path: "operator-owned", note: "not a host reference" } },
    };
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    queue.enqueueWorkflowRun({
      runId: "run-large-topology",
      workflowName: snapshot.name,
      workflowSourceRef: "builtin:large-topology",
      workflowSource: {
        root: { kind: "builtin", id: "large-topology", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "host-view",
      claimToken: "claim-large-topology",
      leaseMs: 60_000,
      originSessionId: "session-large-topology",
    });
    const runs = new WorkflowRunStore(databasePath, { state });
    const views = new HostViewStore(state, queue, hostState, runs, () => false);
    const view = views.run("run-large-topology");
    if (view === null) throw new Error("large topology view missing");
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "event",
      subscriptionId: "large-topology",
      event: "run_snapshot",
      revision: 1,
      runId: view.runId,
      payload: view as unknown as never,
    });
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PROTOCOL_MESSAGE_BYTES + 1);
    const workflow = view.workflow as {
      nodes?: Record<string, unknown>;
      nodeTotal?: number;
      edges?: unknown[];
      edgeTotal?: number;
      content?: { $artifact?: { sha256?: string } };
    };
    expect(Object.keys(workflow.nodes ?? {})).toHaveLength(256);
    expect(workflow.nodeTotal).toBe(nodeCount);
    expect(workflow.edges).toHaveLength(256);
    expect(workflow.edgeTotal).toBe(nodeCount - 1);
    const digest = workflow.content?.$artifact?.sha256;
    if (digest === undefined) throw new Error("full workflow content reference missing");
    const blob = runs.readContentBlob(view.runId, digest, "application/json");
    expect(blob).toBeDefined();
    const fullWorkflow = JSON.parse(blob?.content.toString("utf8") ?? "null") as {
      nodes: object;
      operatorData?: unknown;
    };
    expect(Object.keys(fullWorkflow.nodes)).toHaveLength(nodeCount);
    expect(fullWorkflow.operatorData).toEqual(snapshot.operatorData);
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
      .prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE run_id = ?")
      .run("run-view");
    const effect = await runs.reserveEffect({
      runId: "run-view",
      attemptId,
      effectType: "test.effect",
      idempotencyKey: "applying-effect",
      request: { value: 1 },
      recovery: "idempotent",
    });
    const applyingViews = new HostViewStore(
      state,
      queue,
      hostState,
      runs,
      (runId) => runId === "run-view",
    );
    expect(applyingViews.run("run-view")?.display.status).toBe("running");
    await runs.settleEffect({
      runId: "run-view",
      effectId: effect.effectId,
      attemptNumber: effect.attemptNumber,
      outcome: "applied",
      result: { ok: true },
    });
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', paused = 0, finished_at = ? WHERE run_id = ?")
      .run(Date.now(), "run-view");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("run-view");
    const request = hostState.createInteractiveRequest({
      requestId: "request-view",
      runId: "run-view",
      attemptId,
      targetSessionId: "session-view",
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          runId: "run-view",
          workflowName: "echo",
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    const views = new HostViewStore(state, queue, hostState, runs, () => false);
    const readRun = vi.spyOn(runs, "readRun");
    const initialList = views.list();
    expect(initialList.items).toHaveLength(1);
    expect(readRun).not.toHaveBeenCalled();
    readRun.mockRestore();

    expect(views.run("run-view")).toMatchObject({
      display: { status: "waiting" },
      manifest: {
        workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      },
      state: {
        workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      },
    });
    const message = hostState.workflowMessages.listSession("session-view")[0];
    if (message === undefined) throw new Error("workflow message missing");
    hostState.workflowMessages.adoptBranch(
      "session-view",
      [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-view" }],
      new Set([message.workflowMessageId]),
    );
    hostState.workflowMessages.startTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "turn-view",
      runId: "run-view",
      targetSessionId: "session-view",
      now: Date.now() - 11_000,
    });
    expect(views.run("run-view")?.display).toMatchObject({
      status: "running",
      activity: "origin_turn",
    });
    const runningList = views.list();
    expect(runningList.revision).not.toBe(initialList.revision);
    expect(runningList.items).toMatchObject([
      { display: { status: "running", activity: "origin_turn" } },
    ]);
    expect(views.run("run-view")?.display.status).toBe("running");

    state.connection.prepare("UPDATE runs SET paused = 1 WHERE run_id = ?").run("run-view");
    expect(views.run("run-view")?.display.status).toBe("running");
    hostState.workflowMessages.endTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "turn-view",
      runId: "run-view",
      targetSessionId: "session-view",
      stopReason: "aborted",
      responseSessionEntryId: null,
    });
    expect(views.run("run-view")?.display.status).toBe("paused");
    state.connection
      .prepare("UPDATE run_queue SET status = 'done', finished_at = ? WHERE run_id = 'run-view'")
      .run(Date.now());
    state.connection
      .prepare(
        "UPDATE runs SET status = 'completed', paused = 0, finished_at = ? WHERE run_id = 'run-view'",
      )
      .run(Date.now());
    expect(views.session("session-view").run).toBeNull();

    const completeFailureReason = `worker failed after cleanup: ${"diagnostic ".repeat(40)}`;
    const errorHash = state.putText(completeFailureReason);
    state.connection
      .prepare(
        `UPDATE run_queue
         SET status = 'failed', error_code = 'workerExited', error_hash = ?, updated_at = ?
         WHERE run_id = 'run-view'`,
      )
      .run(errorHash, Date.now());
    state.connection.prepare("UPDATE runs SET status = 'failed' WHERE run_id = 'run-view'").run();
    const failedViews = new HostViewStore(state, queue, hostState, runs, () => false);
    expect(failedViews.list().items[0]?.display).toMatchObject({
      status: "failed",
      reason: completeFailureReason,
    });
    expect(failedViews.run("run-view")?.display.reason).toBe(completeFailureReason);

    const oversizedFailureReason = "oversized diagnostic ".repeat(
      Math.ceil((MAX_PROTOCOL_MESSAGE_BYTES * 2) / 21),
    );
    const oversizedErrorHash = state.putText(oversizedFailureReason);
    state.connection
      .prepare("UPDATE run_queue SET error_hash = ?, updated_at = ? WHERE run_id = 'run-view'")
      .run(oversizedErrorHash, Date.now() + 1);
    const oversizedViews = new HostViewStore(state, queue, hostState, runs, () => false);
    const oversizedList = oversizedViews.list();
    const reasonContent = oversizedList.items[0]?.display.reasonContent as
      | { $artifact?: { path?: string; sha256?: string } }
      | undefined;
    expect(oversizedList.items[0]?.display.reason).toBe(
      "Complete workflow failure details are available.",
    );
    expect(
      encodeProtocolLine({
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "event",
        subscriptionId: "oversized-list",
        event: "runs",
        revision: 1,
        payload: oversizedList as unknown as never,
      }).byteLength,
    ).toBeLessThanOrEqual(MAX_PROTOCOL_MESSAGE_BYTES + 1);
    const reasonDigest = reasonContent?.$artifact?.sha256;
    if (reasonDigest === undefined) throw new Error("failure reason content reference missing");
    expect(
      runs.readContentBlob("run-view", reasonDigest, "text/plain")?.content.toString("utf8"),
    ).toBe(oversizedFailureReason);
    state.close();
  });
});
