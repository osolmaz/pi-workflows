import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import {
  encodeProtocolLine,
  ClientProtocolError,
  MAX_PROTOCOL_MESSAGE_BYTES,
  NdjsonFrameDecoder,
  parseClientRequest,
  type ClientRequest,
} from "../src/client/protocol.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import { ServerStateStore, type WorkflowRunnerLaunchEnvelope } from "../src/server/state.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const workflow = compileWorkflowDefinition(rawWorkflow);
const snapshot = createDefinitionSnapshot(workflow);
const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

function request(overrides: Partial<ClientRequest> = {}): ClientRequest {
  return {
    schema: "pi-workflows.client.v1",
    type: "request",
    requestId: "request-1",
    clientId: "client-1",
    operation: "server.status",
    idempotencyKey: "status-1",
    payload: {},
    ...overrides,
  };
}

async function fixture() {
  const projectPath = await makeTempDir("host-state-project");
  const databasePath = path.join(await makeTempDir("host-state-db"), "state.sqlite");
  const queue = new SqliteResourceManagerStore(databasePath, { projectPath });
  return { projectPath, databasePath, queue, server: new ServerStateStore(databasePath) };
}

function reserve(queue: SqliteResourceManagerStore, runId = "run-1") {
  return queue.enqueueWorkflowRun({
    runId,
    workflowName: workflow.name,
    workflowSourceRef: "builtin:echo",
    workflowSource: { kind: "builtin", id: "echo", revision: "test" },
    definitionDigest,
    definitionSnapshot: snapshot,
    input: {},
    runnerId: "host-test",
    claimToken: "claim-token",
    leaseMs: 60_000,
    originSessionId: "session-1",
  });
}

describe("server protocol", () => {
  it("round-trips canonical NDJSON and rejects noncanonical input", () => {
    const encoded = encodeProtocolLine(request());
    expect(encoded.at(-1)).toBe(0x0a);
    expect(parseClientRequest(encoded.subarray(0, -1))).toEqual(request());
    expect(() =>
      parseClientRequest('{"schema":"pi-workflows.client.v1", "requestId":"request-1"}'),
    ).toThrow(ClientProtocolError);
  });

  it("bounds frames and keeps complete messages", () => {
    const decoder = new NdjsonFrameDecoder();
    expect(decoder.push(Buffer.from("one\ntwo\n"))).toEqual([
      Buffer.from("one"),
      Buffer.from("two"),
    ]);
    expect(() =>
      new NdjsonFrameDecoder().push(Buffer.alloc(MAX_PROTOCOL_MESSAGE_BYTES + 1, 0x61)),
    ).toThrow(/exceeds 1 MiB/);
  });
});

describe("server durable state", () => {
  it("fences server epochs and never revives an expired server", async () => {
    const { server, queue } = await fixture();
    const first = server.acquireServer({
      serverId: "host-1",
      pid: 100,
      processStartIdentity: "start-1",
      leaseMs: 1_000,
      now: 1_000,
    });
    expect(first.epoch).toBe(1);
    expect(() =>
      server.acquireServer({
        serverId: "host-2",
        pid: 200,
        processStartIdentity: "start-2",
        leaseMs: 1_000,
        now: 1_500,
      }),
    ).toThrow(/live Pi Workflows server/);
    const second = server.acquireServer({
      serverId: "host-2",
      pid: 200,
      processStartIdentity: "start-2",
      leaseMs: 1_000,
      now: 2_001,
    });
    expect(second.epoch).toBe(2);
    expect(() => server.renewServer(first, 1_000, 2_100)).toThrow(/claim lost/);
    expect(server.renewServer(second, 1_000, 2_100).expiresAt).toBe(3_100);
    expect(server.releaseServer(first, 2_200)).toBe(false);
    expect(server.releaseServer(second, 2_200)).toBe(true);
    server.close();
    queue.close();
  });

  it("stores command receipts and rejects request identity reuse", async () => {
    const { server, queue } = await fixture();
    let calls = 0;
    const execute = () => {
      calls += 1;
      return { outcome: "accepted" as const, receipt: { live: true } };
    };
    expect(server.executeCommand(request(), 1, execute)).toMatchObject({
      outcome: "accepted",
      receipt: { live: true },
    });
    expect(server.executeCommand(request(), 1, execute)).toMatchObject({
      outcome: "adopted",
      receipt: { live: true },
    });
    expect(server.executeCommand(request({ requestId: "request-2" }), 1, execute)).toMatchObject({
      requestId: "request-2",
      outcome: "adopted",
      receipt: { live: true },
    });
    expect(calls).toBe(1);
    expect(
      server.executeCommand(request({ payload: { changed: true } }), 1, execute),
    ).toMatchObject({
      outcome: "conflict",
    });
    expect(calls).toBe(1);

    let rejectedCalls = 0;
    const rejected = () => {
      rejectedCalls += 1;
      return { outcome: "rejected" as const, error: "invalid request" };
    };
    expect(
      server.executeCommand(
        request({ requestId: "rejected-1", idempotencyKey: "rejected" }),
        1,
        rejected,
      ),
    ).toMatchObject({ outcome: "rejected", error: "invalid request" });
    expect(
      server.executeCommand(
        request({ requestId: "rejected-2", idempotencyKey: "rejected" }),
        1,
        rejected,
      ),
    ).toMatchObject({ outcome: "rejected", error: "invalid request" });
    expect(rejectedCalls).toBe(1);
    server.close();
    queue.close();
  });

  it("records runner epochs and durable interaction submissions", async () => {
    const { server, queue, databasePath, projectPath } = await fixture();
    reserve(queue);
    const runStore = new WorkflowRunStore(databasePath, {
      authorityProvider: () => queue.workflowRunAuthority("run-1", "claim-token"),
    });
    const result = await new WorkflowEngine({
      store: runStore,
      executor: new ScriptedExecutor().respond("reply", { output: { reply: "ok" } }),
    }).run(workflow, {}, { runId: "run-1" });
    const attemptId = result.state.steps[0]?.attemptId;
    if (attemptId === undefined) throw new Error("attempt missing");

    const envelope: WorkflowRunnerLaunchEnvelope = {
      schema: "pi-workflows.worker-launch.v1",
      runId: "run-1",
      generation: 1,
      runnerEpoch: "worker-1",
      projectPath,
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest: `sha256:${definitionDigest}`,
      inputHash: "sha256:input",
      protocolVersion: 1,
    };
    server.recordRunnerStart(envelope, 1);
    expect(() =>
      server.recordRunnerStart({ ...envelope, runnerEpoch: "worker-duplicate" }, 1),
    ).toThrow(/UNIQUE constraint/);
    server.attachRunnerProcess("worker-1", 123, "start-123");
    server.markRunnerReady("worker-1");
    server.finishRunner({ runnerEpoch: "worker-1", outcome: "exited", exitCode: 0 });

    const interaction = server.createInteractiveRequest({
      requestId: "interaction-1",
      runId: "run-1",
      attemptId,
      targetSessionId: "session-1",
      kind: "agent",
      contract: {
        prompt: "Continue",
        contract: {
          runId: "run-1",
          workflowName: "echo",
          nodeId: "reply",
          attemptId,
          completion: "submit",
        },
      },
    });
    expect(server.listPendingInteractions("session-1")).toHaveLength(1);
    const message = server.workflowMessages.listSession("session-1")[0];
    if (message === undefined) throw new Error("workflow message missing");
    expect(message).toMatchObject({
      kind: "step",
      sourceId: interaction.requestId,
      status: "pending",
    });
    expect(
      server.workflowMessages.adoptBranch(
        "session-1",
        [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-1" }],
        new Set([message.workflowMessageId]),
      )[0],
    ).toMatchObject({ status: "sent", piSessionEntryId: "entry-1" });
    expect(() =>
      server.workflowMessages.adoptBranch(
        "session-1",
        [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-other" }],
        new Set([message.workflowMessageId]),
      ),
    ).toThrow(/conflicting Pi session entry evidence/);
    const turn = server.workflowMessages.startTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "turn-1",
      runId: interaction.runId,
      targetSessionId: interaction.targetSessionId,
    });
    expect(
      server.workflowMessages.startTurn({
        workflowMessageId: message.workflowMessageId,
        workflowTurnId: "turn-1",
        runId: interaction.runId,
        targetSessionId: interaction.targetSessionId,
      }),
    ).toEqual(turn);
    expect(() =>
      server.workflowMessages.startTurn({
        workflowMessageId: message.workflowMessageId,
        workflowTurnId: "turn-conflict",
        runId: interaction.runId,
        targetSessionId: interaction.targetSessionId,
      }),
    ).toThrow(/already has open turn turn-1/);
    server.workflowMessages.endTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: turn.workflowTurnId,
      runId: interaction.runId,
      targetSessionId: interaction.targetSessionId,
      stopReason: "completed",
      responseSessionEntryId: "assistant-entry-1",
    });
    server.workflowMessages.startTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "turn-lost",
      runId: interaction.runId,
      targetSessionId: interaction.targetSessionId,
    });
    expect(server.workflowMessages.settleOpenTurnsForRun(interaction.runId)).toEqual([
      expect.objectContaining({
        workflowTurnId: "turn-lost",
        state: "ended",
        stopReason: "lost",
      }),
    ]);
    expect(server.workflowMessages.settleOpenTurnsForRun(interaction.runId)).toEqual([]);
    const validating = server.beginInteractionValidation({
      requestId: interaction.requestId,
      submissionId: "submission-rejected",
      idempotencyKey: "tool-1",
      expectedRevision: interaction.revision,
      payload: { invalid: true },
      receipt: { status: "validating" },
    });
    expect(validating.interaction.status).toBe("pending");
    expect(server.validatingInteraction("run-1")).toMatchObject({
      requestId: interaction.requestId,
      submissionId: "submission-rejected",
    });
    expect(() =>
      server.beginInteractionValidation({
        requestId: interaction.requestId,
        submissionId: "submission-conflict",
        idempotencyKey: "tool-conflict",
        expectedRevision: interaction.revision,
        payload: { invalid: false },
      }),
    ).toThrow(/validation is already active/);
    expect(
      server.finishInteractionValidation({
        requestId: interaction.requestId,
        submissionId: "submission-rejected",
        accepted: false,
        receipt: { status: "rejected", error: "Try again" },
      }),
    ).toMatchObject({ outcome: "rejected", receipt: { error: "Try again" } });
    expect(server.listPendingInteractions("session-1")).toHaveLength(1);

    server.beginInteractionValidation({
      requestId: interaction.requestId,
      submissionId: "submission-accepted",
      idempotencyKey: "tool-2",
      expectedRevision: interaction.revision,
      payload: { result: "done" },
      receipt: { status: "validating" },
    });
    const settled = server.finishInteractionValidation({
      requestId: interaction.requestId,
      submissionId: "submission-accepted",
      accepted: true,
      receipt: { status: "accepted" },
    });
    expect(settled).toMatchObject({
      outcome: "accepted",
      receipt: { status: "accepted" },
    });
    expect(server.getInteraction(interaction.requestId)).toMatchObject({
      status: "settled",
      acceptedSubmissionId: "submission-accepted",
    });
    expect(
      server.finishInteractionValidation({
        requestId: interaction.requestId,
        submissionId: "submission-accepted",
        accepted: true,
        receipt: { status: "changed" },
      }),
    ).toMatchObject({ outcome: "accepted", receipt: { status: "accepted" } });
    expect(server.listPendingInteractions("session-1")).toEqual([]);

    runStore.close();
    server.close();
    queue.close();
  });
});
