import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import {
  CLIENT_PROTOCOL_SCHEMA,
  MAX_PROTOCOL_MESSAGE_BYTES,
  encodeProtocolLine,
} from "../src/client/protocol.js";
import { WORKFLOW_DISPLAY_CONTROLS, type WorkflowDisplay } from "../src/client/view.js";
import { widgetRunInput } from "../src/extension/session-run-adapter.js";
import { ServerStateStore } from "../src/server/state.js";
import {
  ServerViewStore,
  reduceWorkflowDisplay,
  workflowPageStart,
  type WorkflowDisplayFacts,
} from "../src/server/view.js";
import { StateDatabase } from "../src/state/database.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { action, compute, defineWorkflow, idempotentEffect } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";
import { claimTestRun } from "./queue-helpers.js";

const base: WorkflowDisplayFacts = {
  queueStatus: "parked",
  durableStatus: "waiting",
  paused: false,
  ambiguous: false,
  runnerActive: false,
  originTurnActive: false,
  pendingRequestKind: "agent",
  requestDeliveryConfirmed: true,
  errorMessage: null,
};

function display(changes: Partial<WorkflowDisplayFacts>) {
  return reduceWorkflowDisplay({ ...base, ...changes });
}

const controlFixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "../protocol/fixtures/run-view-controls-v1.json"),
    "utf8",
  ),
) as {
  controls: string[];
  displays: Array<{ name: string; display: WorkflowDisplay }>;
  agentSnapshot: { display: WorkflowDisplay };
};

describe("workflow server display reducer", () => {
  it("keeps the server-owned control fixture aligned with the reducer", () => {
    expect(WORKFLOW_DISPLAY_CONTROLS).toEqual(controlFixture.controls);
    expect(controlFixture.agentSnapshot.display).toEqual(display({ pendingRequestKind: "agent" }));
    expect(controlFixture.displays.find(({ name }) => name === "decision")?.display).toEqual(
      display({ pendingRequestKind: "decision" }),
    );
    expect(controlFixture.displays.find(({ name }) => name === "checkpoint")?.display).toEqual(
      display({ pendingRequestKind: "checkpoint" }),
    );
    expect(controlFixture.displays.find(({ name }) => name === "paused")?.display).toEqual(
      display({ paused: true }),
    );
    expect(controlFixture.displays.find(({ name }) => name === "ambiguous")?.display).toEqual(
      display({ ambiguous: true }),
    );
  });

  it("applies the documented status precedence", () => {
    expect(
      display({
        ambiguous: true,
        durableStatus: "completed",
        paused: true,
        runnerActive: true,
      }).status,
    ).toBe("completed");
    expect(display({ durableStatus: "failed", paused: true, runnerActive: true }).status).toBe(
      "failed",
    );
    expect(display({ paused: true, runnerActive: true }).status).toBe("paused");
    expect(display({ runnerActive: true }).status).toBe("running");
    expect(display({ originTurnActive: true }).status).toBe("running");
    expect(display({}).status).toBe("waiting");
    expect(
      display({ durableStatus: "running", pendingRequestKind: null, queueStatus: "parked" }).status,
    ).toBe("queued");
    expect(
      display({ durableStatus: "running", pendingRequestKind: null, queueStatus: "queued" }).status,
    ).toBe("queued");
  });

  it.each([
    { kind: "agent", responses: ["update", "submit"] },
    { kind: "assistant", responses: [] },
    { kind: "checkpoint", responses: ["answer"] },
    { kind: "decision", responses: ["human-answer"] },
    { kind: null, responses: [] },
  ] as const)("keeps $kind controls correct across activity changes", ({ kind, responses }) => {
    for (const active of [false, true]) {
      for (const activity of ["runnerActive", "originTurnActive"] as const) {
        expect(display({ pendingRequestKind: kind, [activity]: active })).toMatchObject({
          status: active ? "running" : "waiting",
          controls: ["pause", "cancel", ...responses],
        });
      }
    }
    for (const durableStatus of ["completed", "failed", "timed_out", "cancelled"] as const) {
      expect(
        display({ pendingRequestKind: kind, durableStatus, originTurnActive: true }).controls,
      ).toEqual(durableStatus === "cancelled" ? [] : ["cancel"]);
    }
    expect(
      display({ pendingRequestKind: kind, paused: true, originTurnActive: true }).controls,
    ).toEqual(["resume", "cancel"]);
  });

  it("distinguishes unconfirmed delivery, active work, required results, and pause", () => {
    expect(display({ requestDeliveryConfirmed: false }).reason).toBe(
      "A step is pending delivery. It starts a new model turn after this turn ends.",
    );
    expect(display({ originTurnActive: true }).reason).toBe(
      "The agent is working on the workflow step.",
    );
    expect(display({}).reason).toBe("The workflow needs its assigned agent result.");
    expect(display({ pendingRequestKind: "assistant" }).reason).toBe(
      "The workflow needs its assigned visible response.",
    );
    expect(display({ paused: true, requestDeliveryConfirmed: false }).reason).toBe(
      "The workflow is durably paused.",
    );
  });

  it("reports exact activity and allowed controls", () => {
    expect(display({ runnerActive: true })).toMatchObject({
      status: "running",
      activity: "supervised_runner",
      controls: ["pause", "cancel", "update", "submit"],
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
      display({ durableStatus: "running", pendingRequestKind: null, queueStatus: "queued" })
        .controls,
    ).toEqual(["cancel"]);
    expect(
      display({
        durableStatus: "running",
        pendingRequestKind: null,
        queueStatus: "parked",
        errorMessage: "The worker exited before it saved workflow progress.",
      }),
    ).toMatchObject({
      status: "queued",
      reason: "The worker exited before it saved workflow progress.",
      controls: ["resume", "cancel"],
    });
  });

  it("derives response controls from the exact request kind, not waiting status", () => {
    expect(display({ pendingRequestKind: "checkpoint" }).controls).toEqual([
      "pause",
      "cancel",
      "answer",
    ]);
    expect(display({ pendingRequestKind: "decision" }).controls).toEqual([
      "pause",
      "cancel",
      "human-answer",
    ]);
    expect(display({ pendingRequestKind: "assistant" }).controls).toEqual(["pause", "cancel"]);
    expect(display({ pendingRequestKind: null }).controls).toEqual(["pause", "cancel"]);
    expect(display({ durableStatus: "completed", originTurnActive: true })).toMatchObject({
      status: "completed",
      activity: "origin_turn",
      controls: ["cancel"],
    });
  });

  it("keeps every large history reachable through bounded pages", () => {
    expect(workflowPageStart(300)).toBe(44);
    expect(workflowPageStart(300, 0)).toBe(0);
    expect(workflowPageStart(300, 150)).toBe(22);
    expect(workflowPageStart(300, 299)).toBe(44);
  });

  it("keeps large content and replay history reachable through bounded server views", async () => {
    const projectPath = await makeTempDir("server-view-large-project");
    const databasePath = path.join(await makeTempDir("server-view-large-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const largeInput = { task: "request ".repeat(300_000) };
    claimTestRun(queue, {
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
      runnerId: "server-view",
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
    expect(() => runs.runRevision("missing-run")).toThrow("Workflow run not found: missing-run");
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
      userArtifact: { $artifact: { path: "user-data", note: "not a server reference" } },
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

    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
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
    const coldViews = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
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
    const projectPath = await makeTempDir("server-view-graph-project");
    const databasePath = path.join(await makeTempDir("server-view-graph-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
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
    claimTestRun(queue, {
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
      runnerId: "server-view",
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
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
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
    const projectPath = await makeTempDir("server-view-topology-project");
    const databasePath = path.join(await makeTempDir("server-view-topology-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
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
      operatorData: { $artifact: { path: "operator-owned", note: "not a server reference" } },
    };
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
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
      runnerId: "server-view",
      claimToken: "claim-large-topology",
      leaseMs: 60_000,
      originSessionId: "session-large-topology",
    });
    const runs = new WorkflowRunStore(databasePath, { state });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
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
        pendingRequestKind: null,
      }).status,
    ).toBe("completed");
  });
});

describe("current session state", () => {
  it("sends the start time of the node the widget shows as running", async () => {
    const projectPath = await makeTempDir("pw-session-row-project");
    const databasePath = path.join(await makeTempDir("pw-session-row-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const originSessionId = "session-node-row";
    claimTestRun(queue, {
      runId: "row-run",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: { task: "rows" },
      runnerId: "pw-session-row",
      claimToken: "claim-row",
      leaseMs: 60_000,
      originSessionId,
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("row-run", "claim-row"),
    });
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "rows" } }),
    }).run(workflow, { task: "rows" }, { runId: "row-run" });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    const startedAt = Date.now() - 30_000;
    // Park the run for an interaction while the origin Pi turn is open. This is
    // the normal interactive case: no current node, one waiting attempt. A
    // parked attempt has no completed step row yet.
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run("row-run");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("row-run");
    state.connection
      .prepare(
        `UPDATE node_attempts SET status = 'waiting', started_at = ?, finished_at = NULL
         WHERE run_id = ?`,
      )
      .run(startedAt, "row-run");
    state.connection.prepare("DELETE FROM run_steps WHERE run_id = ?").run("row-run");
    serverState.createInteractiveRequest({
      requestId: "row-request",
      runId: "row-run",
      attemptId,
      targetSessionId: originSessionId,
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          requestId: "row-request",
          runId: "row-run",
          workflowName: workflow.name,
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    const message = serverState.workflowMessages.listSession(originSessionId)[0];
    if (message === undefined) throw new Error("workflow message missing");
    serverState.workflowMessages.adoptBranch(
      originSessionId,
      [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "row-entry" }],
      new Set([message.workflowMessageId]),
    );
    serverState.workflowMessages.startTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "row-turn",
      runId: "row-run",
      targetSessionId: originSessionId,
      now: startedAt,
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => true,
    );
    const session = views.session(originSessionId, null);
    const run = session.run;
    if (run === null) throw new Error("session run missing");
    expect(run.display.status).toBe("running");
    expect(run.currentNode).toBeNull();
    expect(run.waitingOn).toBe("reply");
    const waiting = run.nodes.find((row) => row.nodeId === "reply");
    expect(waiting?.state).toBe("waiting");
    expect(waiting?.startedAt).toBe(new Date(startedAt).toISOString());
    expect(run.nodes.find((row) => row.nodeId === "missing")?.startedAt).toBeUndefined();
    // The widget uses this value for the elapsed segment of the shown node.
    expect(widgetRunInput(run).state.currentNodeStartedAt).toBe(new Date(startedAt).toISOString());
    state.close();
  }, 60_000);

  it("keeps the session snapshot bounded while stored message history grows", async () => {
    const projectPath = await makeTempDir("current-state-project");
    const databasePath = path.join(await makeTempDir("current-state-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
      runId: "current-state-run",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: { task: "bounded" },
      runnerId: "current-state",
      claimToken: "claim-current-state",
      leaseMs: 60_000,
      originSessionId: "session-current-state",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () =>
        queue.workflowRunAuthority("current-state-run", "claim-current-state"),
    });
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "bounded" } }),
    }).run(workflow, { task: "bounded" }, { runId: "current-state-run" });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run("current-state-run");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("current-state-run");
    serverState.createInteractiveRequest({
      requestId: "current-state-pending-source",
      runId: "current-state-run",
      attemptId,
      targetSessionId: "session-current-state",
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          requestId: "current-state-pending-source",
          runId: "current-state-run",
          workflowName: workflow.name,
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    // Twenty-four stored messages of about 300 KiB each keep the complete history
    // far above one frame while the current session view stays small.
    const largeText = "stored workflow message ".repeat(13_000);
    const ids: string[] = [];
    for (let index = 1; index <= 24; index += 1) {
      const message = serverState.workflowMessages.create({
        workflowMessageId: `current-state-message-${index}`,
        runId: "current-state-run",
        targetSessionId: "session-current-state",
        kind: "step",
        sourceId: `current-state-source-${index}`,
        idempotencyKey: `current-state-message-${index}`,
        content: {
          schema: "pi-workflows.workflow-message-content.v1",
          customType: "test-step",
          content: largeText,
          display: false,
          details: { note: `${index}` },
          triggerTurn: true,
        },
        now: 1_700_000_000_000 + index,
      });
      ids.push(message.workflowMessageId);
      serverState.workflowMessages.adoptBranch(
        "session-current-state",
        [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: `entry-${index}` }],
        new Set([message.workflowMessageId]),
      );
    }
    const stored = serverState.workflowMessages.listSession("session-current-state");
    const pending = stored.find(
      (message) => message.status === "pending" && message.kind === "step",
    );
    if (pending === undefined) throw new Error("pending step message missing");
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const session = (() => {
      const reads = vi.spyOn(state, "readJson");
      const selected = views.currentWorkflowMessage("session-current-state");
      // Selection reads message metadata only, so a 25-message history costs one
      // content read for the one message Pi must act on.
      expect(reads.mock.calls.length).toBe(1);
      expect(selected?.workflowMessageId).toBe(pending.workflowMessageId);
      const view = views.session("session-current-state", null);
      expect(view.workflowMessage).not.toBeNull();
      reads.mockRestore();
      return view;
    })();
    expect(session.workflowMessage?.workflowMessageId).toBe(pending.workflowMessageId);
    expect(session.workflowMessage?.kind).toBe("step");
    expect(session.openWorkflowTurn).toBeNull();
    expect(ids).toHaveLength(24);
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "event",
      subscriptionId: "current-state",
      event: "session_snapshot",
      revision: 1,
      payload: session as unknown as never,
    });
    const stored2 = serverState.workflowMessages.listSession("session-current-state");
    expect(stored2).toHaveLength(25);
    let storedBytes = 0;
    for (const message of stored2) {
      storedBytes += Buffer.byteLength(canonicalJson(message.content), "utf8");
    }
    expect(storedBytes).toBeGreaterThan(4 * MAX_PROTOCOL_MESSAGE_BYTES);
    expect(encoded.byteLength).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES / 4);
    // Complete history stays reachable outside the session snapshot.
    const detail = runs.readRunView("current-state-run", {
      steps: { start: 0, limit: 10 },
      trace: { start: 0, limit: 10 },
      sessionEntries: { start: 0, limit: 10 },
      sessionEvents: { start: 0, limit: 10 },
      settings: { start: 0, limit: 10 },
      followUps: { start: 0, limit: 10 },
      updates: { start: 0, limit: 10 },
      graphCursor: 0,
    });
    expect(detail?.graphSteps.length).toBeGreaterThan(0);
    // Every stored message keeps its complete content outside the snapshot.
    expect(stored2.filter((message) => message.content.content === largeText)).toHaveLength(24);
    // The message history stays reachable as a bounded run page whose content is
    // served by the content operation, not by one oversized frame.
    const messagePages: Array<{ workflowMessageId?: string }> = [];
    let cursor = 0;
    for (;;) {
      const page = views.page("current-state-run", { kind: "workflow_messages", cursor });
      if (page === null) throw new Error("run page missing");
      expect(page.workflowMessageTotal).toBe(25);
      const items = page.workflowMessages as Array<{
        workflowMessageId?: string;
        content?: unknown;
      }>;
      expect(items.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(canonicalJson(page.workflowMessages), "utf8")).toBeLessThanOrEqual(
        64 * 1024,
      );
      messagePages.push(...items);
      const next = page.workflowMessageStart + items.length;
      if (next >= page.workflowMessageTotal || items.length === 0) break;
      cursor = next;
    }
    expect(messagePages.map((item) => item.workflowMessageId)).toEqual(
      stored2.map((message) => message.workflowMessageId),
    );
    // Large message content stays outside the page and arrives through the
    // content operation.
    const externalized = messagePages.find(
      (item) =>
        (item as { content?: { $artifact?: { path?: string } } }).content?.$artifact?.path !==
        undefined,
    ) as { content?: { $artifact?: { path?: string } } } | undefined;
    const pagedPath = externalized?.content?.$artifact?.path;
    if (pagedPath === undefined) throw new Error("stored message content was not externalized");
    expect(views.content("current-state-run", pagedPath, 0)).toMatchObject({
      mediaType: "application/json",
    });
    state.close();
  }, 60_000);

  it("bounds the node window and its row text for a wide workflow", async () => {
    const projectPath = await makeTempDir("node-window-project");
    const databasePath = path.join(await makeTempDir("node-window-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const nodeCount = 300;
    const failedNodeId = "node-299";
    const nodes = Object.fromEntries([
      ...Array.from(
        { length: nodeCount - 1 },
        (_, index) => [`node-${index}`, compute({ run: () => index })] as const,
      ),
      // The last node fails with an error far above one session frame.
      [
        failedNodeId,
        compute({
          run: () => {
            throw new Error(`wide failure ${"x".repeat(200_000)}`);
          },
        }),
      ] as const,
    ]);
    const workflow = defineWorkflow({
      name: "wide-node-window",
      startAt: "node-0",
      maxSteps: nodeCount + 2,
      nodes,
      edges: Array.from({ length: nodeCount - 1 }, (_, index) => ({
        from: `node-${index}`,
        to: `node-${index + 1}`,
      })),
    });
    const compiled = compileWorkflowDefinition(workflow);
    const snapshot = createDefinitionSnapshot(compiled);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
      runId: "run-node-window",
      workflowName: compiled.name,
      workflowSourceRef: "builtin:wide-node-window",
      workflowSource: {
        root: { kind: "builtin", id: "wide-node-window", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "node-window",
      claimToken: "claim-node-window",
      leaseMs: 60_000,
      originSessionId: "session-node-window",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("run-node-window", "claim-node-window"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      compiled,
      {},
      { runId: "run-node-window" },
    );
    // Keep the failed run visible to its origin session.
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run("run-node-window");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("run-node-window");
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const session = views.session("session-node-window", null);
    const run = session.run;
    if (run === null) throw new Error("session run missing");
    expect(run.nodeTotal).toBe(nodeCount);
    // The default window follows the node the widget shows as working, so the
    // failed node and its bounded error are already in view.
    const failed = run.nodes.find((row) => row.nodeId === failedNodeId);
    expect(failed?.outcome).toBe("failed");
    // One row cannot exceed the frame budget, and the complete text stays in the
    // detailed run view.
    expect(Buffer.byteLength(failed?.error ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(runs.readRunState("run-node-window")?.error ?? "", "utf8")).toBe(
      200_000 + "wide failure ".length,
    );
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "event",
      subscriptionId: "node-window",
      event: "session_snapshot",
      revision: 1,
      payload: session as unknown as never,
    });
    expect(encoded.byteLength).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES / 4);
    // A scrolled widget asks for the window it needs, and paging reaches every
    // node. Each window starts where the caller asks and stops at the byte
    // budget or the item limit.
    const first = views.session("session-node-window", null, 0).run;
    expect(first?.nodeStart).toBe(0);
    expect(first?.nodeTotal).toBe(nodeCount);
    expect(first?.nodes.length).toBeLessThan(nodeCount);
    expect(first?.nodes.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(canonicalJson(first?.nodes as never), "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
    const reachable: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = views.session("session-node-window", null, cursor).run;
      if (page === null || page.nodes.length === 0) break;
      expect(page.nodeStart).toBe(cursor);
      reachable.push(...page.nodes.map((row) => row.nodeId));
      const nextCursor = page.nodeStart + page.nodes.length;
      if (nextCursor >= page.nodeTotal) break;
      cursor = nextCursor;
    }
    expect(reachable).toHaveLength(nodeCount);
    expect(new Set(reachable).size).toBe(nodeCount);
    expect(reachable).toContain(failedNodeId);
    // A run stops at its first failure, so this run holds one bad result.
    const results = runs.readRunState("run-node-window")?.results ?? {};
    expect(Object.values(results).filter((result) => result.outcome !== "ok")).toHaveLength(1);
    state.close();
  }, 60_000);

  it("opens a node window on the end of a run that has no working node", async () => {
    const projectPath = await makeTempDir("node-tail-project");
    const databasePath = path.join(await makeTempDir("node-tail-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const nodeCount = 300;
    const nodeIds = Array.from(
      { length: nodeCount },
      (_value, index) => `node-${String(index).padStart(3, "0")}`,
    );
    const workflow = defineWorkflow({
      name: "node-tail-window",
      startAt: nodeIds[0] ?? "node-000",
      maxSteps: nodeCount + 2,
      nodes: Object.fromEntries(
        nodeIds.map((nodeId, index) => [nodeId, compute({ run: () => index })]),
      ),
      edges: nodeIds.slice(1).map((nodeId, index) => ({
        from: nodeIds[index] ?? "node-000",
        to: nodeId,
      })),
    });
    const compiled = compileWorkflowDefinition(workflow);
    const snapshot = createDefinitionSnapshot(compiled);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
      runId: "run-node-tail",
      workflowName: compiled.name,
      workflowSourceRef: "builtin:node-tail-window",
      workflowSource: {
        root: { kind: "builtin", id: "node-tail-window", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "node-tail",
      claimToken: "claim-node-tail",
      leaseMs: 60_000,
      originSessionId: "session-node-tail",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("run-node-tail", "claim-node-tail"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      compiled,
      {},
      { runId: "run-node-tail" },
    );
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const run = views.session("session-node-tail", null).run;
    if (run === null) throw new Error("session run missing");
    // This run has no working node, and the widget focuses its last row, so the
    // first window holds the end of the topology instead of its start.
    expect(run.nodeTotal).toBe(nodeCount);
    expect(run.nodeStart).toBe(nodeCount - 5);
    expect(run.nodes.map((row) => row.nodeId)).toEqual(nodeIds.slice(-5));
    state.close();
    expect(run.nodeStart).toBe(nodeCount - 5);
    expect(run.nodes.at(-1)?.nodeId).toBe(`node-${nodeCount - 1}`);
    expect(run.nodes.length).toBeLessThan(10);
    state.close();
  }, 60_000);

  it("keeps the newest progress updates in the bounded session view", async () => {
    const projectPath = await makeTempDir("progress-window-project");
    const databasePath = path.join(await makeTempDir("progress-window-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const updateCount = 20;
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "progress-window",
        startAt: "work",
        nodes: {
          work: action({
            effect: idempotentEffect("test.progress-window"),
            run: async ({ publishUpdate }) => {
              for (let index = 0; index < updateCount; index += 1) {
                await publishUpdate({
                  type: "progress",
                  key: `key-${String(index).padStart(2, "0")}`,
                  data: {
                    schema: "pi-workflows.progress.v1",
                    status: "running",
                    completed: index,
                    total: updateCount,
                    unit: "items",
                  },
                });
              }
              return "done";
            },
          }),
        },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
      runId: "run-progress-window",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:progress-window",
      workflowSource: {
        root: { kind: "builtin", id: "progress-window", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "progress-window",
      claimToken: "claim-progress-window",
      leaseMs: 60_000,
      originSessionId: "session-progress-window",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () =>
        queue.workflowRunAuthority("run-progress-window", "claim-progress-window"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      workflow,
      {},
      { runId: "run-progress-window" },
    );
    // Keep the finished run visible to its origin session.
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run("run-progress-window");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("run-progress-window");
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    expect({
      error: runs.readRunState("run-progress-window")?.error ?? null,
      updates: state.connection
        .prepare(
          "SELECT COUNT(*) AS value FROM workflow_updates u JOIN node_attempts a ON a.attempt_id = u.attempt_id WHERE a.run_id = ?",
        )
        .get("run-progress-window"),
    }).toEqual({ error: null, updates: { value: updateCount } });
    const run = views.session("session-progress-window", null).run;
    if (run === null) throw new Error("session run missing");
    // A run keeps up to 1,024 current updates, so the bounded widget set must
    // hold the newest keys instead of the oldest ones.
    const keys = run.progressUpdates.map((update) => update.key);
    expect(keys).toHaveLength(16);
    expect(keys[0]).toBe("key-04");
    expect(keys.at(-1)).toBe("key-19");
    expect(run.progressUpdates.at(-1)?.data).toMatchObject({
      completed: updateCount - 1,
      total: updateCount,
    });
    state.close();
  }, 60_000);

  it("binds origin activity to one connection and gives durable pause precedence", async () => {
    const projectPath = await makeTempDir("server-view-project");
    const databasePath = path.join(await makeTempDir("server-view-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
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
      runnerId: "server-view",
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
    const applyingViews = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      (runId) => runId === "run-view",
      () => false,
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
      .run(null, "run-view");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("run-view");
    serverState.createInteractiveRequest({
      requestId: "request-view",
      runId: "run-view",
      attemptId,
      targetSessionId: "session-view",
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          requestId: "request-view",
          runId: "run-view",
          workflowName: "echo",
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    let modelTurnActive = true;
    let runnerActive = false;
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => runnerActive,
      () => modelTurnActive,
    );
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
    const waitingRevision = views.list().revision;
    runnerActive = true;
    views.noteWorkflowActivityChange();
    const runnerList = views.list();
    expect(runnerList.revision).not.toBe(waitingRevision);
    expect(runnerList.items[0]?.display).toMatchObject({
      status: "running",
      activity: "supervised_runner",
    });
    expect(views.run("run-view")?.display.status).toBe("running");
    runnerActive = false;
    views.noteWorkflowActivityChange();
    const parkedList = views.list();
    expect(parkedList.revision).not.toBe(runnerList.revision);
    expect(parkedList.items[0]?.display).toMatchObject({ status: "waiting", activity: null });
    expect(views.run("run-view")?.display.status).toBe("waiting");

    const message = serverState.workflowMessages.listSession("session-view")[0];
    if (message === undefined) throw new Error("workflow message missing");
    serverState.workflowMessages.adoptBranch(
      "session-view",
      [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-view" }],
      new Set([message.workflowMessageId]),
    );
    serverState.workflowMessages.startTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "turn-view",
      runId: "run-view",
      targetSessionId: "session-view",
      now: Date.now() - 11_000,
    });
    expect(views.run("run-view")?.display).toMatchObject({
      status: "running",
      activity: "origin_turn",
      controls: ["pause", "cancel", "update", "submit"],
    });
    modelTurnActive = false;
    views.noteWorkflowActivityChange();
    expect(views.run("run-view")?.display.status).toBe("waiting");
    modelTurnActive = true;
    views.noteWorkflowActivityChange();
    const runningList = views.list();
    expect(runningList.revision).not.toBe(initialList.revision);
    expect(runningList.items).toMatchObject([
      { display: { status: "running", activity: "origin_turn" } },
    ]);
    expect(views.run("run-view")?.display.status).toBe("running");

    state.connection.prepare("UPDATE runs SET paused = 1 WHERE run_id = ?").run("run-view");
    expect(views.run("run-view")?.display.status).toBe("paused");
    serverState.workflowMessages.endTurn({
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
         SET status = 'failed', error_code = 'runnerExited', error_hash = ?, updated_at = ?
         WHERE run_id = 'run-view'`,
      )
      .run(errorHash, Date.now());
    state.connection.prepare("UPDATE runs SET status = 'failed' WHERE run_id = 'run-view'").run();
    const failedViews = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
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
    const oversizedViews = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
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
