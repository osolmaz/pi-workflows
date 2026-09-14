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
import { choice, defineHumanChoices, humanDecision } from "../src/workflows/human-decision.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { NODE_ID_MAX_BYTES } from "../src/workflows/schema.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import type { WorkflowSessionEventRecord } from "../src/workflows/types.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";
import { claimTestRun } from "./queue-helpers.js";

/** Free-form session text one compact projection carries, in bytes. */
const SESSION_TEXT_LIMIT = 4 * 1024;

/**
 * Rename one node in a compiled definition snapshot. A stored run written before
 * the node identity limit can hold an identity that no bounded view can carry, so
 * the view tests build that state directly instead of compiling it.
 */
function renameSnapshotNode(
  snapshot: ReturnType<typeof createDefinitionSnapshot>,
  from: string,
  to: string,
): void {
  snapshot.nodes = Object.fromEntries(
    Object.entries(snapshot.nodes).map(([nodeId, node]) => [nodeId === from ? to : nodeId, node]),
  );
  if (snapshot.startAt === from) snapshot.startAt = to;
  snapshot.edges = snapshot.edges.map((edge) => ({
    ...edge,
    from: edge.from === from ? to : edge.from,
    ...("to" in edge && edge.to === from ? { to } : {}),
  }));
}

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

/**
 * A parked run that waits on one step message for its origin session. The run
 * keeps its reservation unless the test cancels it.
 */
async function pendingStepFixture(label: string, delivered = false) {
  const projectPath = await makeTempDir(`${label}-project`);
  const databasePath = path.join(await makeTempDir(`${label}-state`), "state.sqlite");
  const state = new StateDatabase({ filePath: databasePath });
  const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
  const serverState = new ServerStateStore(databasePath, { state });
  const workflow = compileWorkflowDefinition(rawWorkflow);
  const snapshot = createDefinitionSnapshot(workflow);
  const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  const runId = `run-${label}`;
  const sessionId = `session-${label}`;
  claimTestRun(queue, {
    runId,
    workflowName: workflow.name,
    workflowSourceRef: "builtin:echo",
    workflowSource: {
      root: { kind: "builtin", id: "echo", revision: "test" },
      mounted: [],
    },
    definitionDigest,
    definitionSnapshot: snapshot,
    input: { task: label },
    runnerId: label,
    claimToken: `claim-${label}`,
    leaseMs: 60_000,
    originSessionId: sessionId,
  });
  const runs = new WorkflowRunStore(databasePath, {
    state,
    authorityProvider: () => queue.workflowRunAuthority(runId, `claim-${label}`),
  });
  const result = await new WorkflowEngine({
    store: runs,
    executor: new ScriptedExecutor().respond("reply", { output: { reply: label } }),
  }).run(workflow, { task: label }, { runId });
  const attemptId = result.state.steps[0]?.attemptId;
  if (attemptId === undefined) throw new Error("attempt missing");
  state.connection
    .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
    .run(runId);
  state.connection
    .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
    .run(runId);
  const requestId = `${label}-source`;
  serverState.createInteractiveRequest({
    requestId,
    runId,
    attemptId,
    targetSessionId: sessionId,
    kind: "agent",
    contract: {
      prompt: "Continue",
      contract: {
        requestId,
        runId,
        workflowName: workflow.name,
        nodeId: "reply",
        attemptId,
        completion: "submit",
      },
    },
  });
  const pending = serverState.workflowMessages.latestForSource("step", requestId);
  if (pending === undefined) throw new Error("step message missing");
  if (delivered) {
    serverState.workflowMessages.adoptBranch(
      sessionId,
      [{ workflowMessageId: pending.workflowMessageId, piSessionEntryId: `${label}-entry` }],
      new Set([pending.workflowMessageId]),
    );
  }
  const views = new ServerViewStore(
    state,
    queue,
    serverState,
    runs,
    () => false,
    () => false,
  );
  return { state, views, runId, sessionId, requestId, pending };
}

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

  it("keeps a run list frame inside the client limit when one name is very long", async () => {
    const projectPath = await makeTempDir("long-name-project");
    const databasePath = path.join(await makeTempDir("long-name-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // The workflow name has no length limit, and a run row can hold a name far
    // larger than one client frame.
    const longName = `long-name-${"n".repeat(2 * 1024 * 1024)}`;
    const workflow = compileWorkflowDefinition(rawWorkflow);
    // The run definition carries the same long name, as a real definition would.
    const snapshot = { ...createDefinitionSnapshot(workflow), name: longName };
    claimTestRun(queue, {
      runId: "long-name-run",
      workflowName: longName,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
      definitionSnapshot: snapshot,
      input: { task: "long-name" },
      runnerId: "long-name",
      claimToken: "claim-long-name",
      leaseMs: 60_000,
      originSessionId: "session-long-name",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("long-name-run", "claim-long-name"),
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const page = views.list(0, 10);
    const item = page.items.find((candidate) => candidate.runId === "long-name-run");
    if (item === undefined) throw new Error("run list did not carry the run");
    // One free-form value is cut at 4 KiB on a character boundary, so the whole
    // page stays inside one frame.
    expect(Buffer.byteLength(item.workflowName, "utf8")).toBeLessThanOrEqual(SESSION_TEXT_LIMIT);
    expect(item.workflowName.endsWith("\uFFFD")).toBe(false);
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "long-name-request",
      outcome: "accepted",
      receipt: page as unknown as never,
    });
    expect(encoded.byteLength).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES);
    // The complete name stays reachable through the run content the bounded
    // definition points at.
    const view = views.run("long-name-run");
    if (view === null) throw new Error("run view missing");
    const reference = view.workflow as {
      name?: string;
      content?: { $artifact?: { path?: string } };
    };
    expect(Buffer.byteLength(reference.name ?? "", "utf8")).toBeLessThanOrEqual(SESSION_TEXT_LIMIT);
    const definitionPath = reference.content?.$artifact?.path;
    if (definitionPath === undefined) throw new Error("definition was not externalized");
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = views.content("long-name-run", definitionPath, offset) as {
        data: string;
        nextOffset: number;
        complete: boolean;
      } | null;
      if (chunk === null) throw new Error("definition content missing");
      chunks.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
      if (chunk.complete) break;
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain(longName);
    state.close();
  }, 60_000);

  it("keeps a decision row inside the frame at the largest legal choice value", async () => {
    const projectPath = await makeTempDir("long-choice-project");
    const databasePath = path.join(await makeTempDir("long-choice-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // A choice value is the key a human answer sends back. Its pattern allows up to
    // 128 characters, so the row copies every kept value exactly and stops before
    // the 8 KiB detail budget. This bounds the widest legal decision row.
    const wideValue = (index: number): string =>
      `c${`${index}`.padStart(3, "0")}${"v".repeat(123)}`;
    const wideChoices = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        wideValue(index),
        choice({ label: `Choice ${index}` }),
      ]),
    );
    const choices = defineHumanChoices({
      approve: choice({ label: "Approve" }),
      reject: choice({ label: "Reject" }),
      ...wideChoices,
    });
    const workflow = defineWorkflow({
      name: "long-choice",
      startAt: "gate",
      nodes: {
        gate: humanDecision({
          audience: "operator",
          choices,
          request: () => ({
            title: "Approve the action",
            subject: { action: "test" },
            presentation: {
              schema: "pi-workflows.decision-presentation.v1",
              summary: "A human must approve this test action.",
              blocks: [{ kind: "paragraph", text: "Review the action first." }],
            },
          }),
        }),
      },
      edges: [],
    });
    const compiled = compileWorkflowDefinition(workflow);
    const snapshot = createDefinitionSnapshot(compiled) as unknown as Record<string, unknown>;
    claimTestRun(queue, {
      runId: "long-choice-run",
      workflowName: compiled.name,
      workflowSourceRef: "builtin:long-choice",
      workflowSource: {
        root: { kind: "builtin", id: "long-choice", revision: "test" },
        mounted: [],
      },
      definitionDigest: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
      definitionSnapshot: snapshot,
      input: { task: "long-choice" },
      runnerId: "long-choice",
      claimToken: "claim-long-choice",
      leaseMs: 60_000,
      originSessionId: "session-long-choice",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("long-choice-run", "claim-long-choice"),
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const view = views.session("session-long-choice", null);
    const row = view.run?.nodes?.find((node) => node.nodeId === "gate");
    if (row?.humanDecision === undefined || row.humanDecision === null) {
      throw new Error("decision row missing");
    }
    const kept = row.humanDecision.choices;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(choices && Object.keys(choices).length);
    expect(kept.every((entry) => entry.value.length <= 128)).toBe(true);
    expect(kept.every((entry) => !entry.value.endsWith("\uFFFD"))).toBe(true);
    // The complete decision stays available through the detailed run view.
    const detailed = views.run("long-choice-run");
    expect(detailed).not.toBeNull();
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "event",
      subscriptionId: "long-choice",
      event: "session_snapshot",
      revision: 1,
      payload: view as unknown as never,
    });
    expect(encoded.byteLength).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES / 4);
    state.close();
  }, 60_000);

  it("holds the session snapshot at its size when stored history reaches thousands", async () => {
    const projectPath = await makeTempDir("long-history-project");
    const databasePath = path.join(await makeTempDir("long-history-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    claimTestRun(queue, {
      runId: "long-history-run",
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: { task: "bounded" },
      runnerId: "long-history",
      claimToken: "claim-long-history",
      leaseMs: 60_000,
      originSessionId: "session-long-history",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority("long-history-run", "claim-long-history"),
    });
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "bounded" } }),
    }).run(workflow, { task: "bounded" }, { runId: "long-history-run" });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run("long-history-run");
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run("long-history-run");
    serverState.createInteractiveRequest({
      requestId: "long-history-pending-source",
      runId: "long-history-run",
      attemptId,
      targetSessionId: "session-long-history",
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          requestId: "long-history-pending-source",
          runId: "long-history-run",
          workflowName: workflow.name,
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const encode = (session: unknown) =>
      encodeProtocolLine({
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "event",
        subscriptionId: "long-history",
        event: "session_snapshot",
        revision: 1,
        payload: session as never,
      });
    const current = views.session("session-long-history", null);
    const pendingMessageId = current.workflowMessage?.workflowMessageId;
    if (pendingMessageId === undefined) throw new Error("pending message missing");
    const before = encode(current).byteLength;
    // Two thousand delivered messages leave the stored history far above one frame.
    const storedCount = 2_000;
    const entries: Array<{ workflowMessageId: string; piSessionEntryId: string }> = [];
    for (let index = 1; index <= storedCount; index += 1) {
      const message = serverState.workflowMessages.create({
        workflowMessageId: `long-history-message-${index}`,
        runId: "long-history-run",
        targetSessionId: "session-long-history",
        kind: "terminal",
        sourceId: `long-history-source-${index}`,
        idempotencyKey: `long-history-message-${index}`,
        content: {
          schema: "pi-workflows.workflow-message-content.v1",
          customType: "test-terminal",
          content: `stored workflow message ${index}`,
          display: false,
          details: { note: `${index}` },
          triggerTurn: false,
        },
        now: 1_700_000_000_000 + index,
      });
      entries.push({
        workflowMessageId: message.workflowMessageId,
        piSessionEntryId: `entry-${index}`,
      });
    }
    serverState.workflowMessages.adoptBranch(
      "session-long-history",
      entries,
      new Set(entries.map((entry) => entry.workflowMessageId)),
    );
    const reads = vi.spyOn(state, "readJson");
    const selected = views.currentWorkflowMessage("session-long-history");
    // Selection reads message metadata only, so a two-thousand-message history
    // costs one content read for the one message Pi must act on.
    expect(reads.mock.calls.length).toBe(1);
    reads.mockRestore();
    expect(selected?.workflowMessageId).toBe(pendingMessageId);
    const grown = views.session("session-long-history", null);
    expect(grown.workflowMessage?.workflowMessageId).toBe(pendingMessageId);
    const after = encode(grown).byteLength;
    // The frame carries current work, so stored history cannot make it grow. The
    // measured frame is below 4 KiB with two thousand stored messages.
    expect(after).toBeLessThanOrEqual(before + 64);
    expect(after).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES / 4);
    expect(serverState.workflowMessages.listSession("session-long-history")).toHaveLength(
      storedCount + 1,
    );
    // The complete history stays reachable through the bounded run page.
    const page = views.page("long-history-run", { kind: "workflow_messages", cursor: 0 });
    if (page === null) throw new Error("run page missing");
    expect(page.workflowMessageTotal).toBe(storedCount + 1);
    expect(Buffer.byteLength(canonicalJson(page.workflowMessages), "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
    // The cache key reads message metadata in bounded batches, in the order the
    // selection needs, so one view call over a long session history reads a few
    // rows instead of every stored message.
    const batches = vi.spyOn(serverState.workflowMessages, "listSessionSummaryBatch");
    const fullScans = vi.spyOn(serverState.workflowMessages, "listSessionSummaries");
    views.session("session-long-history", null);
    const rowsRead = batches.mock.calls.reduce((total, call) => total + (call[1]?.limit ?? 0), 0);
    expect(batches.mock.calls.every((call) => (call[1]?.limit ?? 0) <= 32)).toBe(true);
    expect(rowsRead).toBeLessThanOrEqual(32 * batches.mock.calls.length);
    expect(fullScans).not.toHaveBeenCalled();
    batches.mockClear();
    // A repeat call over a session whose messages did not change costs the indexed
    // key and not the stored history, so a periodic view call reads no message row.
    views.session("session-long-history", null);
    views.currentWorkflowMessage("session-long-history");
    expect(batches).not.toHaveBeenCalled();
    batches.mockRestore();
    fullScans.mockRestore();
    state.close();
  }, 120_000);

  it("keeps the eligible message behind neighbours the candidate filters skip", async () => {
    const projectPath = await makeTempDir("filter-eq-project");
    const databasePath = path.join(await makeTempDir("filter-eq-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-filter-eq";
    const sessionId = "session-filter-eq";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: { root: { kind: "builtin", id: "echo", revision: "test" }, mounted: [] },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: { task: "filter" },
      runnerId: "filter-eq",
      claimToken: "claim-filter-eq",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-filter-eq"),
    });
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "filter" } }),
    }).run(workflow, { task: "filter" }, { runId });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const create = (
      index: number,
      kind: "step" | "notification" | "terminal" | "followUp",
      now: number,
    ) =>
      serverState.workflowMessages.create({
        workflowMessageId: `filter-message-${kind}-${index}`,
        runId,
        targetSessionId: sessionId,
        kind,
        sourceId: `filter-source-${kind}-${index}`,
        idempotencyKey: `filter-message-${kind}-${index}`,
        content: {
          schema: "pi-workflows.workflow-message-content.v1",
          customType: `test-${kind}`,
          content: `filter message ${index}`,
          display: false,
          details: { note: `${index}` },
          triggerTurn: kind === "step" || kind === "followUp",
        },
        now,
      });
    const deliver = (messageId: string, now: number = Date.now()) =>
      serverState.workflowMessages.adoptBranch(
        sessionId,
        [{ workflowMessageId: messageId, piSessionEntryId: `entry-${messageId}` }],
        new Set([messageId]),
        now,
      );
    const request = (requestId: string) =>
      serverState.createInteractiveRequest({
        requestId,
        runId,
        attemptId,
        targetSessionId: sessionId,
        kind: "agent",
        contract: {
          prompt: "Continue",
          contract: {
            requestId,
            runId,
            workflowName: workflow.name,
            nodeId: "reply",
            attemptId,
            completion: "submit",
          },
        },
      });
    const countRowsRead = () => {
      const original = serverState.workflowMessages.listSessionSummaryBatch.bind(
        serverState.workflowMessages,
      );
      const rows = { count: 0, batches: 0 };
      const spy = vi
        .spyOn(serverState.workflowMessages, "listSessionSummaryBatch")
        .mockImplementation((targetSessionId, options) => {
          const batch = original(targetSessionId, options);
          rows.count += batch.length;
          rows.batches += 1;
          return batch;
        });
      return { rows, restore: () => spy.mockRestore() };
    };
    const base = 1_700_000_000_000;
    const liveId = () => {
      const message = serverState.workflowMessages.latestForSource("step", "filter-source-live");
      if (message === undefined) throw new Error("live step message missing");
      return message.workflowMessageId;
    };
    // A pending step waits for the model, and a neighbour without a request cannot.
    request("filter-source-live");
    const liveMessageId = liveId();
    for (let index = 1; index <= 200; index += 1) create(index, "step", base + index);
    let probe = countRowsRead();
    let selected = views.currentWorkflowMessage(sessionId);
    expect(selected?.workflowMessageId).toBe(liveMessageId);
    expect(probe.rows.count).toBeLessThanOrEqual(32);
    probe.restore();
    // A delivered follow-up that no turn has picked up still needs a model turn,
    // and a delivered notification never does.
    state.connection
      .prepare(
        `UPDATE interactive_requests SET status = 'cancelled', accepted_submission_id = NULL,
           settled_at = NULL, revision = revision + 1 WHERE request_id = ?`,
      )
      .run("filter-source-live");
    const followUpId = create(300, "followUp", base + 300).workflowMessageId;
    deliver(followUpId);
    for (let index = 1; index <= 200; index += 1) {
      deliver(create(400 + index, "notification", base + 400 + index).workflowMessageId);
    }
    probe = countRowsRead();
    selected = views.currentWorkflowMessage(sessionId);
    expect(selected?.workflowMessageId).toBe(followUpId);
    expect(probe.rows.count).toBeLessThanOrEqual(32);
    probe.restore();
    // A cancelled step that Pi still holds stays current, and a delivered step whose
    // request is still pending does not come back through this path.
    const followUpTurn = serverState.workflowMessages.startTurn({
      workflowMessageId: followUpId,
      runId,
      targetSessionId: sessionId,
    });
    serverState.workflowMessages.endTurn({
      workflowMessageId: followUpId,
      workflowTurnId: followUpTurn.workflowTurnId,
      runId,
      targetSessionId: sessionId,
      stopReason: "completed",
    });
    deliver(liveMessageId);
    probe = countRowsRead();
    selected = views.currentWorkflowMessage(sessionId);
    expect(selected?.workflowMessageId).toBe(liveMessageId);
    expect(probe.rows.count).toBeLessThanOrEqual(32);
    probe.restore();
    // Once Pi reports the turn for that step, only the retention window can still
    // keep a terminal message current.
    serverState.workflowMessages.startTurn({
      workflowMessageId: liveMessageId,
      runId,
      targetSessionId: sessionId,
    });
    const liveTurn = serverState.workflowMessages.openTurnForMessage(liveMessageId);
    if (liveTurn === undefined) throw new Error("live turn missing");
    serverState.workflowMessages.endTurn({
      workflowMessageId: liveMessageId,
      workflowTurnId: liveTurn.workflowTurnId,
      runId,
      targetSessionId: sessionId,
      stopReason: "completed",
    }); // A terminal message inside the retention window stays current even when older
    // ones outside it sit above it in durable order.
    const recent = Date.now();
    state.connection
      .prepare("UPDATE runs SET status = 'completed', finished_at = ? WHERE run_id = ?")
      .run(recent, runId);
    for (let index = 1; index <= 200; index += 1) {
      const old = recent - 3_600_000 - index;
      deliver(create(800 + index, "terminal", old).workflowMessageId, old);
    }
    const retainedId = create(1_200, "terminal", recent).workflowMessageId;
    deliver(retainedId, recent);
    for (let index = 1; index <= 200; index += 1) {
      const old = recent - 7_200_000 - index;
      deliver(create(1_300 + index, "terminal", old).workflowMessageId, old);
    }
    probe = countRowsRead();
    selected = views.currentWorkflowMessage(sessionId);
    // The retained terminal message keeps its run current, and the walk reaches the
    // window in one batch instead of reading the terminals outside it.
    expect(selected?.runId).toBe(runId);
    expect(selected?.kind).toBe("terminal");
    expect(probe.rows.count).toBeLessThanOrEqual(32);
    probe.restore();
    // The retention window closes with the clock and not with a stored write, so a
    // held selection is not reused past it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(recent + 60_000 + 1_000);
    expect(views.currentWorkflowMessage(sessionId)).toBeUndefined();
    vi.useRealTimers();
    state.close();
  }, 120_000);

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

  it("bounds every free-form session field so one frame still fits", async () => {
    const projectPath = await makeTempDir("bounded-fields-project");
    const databasePath = path.join(await makeTempDir("bounded-fields-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // Values far larger than one client frame, from the workflow name and run
    // title, a node output, and the failure the run reports.
    const longText = "x".repeat(64 * 1024);
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: `bounded${longText}`,
        title: longText,
        startAt: "estimate",
        nodes: {
          estimate: compute({
            run: () => ({ schema: "pi-workflows.test-output.v1", value: longText }),
          }),
          fail: compute({
            run: () => {
              throw new Error(longText);
            },
          }),
        },
        edges: [{ from: "estimate", to: "fail" }],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-bounded-fields";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:bounded-fields",
      workflowSource: {
        root: { kind: "builtin", id: "bounded-fields", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "bounded-fields",
      claimToken: "claim-bounded-fields",
      leaseMs: 60_000,
      originSessionId: "session-bounded-fields",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-bounded-fields"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      workflow,
      {},
      { runId },
    );
    // Keep the finished run visible to its origin session.
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const view = views.session("session-bounded-fields", null);
    const run = view.run;
    if (run === null) throw new Error("session run missing");
    const complete = runs.readRunState(runId);
    if (complete === null) throw new Error("run state missing");
    // Every free-form field is bounded, and each bound keeps the beginning of
    // the complete value the detailed view still carries.
    expect(run.workflowName).toHaveLength(SESSION_TEXT_LIMIT);
    expect(run.workflowName).toBe(workflow.name.slice(0, SESSION_TEXT_LIMIT));
    expect(run.runTitle).toBe(longText.slice(0, SESSION_TEXT_LIMIT));
    expect(run.error).not.toBeNull();
    expect(run.error?.length).toBeLessThanOrEqual(SESSION_TEXT_LIMIT);
    expect(complete.error?.startsWith(run.error ?? "")).toBe(true);
    // A detail too large for the compact view is absent, never a cut value.
    expect(run.monitorEstimate).toBeNull();
    expect(complete.outputs.estimate).toMatchObject({ value: longText });
    // The whole projection still travels in one client frame with room to spare.
    const encoded = Buffer.byteLength(canonicalJson(view), "utf8");
    expect(encoded).toBeGreaterThan(0);
    expect(encoded).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES / 4);
    state.close();
  }, 60_000);

  it("keeps one progress record per key however often one key publishes", async () => {
    const projectPath = await makeTempDir("progress-keys-project");
    const databasePath = path.join(await makeTempDir("progress-keys-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const hotCount = 20;
    const otherKeys = ["a", "b", "c", "d", "e"];
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "progress-keys",
        startAt: "work",
        nodes: {
          work: action({
            effect: idempotentEffect("test.progress-keys"),
            run: async ({ publishUpdate }) => {
              for (const key of otherKeys) {
                await publishUpdate({
                  type: "progress",
                  key,
                  data: {
                    schema: "pi-workflows.progress.v1",
                    status: "running",
                    completed: 1,
                    total: 2,
                    unit: "items",
                  },
                });
              }
              for (let index = 0; index < hotCount; index += 1) {
                await publishUpdate({
                  type: "progress",
                  key: "hot",
                  data: {
                    schema: "pi-workflows.progress.v1",
                    status: "running",
                    completed: index,
                    total: hotCount,
                    unit: "items",
                  },
                });
              }
              // A monitor schedules its next check once per cycle under one key.
              for (const everyMinutes of [5, 60]) {
                await publishUpdate({
                  type: "monitor.schedule",
                  key: "next-check",
                  data: {
                    schema: "pi-workflows.monitor-schedule.v1",
                    lastCheckAt: "2026-01-01T00:00:00.000Z",
                    nextCheckAt: `2026-01-01T0${everyMinutes === 5 ? 1 : 2}:00:00.000Z`,
                    everyMinutes,
                  },
                });
              }
              // An update key is pattern-bounded to 128 ASCII characters, and the widest
              // legal key still travels in the compact view in full.
              await publishUpdate({
                type: "progress",
                key: `k${"k".repeat(127)}`,
                data: {
                  schema: "pi-workflows.progress.v1",
                  status: "running",
                  completed: 1,
                  total: 2,
                  unit: "items",
                },
              });
              // The newest monitor schedule carries an instant no bounded frame can hold.
              await publishUpdate({
                type: "monitor.schedule",
                key: "next-check",
                data: {
                  schema: "pi-workflows.monitor-schedule.v1",
                  lastCheckAt: "2026-01-01T00:00:00.000Z",
                  nextCheckAt: `2026-01-01T03:00:00.000Z${"x".repeat(SESSION_TEXT_LIMIT)}`,
                  everyMinutes: 60,
                },
              });
              return "done";
            },
          }),
        },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-progress-keys";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:progress-keys",
      workflowSource: {
        root: { kind: "builtin", id: "progress-keys", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "progress-keys",
      claimToken: "claim-progress-keys",
      leaseMs: 60_000,
      originSessionId: "session-progress-keys",
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-progress-keys"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      workflow,
      {},
      { runId },
    );
    // Keep the finished run visible to its origin session.
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const run = views.session("session-progress-keys", null).run;
    if (run === null) throw new Error("session run missing");
    // A hot key cannot hide the other tracks: the projection carries the latest
    // record of every key, so one key's many updates replace only its own.
    expect(run.progressUpdates.map((update) => update.key)).toEqual([
      ...otherKeys,
      "hot",
      `k${"k".repeat(127)}`,
    ]);
    expect(run.progressUpdates.at(-1)?.data).toMatchObject({
      completed: 1,
      total: 2,
    });
    // A later monitor cycle replaces its own next-check record, so the projection
    // carries the newest schedule and never an earlier one. The newest schedule names
    // an instant no bounded frame can hold, so it is left out and not cut.
    expect(run.monitorSchedule).toBeNull();
    // The widest legal key travels in full, and the whole projection still travels in
    // one client frame.
    expect(run.progressUpdates.at(-1)?.key).toBe(`k${"k".repeat(127)}`);
    expect(
      Buffer.byteLength(canonicalJson(views.session("session-progress-keys", null)), "utf8"),
    ).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES);
    // The complete schedule record stays stored, so the update page can still carry it.
    expect(
      state.connection
        .prepare(
          `SELECT count(*) AS count FROM workflow_updates u
           JOIN node_attempts a ON a.attempt_id = u.attempt_id
           WHERE a.run_id = ? AND u.update_type = 'monitor.schedule' AND u.update_key = 'next-check'`,
        )
        .get(runId),
    ).toEqual({ count: 3 });
    state.close();
  }, 60_000);

  it("reads the newest progress keys when a run publishes many tracks", async () => {
    const projectPath = await makeTempDir("many-tracks-project");
    const databasePath = path.join(await makeTempDir("many-tracks-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // More tracks than one view page holds, so the head of the update set is far
    // behind the newest keys.
    const trackCount = 300;
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "many-tracks",
        startAt: "work",
        nodes: { work: compute({ run: () => "done" }) },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-many-tracks";
    const sessionId = "session-many-tracks";
    const attemptId = "many-tracks-attempt";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:many-tracks",
      workflowSource: {
        root: { kind: "builtin", id: "many-tracks", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "many-tracks",
      claimToken: "claim-many-tracks",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    state.connection
      .prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    state.connection
      .prepare(
        `INSERT INTO node_attempts(attempt_id, run_id, node_id, attempt_number, node_type, status,
         started_at, created_at, updated_at) VALUES (?, ?, 'work', 1, 'compute', 'running', 1000, 1000, 1000)`,
      )
      .run(attemptId, runId);
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-many-tracks"),
    });
    // The schedule arrives before every track, so a page of the update head would
    // miss it as well.
    runs.publishUpdateSynchronous(runId, "work", attemptId, {
      type: "monitor.schedule",
      key: "next-check",
      data: {
        schema: "pi-workflows.monitor-schedule.v1",
        lastCheckAt: "2026-01-01T00:00:00.000Z",
        nextCheckAt: "2026-01-01T01:00:00.000Z",
        everyMinutes: 60,
      },
    });
    for (let index = 0; index < trackCount; index += 1) {
      runs.publishUpdateSynchronous(runId, "work", attemptId, {
        type: "progress",
        key: `track-${String(index).padStart(3, "0")}`,
        data: {
          schema: "pi-workflows.progress.v1",
          status: "running",
          completed: index,
          total: trackCount,
          unit: "items",
        },
      });
    }
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const run = views.session(sessionId, null).run;
    if (run === null) throw new Error("session run missing");
    // The compact run carries the newest tracks, not the oldest page of them.
    const newest = Array.from(
      { length: 16 },
      (_, index) => `track-${String(trackCount - 16 + index).padStart(3, "0")}`,
    );
    expect(run.progressUpdates.map((update) => update.key)).toEqual(newest);
    // A schedule published before every track stays visible.
    expect(run.monitorSchedule?.nextCheckAt).toBe("2026-01-01T01:00:00.000Z");
    state.close();
  }, 60_000);

  it.each([
    {
      placement: "first",
      expectStart: 1,
      expectIds: ["node-000", "node-001", "node-002"],
      expectLast: "node-002",
    },
    // A row in the middle stops the window before it, so the rows that arrived
    // stay contiguous and the next cursor is exact.
    { placement: "middle", expectStart: 0, expectIds: ["aaa"], expectLast: "zzz" },
  ])(
    "leaves out a node row that cannot fit the frame by itself: $placement",
    async ({ placement, expectStart, expectIds, expectLast }) => {
      const projectPath = await makeTempDir(`node-huge-project-${placement}`);
      const databasePath = path.join(
        await makeTempDir(`node-huge-state-${placement}`),
        "state.sqlite",
      );
      const state = new StateDatabase({ filePath: databasePath });
      const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
      const serverState = new ServerStateStore(databasePath, { state });
      // A stored definition can hold a node identity above the load limit, because
      // the limit arrived after that state was written. The window leaves such a row
      // out, and the load limit keeps a new definition from adding one.
      const hugeId = `m${"x".repeat(200 * 1024)}`;
      const nodeIds =
        placement === "first"
          ? [hugeId, "node-000", "node-001", "node-002"]
          : ["aaa", hugeId, "zzz"];
      const startAt = placement === "first" ? hugeId : "aaa";
      const compiledIds = nodeIds.map((nodeId) => (nodeId === hugeId ? "huge" : nodeId));
      const workflow = compileWorkflowDefinition(
        defineWorkflow({
          name: "node-huge-row",
          startAt: startAt === hugeId ? "huge" : startAt,
          nodes: Object.fromEntries(
            compiledIds.map((nodeId, index) => [nodeId, compute({ run: () => index })]),
          ),
          edges: compiledIds.slice(1).map((nodeId, index) => ({
            from: compiledIds[index] ?? "huge",
            to: nodeId,
          })),
        }),
      );
      const snapshot = createDefinitionSnapshot(workflow);
      renameSnapshotNode(snapshot, "huge", hugeId);
      const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
      const runId = `run-node-huge-row-${placement}`;
      const sessionId = `session-node-huge-row-${placement}`;
      claimTestRun(queue, {
        runId,
        workflowName: workflow.name,
        workflowSourceRef: "builtin:node-huge-row",
        workflowSource: {
          root: { kind: "builtin", id: "node-huge-row", revision: "test" },
          mounted: [],
        },
        definitionDigest,
        definitionSnapshot: snapshot,
        input: {},
        runnerId: "node-huge-row",
        claimToken: `claim-node-huge-row-${placement}`,
        leaseMs: 60_000,
        originSessionId: sessionId,
      });
      const runs = new WorkflowRunStore(databasePath, {
        state,
        authorityProvider: () =>
          queue.workflowRunAuthority(runId, `claim-node-huge-row-${placement}`),
      });
      // The run is claimed but never started, so the default window follows the
      // last row with a lead, which keeps the huge row inside the window.
      const views = new ServerViewStore(
        state,
        queue,
        serverState,
        runs,
        () => false,
        () => false,
      );
      const view = views.session(sessionId, null);
      const run = view.run;
      if (run === null) throw new Error("session run missing");
      expect(run.nodeTotal).toBe(nodeIds.length);
      // The window starts after a row it cannot carry, or stops before it.
      expect(run.nodeStart).toBe(expectStart);
      expect(run.nodes.map((row) => row.nodeId)).toEqual(expectIds);
      expect(Buffer.byteLength(canonicalJson(run.nodes), "utf8")).toBeLessThan(64 * 1024);
      const encoded = Buffer.byteLength(canonicalJson(view), "utf8");
      expect(encoded).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES / 4);
      // A later window skips the row it cannot carry and reaches the rest.
      const next = views.session(sessionId, null, expectStart + expectIds.length).run;
      expect(next?.nodes.some((row) => row.nodeId === hugeId)).toBe(false);
      expect(next?.nodes.at(-1)?.nodeId).toBe(expectLast);
      state.close();
    },
    60_000,
  );

  it("keeps the detailed run view inside one frame when a node identity fills the limit", async () => {
    const projectPath = await makeTempDir("node-id-limit-project");
    const databasePath = path.join(await makeTempDir("node-id-limit-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // The load limit admits a node identity that fills it, and the detailed run
    // view must still fit one client frame, because the step row and the taken
    // transition carry that identity in full.
    const nodeId = `n${"x".repeat(NODE_ID_MAX_BYTES - 1)}`;
    expect(Buffer.byteLength(nodeId, "utf8")).toBe(NODE_ID_MAX_BYTES);
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "node-id-limit",
        startAt: nodeId,
        nodes: { [nodeId]: compute({ run: () => 1 }) },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-node-id-limit";
    const sessionId = "session-node-id-limit";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:node-id-limit",
      workflowSource: {
        root: { kind: "builtin", id: "node-id-limit", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "node-id-limit",
      claimToken: "claim-node-id-limit",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-node-id-limit"),
    });
    await new WorkflowEngine({ store: runs, executor: new ScriptedExecutor() }).run(
      workflow,
      {},
      { runId },
    );
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const view = views.run(runId);
    if (view === null) throw new Error("run view missing");
    expect(view.state).not.toBeNull();
    const runState = view.state as unknown as { steps: Array<{ nodeId: string }> };
    expect(runState.steps[0]?.nodeId).toBe(nodeId);
    const encoded = encodeProtocolLine({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "node-id-limit-request",
      outcome: "accepted",
      receipt: view as unknown as never,
    });
    expect(encoded.byteLength).toBeLessThan(MAX_PROTOCOL_MESSAGE_BYTES);
    state.close();
  }, 60_000);

  it("leaves out a node identity that cannot fit the frame", async () => {
    const projectPath = await makeTempDir("node-huge-scalar-project");
    const databasePath = path.join(await makeTempDir("node-huge-scalar-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // A stored definition can hold a node identity above the load limit, because
    // the limit arrived after that state was written. The window leaves such a row
    // out, and the run facts leave the identity out for the same reason, so no
    // unbounded scalar reaches the client.
    const hugeId = `m${"x".repeat(200 * 1024)}`;
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: "node-huge-scalar",
        startAt: "huge",
        nodes: { huge: compute({ run: () => 0 }) },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    renameSnapshotNode(snapshot, "huge", hugeId);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-node-huge-scalar";
    const sessionId = "session-node-huge-scalar";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:node-huge-scalar",
      workflowSource: {
        root: { kind: "builtin", id: "node-huge-scalar", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "node-huge-scalar",
      claimToken: "claim-node-huge-scalar",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-node-huge-scalar"),
    });
    // A pending attempt makes the run report the node as the one it works on.
    state.connection
      .prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    state.connection
      .prepare(
        `INSERT INTO node_attempts
           (attempt_id, run_id, node_id, attempt_number, node_type, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'compute', 'pending', NULL, 1000, 1000)`,
      )
      .run(`attempt-${runId}`, runId, hugeId);
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const view = views.session(sessionId, null);
    const run = view.run;
    if (run === null) throw new Error("session run missing");
    expect(run.currentNode).toBeNull();
    expect(run.waitingOn).toBeNull();
    // The complete row count stays correct, and the identity is reachable in the
    // detailed run view.
    expect(run.nodeTotal).toBe(1);
    expect(run.nodes).toEqual([]);
    expect(Buffer.byteLength(canonicalJson(view), "utf8")).toBeLessThan(
      MAX_PROTOCOL_MESSAGE_BYTES / 4,
    );
    state.close();
  });

  it("cuts bounded session text at a complete character", async () => {
    const projectPath = await makeTempDir("session-text-project");
    const databasePath = path.join(await makeTempDir("session-text-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    // A workflow name has no length limit, and the cut falls inside the last
    // character, so the bound must not leave a replacement character behind.
    const workflowName = `${"x".repeat(4 * 1024 - 1)}\u{1f642}more`;
    const workflow = compileWorkflowDefinition(
      defineWorkflow({
        name: workflowName,
        startAt: "only",
        nodes: { only: compute({ run: () => 0 }) },
        edges: [],
      }),
    );
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-session-text";
    const sessionId = "session-session-text";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:session-text",
      workflowSource: {
        root: { kind: "builtin", id: "session-text", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "session-text",
      claimToken: "claim-session-text",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-session-text"),
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const run = views.session(sessionId, null).run;
    if (run === null) throw new Error("session run missing");
    expect(run.workflowName).toBe("x".repeat(4 * 1024 - 1));
    expect(run.workflowName).not.toContain("\uFFFD");
    expect(Buffer.byteLength(run.workflowName, "utf8")).toBeLessThanOrEqual(4 * 1024);
    state.close();
  });

  it("reports a node whose leftover unfinished attempt was superseded", async () => {
    const projectPath = await makeTempDir("superseded-project");
    const databasePath = path.join(await makeTempDir("superseded-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-superseded-attempt";
    const sessionId = "session-superseded-attempt";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: { task: "superseded" },
      runnerId: "superseded",
      claimToken: "claim-superseded",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    // A crash can leave an unfinished attempt row behind while a later attempt of
    // the same node succeeds. The node then reports its newest attempt.
    state.connection
      .prepare(
        `INSERT INTO node_attempts(attempt_id, run_id, node_id, attempt_number, node_type, status,
         started_at, finished_at, created_at, updated_at) VALUES
         ('superseded-stale', ?, 'reply', 1, 'agent', 'running', 1000, NULL, 1000, 1000),
         ('superseded-done', ?, 'reply', 2, 'agent', 'completed', 2000, 2100, 2000, 2100)`,
      )
      .run(runId, runId);
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-superseded"),
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const run = views.session(sessionId, null).run;
    if (run === null) throw new Error("session run missing");
    const reply = run.nodes.find((row) => row.nodeId === "reply");
    expect(reply?.attempts).toBe(2);
    expect(reply?.state).toBe("ok");
    expect(reply?.startedAt).toBeNull();
    state.close();
  }, 60_000);

  it("keeps a cancelled step current until Pi confirms its delivery", async () => {
    const projectPath = await makeTempDir("cancelled-delivery-project");
    const databasePath = path.join(await makeTempDir("cancelled-delivery-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = compileWorkflowDefinition(rawWorkflow);
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-cancelled-delivery";
    const sessionId = "session-cancelled-delivery";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:echo",
      workflowSource: {
        root: { kind: "builtin", id: "echo", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: { task: "cancelled" },
      runnerId: "cancelled-delivery",
      claimToken: "claim-cancelled-delivery",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-cancelled-delivery"),
    });
    const result = await new WorkflowEngine({
      store: runs,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "cancelled" } }),
    }).run(workflow, { task: "cancelled" }, { runId });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");
    state.connection
      .prepare("UPDATE runs SET status = 'waiting', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    state.connection
      .prepare("UPDATE run_queue SET status = 'parked', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    const requestId = "cancelled-delivery-source";
    serverState.createInteractiveRequest({
      requestId,
      runId,
      attemptId,
      targetSessionId: sessionId,
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          requestId,
          runId,
          workflowName: workflow.name,
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    const pending = serverState.workflowMessages.latestForSource("step", requestId);
    if (pending === undefined) throw new Error("step message missing");
    // Pi delivered the message, which the branch report records without a turn.
    serverState.workflowMessages.adoptBranch(
      sessionId,
      [{ workflowMessageId: pending.workflowMessageId, piSessionEntryId: "entry-cancelled" }],
      new Set([pending.workflowMessageId]),
    );
    // The run is cancelled while Pi has not reported the turn yet.
    state.connection
      .prepare(
        "UPDATE interactive_requests SET status = 'cancelled', revision = revision + 1 WHERE request_id = ?",
      )
      .run(requestId);
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    // The cancelled step stays current, because the extension must still learn
    // that its delivered turn is cancelled and stop it.
    const cancelled = views.session(sessionId, null).workflowMessage;
    expect(cancelled?.workflowMessageId).toBe(pending.workflowMessageId);
    expect(cancelled?.deliveryCancelled).toBe(true);
    // Once Pi reports the turn, the delivery is reconciled.
    const turn = serverState.workflowMessages.startTurn({
      workflowMessageId: pending.workflowMessageId,
      runId,
      targetSessionId: sessionId,
    });
    expect(views.session(sessionId, null).workflowMessage?.workflowMessageId).toBe(
      pending.workflowMessageId,
    );
    serverState.workflowMessages.endTurn({
      workflowMessageId: pending.workflowMessageId,
      workflowTurnId: turn.workflowTurnId,
      runId,
      targetSessionId: sessionId,
      stopReason: "completed",
      responseSessionEntryId: "entry-cancelled-reply",
    });
    expect(views.session(sessionId, null).workflowMessage).toBeNull();
    state.close();
  }, 60_000);

  it("drops a cancelled step that Pi never received", async () => {
    const fixture = await pendingStepFixture("cancelled-unreceived");
    // The run is cancelled before Pi has the step message on its branch.
    fixture.state.connection
      .prepare(
        "UPDATE interactive_requests SET status = 'cancelled', revision = revision + 1 WHERE request_id = ?",
      )
      .run(fixture.requestId);
    // A message Pi never received cannot need stopping, and it must not become
    // deliverable again, so it stays out of the current message.
    expect(fixture.pending.status).toBe("pending");
    expect(fixture.views.session(fixture.sessionId, null).workflowMessage).toBeNull();
    fixture.state.close();
  }, 60_000);

  it("re-reads the session view when only the selected message changes", async () => {
    const fixture = await pendingStepFixture("selected-message-cache");
    // This session holds no live or retained run, so the run is not part of the
    // cache key and the selected message alone must invalidate the view.
    fixture.state.connection
      .prepare("UPDATE run_queue SET status = 'cancelled' WHERE run_id = ?")
      .run(fixture.runId);
    expect(fixture.views.session(fixture.sessionId, null).workflowMessage?.status).toBe("pending");
    // The status changes in the same millisecond, so the aggregate facts of the
    // session stay equal while the selected message changes.
    fixture.state.connection
      .prepare("UPDATE workflow_messages SET status = 'cancelled' WHERE workflow_message_id = ?")
      .run(fixture.pending.workflowMessageId);
    expect(fixture.views.session(fixture.sessionId, null).workflowMessage).toBeNull();
    fixture.state.close();
  }, 60_000);

  it("carries the action subtype and the current node for a pending attempt", async () => {
    const projectPath = await makeTempDir("action-subtype-project");
    const databasePath = path.join(await makeTempDir("action-subtype-state"), "state.sqlite");
    const state = new StateDatabase({ filePath: databasePath });
    const queue = new WorkflowRunQueueStore(databasePath, { state, projectPath });
    const serverState = new ServerStateStore(databasePath, { state });
    const workflow = defineWorkflow({
      name: "actions",
      startAt: "build",
      edges: [],
      nodes: {
        build: action({
          effect: idempotentEffect("test.action-subtype"),
          exec: () => ({ command: "true" }),
        }),
        check: action({
          effect: idempotentEffect("test.action-subtype-function"),
          run: () => ({ ok: true }),
        }),
      },
    });
    const snapshot = createDefinitionSnapshot(workflow);
    const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
    const runId = "run-action-subtype";
    const sessionId = "session-action-subtype";
    claimTestRun(queue, {
      runId,
      workflowName: workflow.name,
      workflowSourceRef: "builtin:actions",
      workflowSource: {
        root: { kind: "builtin", id: "actions", revision: "test" },
        mounted: [],
      },
      definitionDigest,
      definitionSnapshot: snapshot,
      input: {},
      runnerId: "action-subtype",
      claimToken: "claim-action-subtype",
      leaseMs: 60_000,
      originSessionId: sessionId,
    });
    state.connection
      .prepare("UPDATE runs SET status = 'running', finished_at = NULL WHERE run_id = ?")
      .run(runId);
    // The runner handoff: the run is running while its attempt is still pending.
    state.connection
      .prepare(
        `INSERT INTO node_attempts(attempt_id, run_id, node_id, attempt_number, node_type, status,
         started_at, created_at, updated_at) VALUES (?, ?, 'build', 1, 'action', 'pending', NULL, 1000, 1000)`,
      )
      .run("action-subtype-attempt", runId);
    const runs = new WorkflowRunStore(databasePath, {
      state,
      authorityProvider: () => queue.workflowRunAuthority(runId, "claim-action-subtype"),
    });
    const views = new ServerViewStore(
      state,
      queue,
      serverState,
      runs,
      () => false,
      () => false,
    );
    const run = views.session(sessionId, null).run;
    // The compact row keeps the subtype, because the widget renders a shell with
    // its own glyph, and the run fact names the node that a pending attempt owns.
    expect(run?.currentNode).toBe("build");
    const rows = new Map((run?.nodes ?? []).map((row) => [row.nodeId, row]));
    expect(rows.get("build")).toMatchObject({ actionExecution: "shell", state: "pending" });
    expect(rows.get("check")?.actionExecution).toBe("function");
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
