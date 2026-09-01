import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { ORIGIN_ACTIVITY_LEASE_MS } from "../src/client/activity.js";
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
