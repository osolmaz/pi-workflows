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
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import { HostStateStore, type WorkerLaunchEnvelope } from "../src/host/state.js";
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
    operation: "host.status",
    idempotencyKey: "status-1",
    payload: {},
    ...overrides,
  };
}

async function fixture() {
  const projectPath = await makeTempDir("host-state-project");
  const databasePath = path.join(await makeTempDir("host-state-db"), "state.sqlite");
  const queue = new SqliteControllerStore(databasePath, { projectPath });
  return { projectPath, databasePath, queue, host: new HostStateStore(databasePath) };
}

function reserve(queue: SqliteControllerStore, runId = "run-1") {
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

describe("host protocol", () => {
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

describe("host durable state", () => {
  it("fences host epochs and never revives an expired host", async () => {
    const { host, queue } = await fixture();
    const first = host.acquireHost({
      hostId: "host-1",
      pid: 100,
      processStartIdentity: "start-1",
      leaseMs: 1_000,
      now: 1_000,
    });
    expect(first.epoch).toBe(1);
    expect(() =>
      host.acquireHost({
        hostId: "host-2",
        pid: 200,
        processStartIdentity: "start-2",
        leaseMs: 1_000,
        now: 1_500,
      }),
    ).toThrow(/live Pi Workflows host/);
    const second = host.acquireHost({
      hostId: "host-2",
      pid: 200,
      processStartIdentity: "start-2",
      leaseMs: 1_000,
      now: 2_001,
    });
    expect(second.epoch).toBe(2);
    expect(() => host.renewHost(first, 1_000, 2_100)).toThrow(/claim lost/);
    expect(host.renewHost(second, 1_000, 2_100).expiresAt).toBe(3_100);
    expect(host.releaseHost(first, 2_200)).toBe(false);
    expect(host.releaseHost(second, 2_200)).toBe(true);
    host.close();
    queue.close();
  });

  it("stores command receipts and rejects request identity reuse", async () => {
    const { host, queue } = await fixture();
    let calls = 0;
    const execute = () => {
      calls += 1;
      return { outcome: "accepted" as const, receipt: { live: true } };
    };
    expect(host.executeCommand(request(), 1, execute)).toMatchObject({
      outcome: "accepted",
      receipt: { live: true },
    });
    expect(host.executeCommand(request(), 1, execute)).toMatchObject({
      outcome: "adopted",
      receipt: { live: true },
    });
    expect(host.executeCommand(request({ requestId: "request-2" }), 1, execute)).toMatchObject({
      requestId: "request-2",
      outcome: "adopted",
      receipt: { live: true },
    });
    expect(calls).toBe(1);
    expect(host.executeCommand(request({ payload: { changed: true } }), 1, execute)).toMatchObject({
      outcome: "conflict",
    });
    expect(calls).toBe(1);

    let rejectedCalls = 0;
    const rejected = () => {
      rejectedCalls += 1;
      return { outcome: "rejected" as const, error: "invalid request" };
    };
    expect(
      host.executeCommand(
        request({ requestId: "rejected-1", idempotencyKey: "rejected" }),
        1,
        rejected,
      ),
    ).toMatchObject({ outcome: "rejected", error: "invalid request" });
    expect(
      host.executeCommand(
        request({ requestId: "rejected-2", idempotencyKey: "rejected" }),
        1,
        rejected,
      ),
    ).toMatchObject({ outcome: "rejected", error: "invalid request" });
    expect(rejectedCalls).toBe(1);
    host.close();
    queue.close();
  });

  it("records worker epochs and durable interaction submissions", async () => {
    const { host, queue, databasePath, projectPath } = await fixture();
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

    const envelope: WorkerLaunchEnvelope = {
      schema: "pi-workflows.worker-launch.v1",
      runId: "run-1",
      generation: 1,
      workerEpoch: "worker-1",
      projectPath,
      workflowSource: { kind: "builtin", id: "echo", revision: "test" },
      definitionDigest: `sha256:${definitionDigest}`,
      inputHash: "sha256:input",
      protocolVersion: 1,
    };
    host.recordWorkerStart(envelope, 1);
    expect(() =>
      host.recordWorkerStart({ ...envelope, workerEpoch: "worker-duplicate" }, 1),
    ).toThrow(/UNIQUE constraint/);
    host.attachWorkerProcess("worker-1", 123, "start-123");
    host.markWorkerReady("worker-1");
    host.finishWorker({ workerEpoch: "worker-1", outcome: "exited", exitCode: 0 });

    const interaction = host.createInteractiveRequest({
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
    expect(host.listPendingInteractions("session-1")).toHaveLength(1);
    const message = host.workflowMessages.listSession("session-1")[0];
    if (message === undefined) throw new Error("workflow message missing");
    expect(message).toMatchObject({
      kind: "step",
      sourceId: interaction.requestId,
      status: "pending",
    });
    expect(
      host.workflowMessages.adoptBranch(
        "session-1",
        [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-1" }],
        new Set([message.workflowMessageId]),
      )[0],
    ).toMatchObject({ status: "sent", piSessionEntryId: "entry-1" });
    expect(() =>
      host.workflowMessages.adoptBranch(
        "session-1",
        [{ workflowMessageId: message.workflowMessageId, piSessionEntryId: "entry-other" }],
        new Set([message.workflowMessageId]),
      ),
    ).toThrow(/conflicting Pi session entry evidence/);
    const turn = host.workflowMessages.startTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: "turn-1",
      runId: interaction.runId,
      targetSessionId: interaction.targetSessionId,
    });
    expect(
      host.workflowMessages.startTurn({
        workflowMessageId: message.workflowMessageId,
        workflowTurnId: "turn-1",
        runId: interaction.runId,
        targetSessionId: interaction.targetSessionId,
      }),
    ).toEqual(turn);
    host.workflowMessages.endTurn({
      workflowMessageId: message.workflowMessageId,
      workflowTurnId: turn.workflowTurnId,
      runId: interaction.runId,
      targetSessionId: interaction.targetSessionId,
      stopReason: "completed",
      responseSessionEntryId: "assistant-entry-1",
    });
    const validating = host.beginInteractionValidation({
      requestId: interaction.requestId,
      submissionId: "submission-rejected",
      idempotencyKey: "tool-1",
      expectedRevision: interaction.revision,
      payload: { invalid: true },
      receipt: { status: "validating" },
    });
    expect(validating.interaction.status).toBe("pending");
    expect(host.validatingInteraction("run-1")).toMatchObject({
      requestId: interaction.requestId,
      submissionId: "submission-rejected",
    });
    expect(() =>
      host.beginInteractionValidation({
        requestId: interaction.requestId,
        submissionId: "submission-conflict",
        idempotencyKey: "tool-conflict",
        expectedRevision: interaction.revision,
        payload: { invalid: false },
      }),
    ).toThrow(/validation is already active/);
    expect(
      host.finishInteractionValidation({
        requestId: interaction.requestId,
        submissionId: "submission-rejected",
        accepted: false,
        receipt: { status: "rejected", error: "Try again" },
      }),
    ).toMatchObject({ outcome: "rejected", receipt: { error: "Try again" } });
    expect(host.listPendingInteractions("session-1")).toHaveLength(1);

    host.beginInteractionValidation({
      requestId: interaction.requestId,
      submissionId: "submission-accepted",
      idempotencyKey: "tool-2",
      expectedRevision: interaction.revision,
      payload: { result: "done" },
      receipt: { status: "validating" },
    });
    const settled = host.finishInteractionValidation({
      requestId: interaction.requestId,
      submissionId: "submission-accepted",
      accepted: true,
      receipt: { status: "accepted" },
    });
    expect(settled).toMatchObject({
      outcome: "accepted",
      receipt: { status: "accepted" },
    });
    expect(host.getInteraction(interaction.requestId)).toMatchObject({
      status: "settled",
      acceptedSubmissionId: "submission-accepted",
    });
    expect(
      host.finishInteractionValidation({
        requestId: interaction.requestId,
        submissionId: "submission-accepted",
        accepted: true,
        receipt: { status: "changed" },
      }),
    ).toMatchObject({ outcome: "accepted", receipt: { status: "accepted" } });
    expect(host.listPendingInteractions("session-1")).toEqual([]);

    runStore.close();
    host.close();
    queue.close();
  });
});
