import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import {
  encodeProtocolLine,
  HostProtocolError,
  MAX_PROTOCOL_MESSAGE_BYTES,
  NdjsonFrameDecoder,
  parseHostRequest,
  type HostRequest,
} from "../src/host/protocol.js";
import { HostStateStore, type WorkerLaunchEnvelope } from "../src/host/state.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir, ScriptedExecutor } from "./helpers.js";

const workflow = compileWorkflowDefinition(rawWorkflow);
const snapshot = createDefinitionSnapshot(workflow);
const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

function request(overrides: Partial<HostRequest> = {}): HostRequest {
  return {
    schema: "pi-workflows.host-request.v1",
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
    expect(parseHostRequest(encoded.subarray(0, -1))).toEqual(request());
    expect(() =>
      parseHostRequest('{"schema":"pi-workflows.host-request.v1", "requestId":"request-1"}'),
    ).toThrow(HostProtocolError);
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
    expect(calls).toBe(1);
    expect(host.executeCommand(request({ payload: { changed: true } }), 1, execute)).toMatchObject({
      outcome: "conflict",
    });
    expect(calls).toBe(1);
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
      contract: { prompt: "Continue" },
    });
    expect(host.listPendingInteractions("session-1")).toHaveLength(1);
    const presentationClaim = host.claimInteractionPresentation({
      requestId: interaction.requestId,
      expectedRevision: interaction.revision,
      presenterId: "pi-client-one",
      leaseMs: 10,
    });
    expect(() =>
      host.claimInteractionPresentation({
        requestId: interaction.requestId,
        expectedRevision: presentationClaim.revision,
        presenterId: "pi-client-two",
        leaseMs: 10,
      }),
    ).toThrow(/conflict/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const adoptedPresentation = host.claimInteractionPresentation({
      requestId: interaction.requestId,
      expectedRevision: presentationClaim.revision,
      presenterId: "pi-client-two",
      leaseMs: 10,
    });
    const presenting = host.markInteractionPresented({
      requestId: interaction.requestId,
      expectedRevision: adoptedPresentation.revision,
      sessionEntryId: "entry-1",
    });
    const rejected = host.submitInteraction({
      requestId: interaction.requestId,
      submissionId: "submission-rejected",
      idempotencyKey: "tool-1",
      expectedRevision: presenting.revision,
      payload: { invalid: true },
      accepted: false,
    });
    expect(rejected.interaction.status).toBe("presenting");
    const settled = host.submitInteraction({
      requestId: interaction.requestId,
      submissionId: "submission-accepted",
      idempotencyKey: "tool-2",
      expectedRevision: presenting.revision,
      payload: { result: "done" },
      accepted: true,
      receipt: { accepted: true },
    });
    expect(settled).toMatchObject({
      outcome: "accepted",
      interaction: {
        status: "settled",
        acceptedSubmissionId: "submission-accepted",
      },
      receipt: { accepted: true },
    });
    expect(
      host.submitInteraction({
        requestId: interaction.requestId,
        submissionId: "submission-accepted",
        idempotencyKey: "tool-2",
        expectedRevision: presenting.revision,
        payload: { result: "done" },
        accepted: true,
        receipt: { accepted: false },
      }),
    ).toMatchObject({ outcome: "adopted", receipt: { accepted: true } });
    expect(host.listPendingInteractions("session-1")).toEqual([]);

    runStore.close();
    host.close();
    queue.close();
  });
});
