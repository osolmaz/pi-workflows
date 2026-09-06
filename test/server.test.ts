import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import echoWorkflow from "../examples/workflows/echo.workflow.js";
import { WorkflowClient } from "../src/client/client.js";
import {
  encodeProtocolLine,
  parseClientMessage,
  type ClientRequest,
  type ClientResponse,
} from "../src/client/protocol.js";
import { ServerProcessRegistry } from "../src/server/processes.js";
import { WorkflowServer } from "../src/server/server.js";
import { ServerStateStore } from "../src/server/state.js";
import {
  encodeRunnerLine,
  MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES,
  type WorkflowRunnerResponse,
} from "../src/server/workflow-runner-protocol.js";
import { canonicalJson } from "../src/state/json.js";
import {
  AUTOMATIC_STATE_PRUNE_INTERVAL_MS,
  AUTOMATIC_STATE_RETENTION_MS,
} from "../src/state/prune.js";
import type { WorkflowMessage } from "../src/state/workflow-messages.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import type { InteractiveRequestRecord } from "../src/workflows/requests.js";
import { SESSION_BINDING_SCHEMA, WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeTempDir, waitUntil } from "./helpers.js";

async function ownSession(client: WorkflowClient, targetSessionId = "host-test-session") {
  const watched = await client.request({
    operation: "view.session.watch",
    payload: {
      subscriptionId: `owner-${targetSessionId}`,
      sessionId: targetSessionId,
      coordinator: true,
    },
  });
  const coordinatorEpoch = (watched.receipt as { coordinatorEpoch: string }).coordinatorEpoch;
  const authority = { targetSessionId, coordinatorEpoch };
  const reported = await client.request({
    operation: "workflowMessage.reportBranch",
    payload: { ...authority, entries: [], isIdle: true, hasPendingMessages: false },
  });
  expect(reported.outcome).toBe("accepted");
  return authority;
}

async function writeComputeWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "compute.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-compute",
  startAt: "work",
  nodes: { work: compute({ run: ({ input }) => ({ input, pid: process.pid }) }) },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeHeadlessAgentWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "headless-agent.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-headless-agent",
  startAt: "ask",
  nodes: { ask: agent({ prompt: () => "Return a result." }) },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeTimedDecisionWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "timed-decision.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import {
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
} from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});
export default defineWorkflow({
  name: "host-timed-decision",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: "operator",
      choices,
      request: () => ({
        title: "Continue?",
        subject: { task: "test" },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Choose whether to continue.",
          blocks: [],
        },
      }),
      onTimeout: { afterMs: 100, response: { choice: "continue" } },
    }),
    continued: compute({ run: ({ outputs }) => outputs.approve }),
    stopped: compute({ run: ({ outputs }) => outputs.approve }),
  },
  edges: [
    humanDecisionEdge({
      from: "approve",
      choices,
      cases: { continue: "continued", stop: "stopped" },
    }),
  ],
});\n`,
  );
  return workflowPath;
}

async function writeChannelDecisionWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "channel-decision.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import {
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
} from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
const choices = defineHumanChoices({
  continue: choice({ label: "Continue" }),
  stop: choice({ label: "Stop" }),
});
export default defineWorkflow({
  name: "host-channel-decision",
  startAt: "approve",
  nodes: {
    approve: humanDecision({
      audience: "operator",
      choices,
      request: () => ({
        title: "Continue?",
        subject: { private: "not-for-channel" },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Choose whether to continue.",
          blocks: [],
        },
      }),
    }),
    continued: compute({ run: ({ outputs }) => outputs.approve }),
    stopped: compute({ run: ({ outputs }) => outputs.approve }),
  },
  edges: [
    humanDecisionEdge({
      from: "approve",
      choices,
      cases: { continue: "continued", stop: "stopped" },
    }),
  ],
});\n`,
  );
  return workflowPath;
}

async function writeFakeChannelAdapter(cwd: string): Promise<string> {
  const adapterPath = path.join(cwd, "fake-channel-adapter.mjs");
  await fs.writeFile(
    adapterPath,
    `import fs from "node:fs";
import readline from "node:readline";
const launch = JSON.parse(Buffer.from(process.env.PI_WORKFLOWS_CHANNEL_LAUNCH, "base64url").toString("utf8"));
const log = process.env.PI_WORKFLOWS_CHANNEL_TEST_LOG;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
let sequence = 0;
let revision = 0;
let cursor = 0;
let presented = null;
let answered = false;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
const writeLog = (value) => fs.appendFileSync(log, JSON.stringify(value) + "\\n");
async function report(message) {
  sequence += 1;
  process.stdout.write(JSON.stringify({
    schema: "pi-workflows.channel-adapter.v1",
    adapterEpoch: launch.adapterEpoch,
    profile: launch.profile,
    sequence,
    expectedRevision: revision,
    ...message,
  }) + "\\n");
  const next = await lines.next();
  if (next.done) process.exit(0);
  const response = JSON.parse(next.value);
  if (response.outcome !== "accepted") throw new Error(response.error);
  revision = response.revision;
  return response;
}
let response = await report({ kind: "channel.ready", stableMessageId: "ready-" + launch.adapterEpoch + "-1", cursor });
while (!stopping) {
  const command = response.command;
  if (!command || command.kind === "channel.poll") {
    if (command?.kind === "channel.poll" && presented && !answered) {
      answered = true;
      const choice = Object.keys(presented.choices)[0];
      cursor += 1;
      writeLog({ kind: "answer", decisionId: presented.decisionId });
      await report({
        kind: "channel.answer",
        stableMessageId: "answer-" + presented.decisionId,
        decisionId: presented.decisionId,
        requestDigest: presented.requestDigest,
        response: { choice },
        actorId: "100",
        chatId: "-200",
        eventId: "event-1",
        idempotencyKey: "telegram:approval:event-1",
        cursor,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    response = await report({ kind: "channel.ready", stableMessageId: "ready-" + launch.adapterEpoch + "-" + (sequence + 1), cursor });
    continue;
  }
  if (command.kind === "channel.present") {
    if (Object.hasOwn(command.request, "subject")) throw new Error("channel received private subject");
    presented = command.request;
    writeLog({ kind: "present", decisionId: presented.decisionId });
    response = await report({
      kind: "channel.present",
      stableMessageId: command.stableMessageId,
      decisionId: presented.decisionId,
      requestDigest: presented.requestDigest,
      attemptId: command.attemptId,
      state: "confirmed",
      messages: [{ chatId: "-200", messageId: "10", recipientIndex: 0, partIndex: 0, contentDigest: "sha256:test" }],
    });
    continue;
  }
  if (command.kind === "channel.settle") {
    writeLog({ kind: "settle", decisionId: command.request.decisionId });
    response = await report({
      kind: "channel.settle",
      stableMessageId: command.stableMessageId,
      decisionId: command.request.decisionId,
      requestDigest: command.request.requestDigest,
      attemptId: command.attemptId,
      state: "confirmed",
    });
    continue;
  }
}
await report({ kind: "channel.exiting", stableMessageId: "exit-" + launch.adapterEpoch, cursor });
`,
  );
  return adapterPath;
}

async function writeCrashingChannelAdapter(cwd: string): Promise<string> {
  const adapterPath = path.join(cwd, "crashing-channel-adapter.mjs");
  await fs.writeFile(
    adapterPath,
    `import fs from "node:fs";
import readline from "node:readline";
const launch = JSON.parse(Buffer.from(process.env.PI_WORKFLOWS_CHANNEL_LAUNCH, "base64url").toString("utf8"));
const log = process.env.PI_WORKFLOWS_CHANNEL_TEST_LOG;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
let sequence = 0;
let revision = 0;
let cursor = 0;
async function report(message) {
  sequence += 1;
  process.stdout.write(JSON.stringify({
    schema: "pi-workflows.channel-adapter.v1",
    adapterEpoch: launch.adapterEpoch,
    profile: launch.profile,
    sequence,
    expectedRevision: revision,
    ...message,
  }) + "\\n");
  const next = await lines.next();
  if (next.done) process.exit(0);
  const response = JSON.parse(next.value);
  if (response.outcome !== "accepted") throw new Error(response.error);
  revision = response.revision;
  return response;
}
let response = await report({ kind: "channel.ready", stableMessageId: "ready-" + launch.adapterEpoch + "-1", cursor });
for (;;) {
  const command = response.command;
  if (command?.kind === "channel.present" || command?.kind === "channel.settle") {
    fs.appendFileSync(log, JSON.stringify({ kind: command.kind, messageId: command.stableMessageId }) + "\\n");
    process.exit(23);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  response = await report({ kind: "channel.ready", stableMessageId: "ready-" + launch.adapterEpoch + "-" + (sequence + 1), cursor });
}
`,
  );
  return adapterPath;
}

async function writeInteractiveWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "interactive.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-interactive",
  startAt: "ask",
  nodes: {
    ask: agent({ prompt: () => "Return a result." }),
    done: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "done" }],
});\n`,
  );
  return workflowPath;
}

async function writeTwoStepInteractiveWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "two-step-interactive.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-two-step-interactive",
  startAt: "first",
  nodes: {
    first: agent({ prompt: () => "Return the first result." }),
    second: agent({ prompt: () => "Return the second result." }),
    done: compute({ run: ({ outputs }) => outputs.second }),
  },
  edges: [{ from: "first", to: "second" }, { from: "second", to: "done" }],
});\n`,
  );
  return workflowPath;
}

async function writeTimedInteractiveWorkflow(cwd: string, timeoutMs: number): Promise<string> {
  const workflowPath = path.join(cwd, "timed-interactive.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { agent, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-timed-interactive",
  startAt: "ask",
  nodes: {
    ask: agent({ timeoutMs: ${timeoutMs}, prompt: () => "Return before the deadline." }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeIncludedInteractiveWorkflow(
  cwd: string,
): Promise<{ workflowPath: string; childPath: string }> {
  const childPath = path.join(cwd, "child.workflow.ts");
  const workflowPath = path.join(cwd, "included.workflow.ts");
  await fs.writeFile(
    childPath,
    `import { agent, compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-included-child",
  startAt: "ask",
  exits: { done: { from: "finish" } },
  nodes: {
    ask: agent({ prompt: () => "Return a child result." }),
    finish: compute({ run: ({ outputs }) => outputs.ask }),
  },
  edges: [{ from: "ask", to: "finish" }],
});\n`,
  );
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow, includeWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-included-parent",
  startAt: "start",
  includes: { child: includeWorkflow({ workflow: "./child.workflow.ts" }) },
  nodes: {
    start: compute({ run: () => ({}) }),
    done: compute({ run: ({ outputs }) => outputs.child }),
  },
  edges: [
    { from: "start", to: "child" },
    { from: "child.done", to: "done" },
  ],
});\n`,
  );
  return { workflowPath, childPath };
}

async function writeDeliveryWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "delivery.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow, notify } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-delivery",
  startAt: "report",
  nodes: {
    report: notify({ kind: "progress", message: () => "ServerBacked progress." }),
    finish: compute({ run: () => ({ delivered: true }) }),
  },
  edges: [{ from: "report", to: "finish" }],
});\n`,
  );
  return workflowPath;
}

async function writeBlockingWorkflow(cwd: string, waitMs = 900): Promise<string> {
  const workflowPath = path.join(cwd, "blocking.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { compute, defineWorkflow } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-blocking",
  startAt: "work",
  nodes: {
    work: compute({
      run: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${waitMs});
        return { finished: true };
      },
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeBlockingEffectWorkflow(cwd: string): Promise<string> {
  const workflowPath = path.join(cwd, "blocking-effect.workflow.ts");
  await fs.writeFile(
    workflowPath,
    `import { action, defineWorkflow, manualEffect } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: "host-blocking-effect",
  startAt: "effect",
  nodes: {
    effect: action({
      effect: manualEffect("test.host-blocking-effect"),
      run: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
        return { applied: true };
      },
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function writeCrashEffectWorkflow(
  cwd: string,
  recovery: "idempotent" | "manual",
  markerPath?: string,
): Promise<string> {
  const workflowPath = path.join(cwd, `${recovery}-crash.workflow.ts`);
  const effectFactory = recovery === "idempotent" ? "idempotentEffect" : "manualEffect";
  const run =
    recovery === "idempotent"
      ? `() => {
          if (!existsSync(${JSON.stringify(markerPath)})) {
            writeFileSync(${JSON.stringify(markerPath)}, "applied");
            process.exit(23);
          }
          return { applied: true };
        }`
      : "() => process.exit(23)";
  await fs.writeFile(
    workflowPath,
    `import { existsSync, writeFileSync } from "node:fs";
import { action, defineWorkflow, ${effectFactory} } from ${JSON.stringify(
      path.resolve("src/workflows/index.ts"),
    )};
export default defineWorkflow({
  name: ${JSON.stringify(`host-${recovery}-crash`)},
  startAt: "effect",
  nodes: {
    effect: action({
      effect: ${effectFactory}(${JSON.stringify(`test.host-${recovery}-crash`)}),
      run: ${run},
    }),
  },
  edges: [],
});\n`,
  );
  return workflowPath;
}

async function sendServerPipeline(
  endpoint: string,
  requests: ClientRequest[],
): Promise<ClientResponse[]> {
  const socket = net.createConnection(endpoint);
  await once(socket, "connect");
  const responses = await new Promise<ClientResponse[]>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const values: ClientResponse[] = [];
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.byteLength === 0) continue;
        const message = parseClientMessage(frame);
        if (message.type !== "response") continue;
        values.push(message);
        if (values.length === requests.length) {
          cleanup();
          resolve(values);
          return;
        }
      }
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.write(Buffer.concat(requests.map(encodeProtocolLine)));
  });
  socket.end();
  return responses;
}

async function startRun(options: {
  client: WorkflowClient;
  cwd: string;
  workflowPath: string;
  runId: string;
  executionMode?: "headless" | "interactive";
}): Promise<void> {
  const resolved = await options.client.resolveWorkflow({
    cwd: options.cwd,
    workflowRef: options.workflowPath,
  });
  const response = await options.client.request({
    operation: "run.start",
    runId: options.runId,
    payload: {
      projectPath: options.cwd,
      workflowName: resolved.workflowName,
      workflowSourceRef: resolved.workflowSourceRef,
      workflowSource: resolved.workflowSource,
      definitionDigest: resolved.definitionDigest,
      definitionSnapshot: resolved.definitionSnapshot,
      input: { value: 1 },
      launchOptions: {},
      originSessionId: "host-test-session",
      executionMode: options.executionMode ?? "headless",
    },
  });
  expect(response.outcome).toBe("accepted");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("global workflow server", () => {
  it("opens the canonical database and shuts down cleanly", async () => {
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    await host.stop();
  });

  it("rejects a watch for a missing run", async () => {
    const databasePath = path.join(await makeTempDir("host-missing-watch"), "state.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    const client = new WorkflowClient({ databasePath, clientId: "missing-watch-test" });
    try {
      await expect(client.watchRun("missing-run", () => undefined)).rejects.toThrow(
        "Workflow run not found",
      );
    } finally {
      await client.close();
      await host.stop();
    }
  });

  it("performs active state maintenance through the host-owned database", async () => {
    const directory = await makeTempDir("host-state-maintenance");
    const databasePath = path.join(directory, "state.sqlite");
    const backupPath = path.join(directory, "backup.sqlite");
    const explicitBackupPath = path.join(directory, "explicit-backup.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    const client = new WorkflowClient({ databasePath, clientId: "maintenance-test" });
    try {
      const before = new Date().toISOString();
      const preview = await client.request({
        operation: "state.prune",
        payload: { before, apply: false },
      });
      expect(preview).toMatchObject({ outcome: "accepted", receipt: { applied: false } });
      const appliedPayload = { before, apply: true, backupPath };
      const applied = await client.request({
        operation: "state.prune",
        requestId: "prune-apply-1",
        idempotencyKey: "prune-apply",
        payload: appliedPayload,
      });
      expect(applied).toMatchObject({ outcome: "accepted", receipt: { applied: true } });
      const adopted = await client.request({
        operation: "state.prune",
        requestId: "prune-apply-2",
        idempotencyKey: "prune-apply",
        payload: appliedPayload,
      });
      expect(adopted).toMatchObject({ outcome: "adopted", receipt: applied.receipt });
      await expect(fs.stat(backupPath)).resolves.toBeDefined();

      const mutableServer = host as unknown as {
        state: { backup: (destination: string) => Promise<void> };
      };
      const originalBackup = mutableServer.state.backup.bind(mutableServer.state);
      const backupSpy = vi
        .spyOn(mutableServer.state, "backup")
        .mockImplementation(async (destination) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await originalBackup(destination);
        });
      const firstBackup = client.request({
        operation: "state.backup",
        requestId: "backup-1",
        idempotencyKey: "backup",
        payload: { destination: explicitBackupPath },
      });
      const secondBackup = client.request({
        operation: "state.backup",
        requestId: "backup-2",
        idempotencyKey: "backup",
        payload: { destination: explicitBackupPath },
      });
      const [backup, adoptedBackup] = await Promise.all([firstBackup, secondBackup]);
      expect(backup).toMatchObject({
        outcome: "accepted",
        receipt: { destination: explicitBackupPath },
      });
      expect(adoptedBackup).toMatchObject({ outcome: "adopted", receipt: backup.receipt });
      expect(backupSpy).toHaveBeenCalledTimes(1);
      await expect(fs.stat(explicitBackupPath)).resolves.toBeDefined();
    } finally {
      await client.close();
      await host.stop();
    }
  });

  it("restores desired subscriptions after the host restarts", async () => {
    const databasePath = path.join(await makeTempDir("host-reconnect"), "state.sqlite");
    let host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    const client = new WorkflowClient({ databasePath });
    const events: string[] = [];
    const unsubscribe = await client.watchRuns((event) => events.push(event.event));
    await waitUntil(() => events.includes("runs"), 5_000);

    await host.stop();
    await waitUntil(() => events.includes("unavailable"), 5_000);
    host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    try {
      await waitUntil(() => events.filter((event) => event === "runs").length >= 2, 5_000);
    } finally {
      await unsubscribe();
      await client.close();
      await host.stop();
    }
  });

  it("keeps one slow request from blocking other requests on the same client", async () => {
    const databasePath = path.join(await makeTempDir("host-multiplex"), "state.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const mutableServer = host as unknown as {
      submitInteractionAndWait: (request: ClientRequest) => Promise<ClientResponse>;
    };
    mutableServer.submitInteractionAndWait = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        schema: "pi-workflows.client.v1",
        type: "response",
        requestId: request.requestId,
        outcome: "accepted",
      };
    };
    await host.start();
    try {
      const client = new WorkflowClient({ databasePath });
      try {
        const authority = await ownSession(client);
        const completed: string[] = [];
        await Promise.all([
          client
            .request({
              operation: "interaction.submit",
              requestId: "slow-request",
              payload: authority,
            })
            .then((response) => completed.push(response.requestId)),
          client
            .request({ operation: "server.status", requestId: "status-request" })
            .then((response) => completed.push(response.requestId)),
        ]);
        expect(completed).toEqual(["status-request", "slow-request"]);
      } finally {
        await client.close();
      }
    } finally {
      await host.stop();
    }
  });

  it("waits for socket drain before publishing another snapshot", async () => {
    const databasePath = path.join(await makeTempDir("host-view-backpressure"), "state.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    const socket = new net.Socket();
    const write = vi.spyOn(socket, "write").mockReturnValue(false);
    const connection = {
      id: "slow-viewer",
      socket,
      subscriptions: new Map([["runs", { id: "runs", kind: "runs" as const, revision: 0 }]]),
      publishing: false,
    };
    const privateServer = host as unknown as {
      publishConnection: (target: typeof connection) => Promise<void>;
    };
    try {
      const publishing = privateServer.publishConnection(connection);
      await waitUntil(() => write.mock.calls.length === 1, 5_000);
      expect(connection.publishing).toBe(true);
      await privateServer.publishConnection(connection);
      expect(write).toHaveBeenCalledTimes(1);
      socket.emit("drain");
      await publishing;
      expect(connection.publishing).toBe(false);
    } finally {
      socket.destroy();
      await host.stop();
    }
  });

  it("ends a backpressure wait when the client socket closes", async () => {
    const databasePath = path.join(await makeTempDir("host-backpressure-close"), "state.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    const socket = new net.Socket();
    const write = vi.spyOn(socket, "write").mockReturnValue(false);
    const connection = {
      id: "closing-viewer",
      socket,
      subscriptions: new Map([["runs", { id: "runs", kind: "runs" as const, revision: 0 }]]),
      publishing: false,
    };
    const privateServer = host as unknown as {
      publishConnection: (target: typeof connection) => Promise<void>;
    };
    try {
      const publishing = privateServer.publishConnection(connection);
      await waitUntil(() => write.mock.calls.length === 1, 5_000);
      socket.emit("close");
      await expect(publishing).resolves.toBeUndefined();
      expect(connection.publishing).toBe(false);
    } finally {
      socket.destroy();
      await host.stop();
    }
  });

  it("closes idle client sockets before it waits for listener shutdown", async () => {
    const databasePath = path.join(await makeTempDir("host-idle-client"), "state.sqlite");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    const socket = net.createConnection(host.endpoint);
    await once(socket, "connect");
    socket.resume();
    const closed = once(socket, "close");
    await host.stop();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("contains accepted-client socket errors", async () => {
    const databasePath = path.join(await makeTempDir("host-client-error"), "state.sqlite");
    const logs: string[] = [];
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      onLog: (message) => logs.push(message),
    });
    await host.start();
    try {
      const socket = net.createConnection(host.endpoint);
      await once(socket, "connect");
      socket.resume();
      await waitUntil(() => (host as unknown as { sockets: Set<net.Socket> }).sockets.size === 1);
      const acceptedSocket = [...(host as unknown as { sockets: Set<net.Socket> }).sockets][0];
      if (acceptedSocket === undefined) throw new Error("accepted socket was not tracked");
      const closed = once(socket, "close");
      expect(() => acceptedSocket.emit("error", new Error("test reset"))).not.toThrow();
      await closed;
      expect(logs).toContain("client socket error: test reset");

      const client = new WorkflowClient({ databasePath });
      await expect(client.request({ operation: "server.status" })).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { state: "running" },
      });
    } finally {
      await host.stop();
    }
  });

  it.skipIf(process.platform === "win32")(
    "releases its claim and lock when the local listener cannot bind",
    async () => {
      const root = await makeTempDir("host-bind-failure");
      const stateDirectory = path.join(root, "a".repeat(70), "b".repeat(70));
      await fs.mkdir(stateDirectory, { recursive: true });
      const databasePath = path.join(stateDirectory, "state.sqlite");
      const host = new WorkflowServer({ databasePath, runnerId: "failed-host" });
      await expect(host.start()).rejects.toThrow();

      const state = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(state.serverStatus()).toMatchObject({ serverId: null, live: false });
      } finally {
        state.close();
      }
      await expect(
        fs.access(path.join(stateDirectory, "host", "host.lock.json")),
      ).rejects.toThrow();
      await host.stop();
    },
  );

  it.skipIf(process.platform === "win32")(
    "reaps the headless pi process group after normal worker completion",
    async () => {
      const cwd = await makeTempDir("host-headless-group-project");
      const stateDir = await makeTempDir("host-headless-group-state");
      const databasePath = path.join(stateDir, "state.sqlite");
      const workflowPath = await writeHeadlessAgentWorkflow(cwd);
      const binDir = path.join(cwd, "bin");
      const pidFile = path.join(cwd, "fake-pi-pids.json");
      const fakePi = path.join(binDir, "pi");
      await fs.mkdir(binDir);
      await fs.writeFile(
        fakePi,
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_PI_PIDS, JSON.stringify({ leader: process.pid, grandchild: grandchild.pid }));
let submitted = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (submitted) return;
  const request = JSON.parse(line);
  const contract = request.message.split("\\n").find((candidate) => candidate.startsWith('{"action": "submit"'));
  if (contract === undefined) return;
  const action = JSON.parse(contract.replace("<your result>", "null"));
  submitted = true;
  process.stderr.write("PI_WORKFLOWS_STEP_SUBMISSION " + JSON.stringify({ ...action, output: { done: true } }) + "\\n");
});
setInterval(() => {}, 1000);
`,
        { encoding: "utf8", mode: 0o755 },
      );
      const registry = new ServerProcessRegistry(stateDir);
      const host = new WorkflowServer({
        databasePath,
        registry,
        claimPollMs: 10,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_PI_PIDS: pidFile,
        },
      });
      const client = new WorkflowClient({ databasePath });
      await host.start();
      try {
        await startRun({ client, cwd, workflowPath, runId: "headless-group-run" });
        await waitUntil(() => {
          const store = new WorkflowRunQueueStore(databasePath, {
            readOnly: true,
            global: true,
          });
          try {
            return store.getWorkflowRun("headless-group-run")?.status === "done";
          } finally {
            store.close();
          }
        }, 30_000);
        const pids = JSON.parse(await fs.readFile(pidFile, "utf8")) as {
          leader: number;
          grandchild: number;
        };
        await waitUntil(
          () =>
            !processExists(pids.leader) && !processExists(pids.grandchild) && registry.size === 0,
        );
        expect(registry.size).toBe(0);
      } finally {
        await host.stop();
      }
    },
    45_000,
  );

  it("uses the database directory for its local process registry", async () => {
    const stateDir = await makeTempDir("host-state");
    const registry = new ServerProcessRegistry(stateDir);
    const host = new WorkflowServer({
      databasePath: path.join(stateDir, "state.sqlite"),
      registry,
      claimPollMs: 10,
    });
    await host.start();
    await host.stop();
  });

  it("refuses every second server for the same global database", async () => {
    const databasePath = path.join(await makeTempDir("host-state"), "state.sqlite");
    const first = new WorkflowServer({ databasePath, runnerId: "host-one", claimPollMs: 10 });
    const second = new WorkflowServer({ databasePath, runnerId: "host-two", claimPollMs: 10 });
    await first.start();
    await expect(second.start()).rejects.toThrow(/server/i);
    await first.stop();
  });

  it("recovers a validating submission when the host restarts before activation", async () => {
    const cwd = await makeTempDir("host-validation-recovery-project");
    const databasePath = path.join(
      await makeTempDir("host-validation-recovery-state"),
      "state.sqlite",
    );
    const workflowPath = await writeInteractiveWorkflow(cwd);
    const first = new WorkflowServer({ databasePath, runnerId: "host-first", claimPollMs: 10 });
    await first.start();
    await startRun({
      client: new WorkflowClient({ databasePath }),
      cwd,
      workflowPath,
      runId: "validation-recovery-run",
      executionMode: "interactive",
    });
    let interaction: InteractiveRequestRecord | undefined;
    await waitUntil(() => {
      const state = new ServerStateStore(databasePath, { readOnly: true });
      try {
        interaction = state.listPendingInteractions("host-test-session")[0];
        return interaction !== undefined;
      } finally {
        state.close();
      }
    }, 30_000);
    await first.stop();
    if (interaction === undefined) throw new Error("interaction was not created");
    const recoveredInteraction = interaction;
    const state = new ServerStateStore(databasePath);
    state.beginInteractionValidation({
      requestId: recoveredInteraction.requestId,
      submissionId: "restart-submission",
      idempotencyKey: "restart-submission",
      expectedRevision: recoveredInteraction.revision,
      payload: { output: { answer: "done" } },
      receipt: { status: "validating" },
    });
    state.close();

    const restarted = new WorkflowServer({
      databasePath,
      runnerId: "host-restarted",
      claimPollMs: 10,
    });
    await restarted.start();
    try {
      await waitUntil(() => {
        const observed = new ServerStateStore(databasePath, { readOnly: true });
        try {
          return (
            observed.interactionSubmission(recoveredInteraction.requestId, "restart-submission")
              ?.outcome === "accepted"
          );
        } finally {
          observed.close();
        }
      }, 30_000);
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  it("adopts a durable submission after reconnect while rejecting stale authority", async () => {
    const cwd = await makeTempDir("host-adopted-submission-project");
    const databasePath = path.join(
      await makeTempDir("host-adopted-submission-state"),
      "state.sqlite",
    );
    const workflowPath = await writeInteractiveWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    let client = new WorkflowClient({ databasePath, clientId: "submission-owner" });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "adopted-submission-run",
        executionMode: "interactive",
      });
      let interaction: InteractiveRequestRecord | undefined;
      await waitUntil(() => {
        const observed = new ServerStateStore(databasePath, { readOnly: true });
        try {
          interaction = observed.listPendingInteractions("host-test-session")[0];
          return interaction !== undefined;
        } finally {
          observed.close();
        }
      }, 30_000);
      if (interaction === undefined) throw new Error("interaction was not created");
      const authority = await ownSession(client);
      const payload = {
        ...authority,
        requestId: interaction.requestId,
        value: { output: { answer: "done" } },
      };
      // Knowing an opaque request ID does not grant response authority.
      const foreign = new WorkflowClient({ databasePath });
      try {
        const foreignAuthority = await ownSession(foreign, "other-session");
        const denied = await foreign.request({
          operation: "interaction.submit",
          payload: { ...payload, ...foreignAuthority, submissionId: "foreign" },
        });
        expect(denied.outcome).toBe("notFound");
        const forged = await foreign.request({
          operation: "interaction.submit",
          payload: { ...payload, submissionId: "forged" },
        });
        expect(forged.outcome).toBe("rejected");
      } finally {
        await foreign.close();
      }
      const wrongKind = await client.request({
        operation: "interaction.assistant",
        payload: { ...payload, submissionId: "wrong-kind" },
      });
      expect(wrongKind.outcome).toBe("rejected");
      const unchanged = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(unchanged.getInteraction(interaction.requestId)).toEqual(interaction);
        expect(
          unchanged.state.connection
            .prepare("SELECT count(*) AS count FROM interactive_submissions")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        unchanged.close();
      }
      const first = await client.request({
        operation: "interaction.submit",
        requestId: "first-submit-request",
        idempotencyKey: "same-durable-submission",
        runId: interaction.runId,
        expectedRevision: interaction.revision,
        payload: { ...payload, submissionId: "first-submission" },
      });
      expect(first.outcome).toBe("accepted");
      await client.close();
      client = new WorkflowClient({ databasePath, clientId: "submission-owner" });
      const reconnectedAuthority = await ownSession(client);
      expect(reconnectedAuthority.coordinatorEpoch).not.toBe(authority.coordinatorEpoch);
      const second = await Promise.race([
        client.request({
          operation: "interaction.submit",
          requestId: "retry-submit-request",
          idempotencyKey: "same-durable-submission",
          runId: interaction.runId,
          expectedRevision: interaction.revision,
          payload: { ...payload, ...reconnectedAuthority, submissionId: "retry-submission" },
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("adopted submission retry timed out")),
            5_000,
          );
          timer.unref?.();
        }),
      ]);
      expect(second.outcome).toBe("adopted");
      const stale = await client.request({
        operation: "interaction.submit",
        idempotencyKey: "same-durable-submission",
        payload: { ...payload, coordinatorEpoch: "stale-epoch", submissionId: "stale" },
      });
      expect(stale.outcome).toBe("rejected");
      const conflicting = await client.request({
        operation: "interaction.submit",
        idempotencyKey: "same-durable-submission",
        payload: {
          ...payload,
          ...reconnectedAuthority,
          value: { output: "different" },
          submissionId: "conflicting",
        },
      });
      expect(conflicting.outcome).toBe("rejected");
      const observed = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(
          observed.interactionSubmission(interaction.requestId, "first-submission")?.outcome,
        ).toBe("accepted");
        expect(observed.interactionSubmission(interaction.requestId, "retry-submission")).toBe(
          undefined,
        );
      } finally {
        observed.close();
      }
    } finally {
      await client.close();
      await host.stop();
    }
  }, 60_000);

  it("resumes with more than 2 MiB of server-owned session history", async () => {
    const cwd = await makeTempDir("host-large-resume-project");
    const databasePath = path.join(await makeTempDir("host-large-resume-state"), "state.sqlite");
    const workflowPath = await writeTwoStepInteractiveWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "large-resume-run",
        executionMode: "interactive",
      });
      let interaction: InteractiveRequestRecord | undefined;
      await waitUntil(() => {
        const observed = new ServerStateStore(databasePath, { readOnly: true });
        try {
          interaction = observed.listPendingInteractions("host-test-session")[0];
          return interaction !== undefined;
        } finally {
          observed.close();
        }
      }, 30_000);
      if (interaction === undefined) throw new Error("interaction was not created");
      const pendingInteraction = interaction;

      const runStore = new WorkflowRunStore(databasePath);
      await runStore.writeSessionBinding("large-resume-run", {
        schema: SESSION_BINDING_SCHEMA,
        runId: "large-resume-run",
        piSessionId: "large-resume-session",
        cwd,
        boundAt: new Date().toISOString(),
      });
      for (let index = 0; index < 17; index += 1) {
        await runStore.appendSessionEntry("large-resume-run", {
          id: `entry-${index}`,
          type: "message",
          content: `${index}:${"x".repeat(128 * 1024)}`,
        });
      }
      expect(
        Buffer.byteLength(canonicalJson(runStore.readRun("large-resume-run"))),
      ).toBeGreaterThan(2 * 1024 * 1024);
      runStore.close();

      const authority = await ownSession(client);
      const response = await client.request({
        operation: "interaction.submit",
        runId: pendingInteraction.runId,
        expectedRevision: pendingInteraction.revision,
        payload: {
          ...authority,
          requestId: pendingInteraction.requestId,
          submissionId: "large-resume-submission",
          value: { output: { answer: "done" } },
        },
      });
      expect(response.outcome).toBe("accepted");

      let secondInteraction: InteractiveRequestRecord | undefined;
      await waitUntil(() => {
        const observed = new ServerStateStore(databasePath, { readOnly: true });
        try {
          secondInteraction = observed
            .listPendingInteractions("host-test-session")
            .find((candidate) => candidate.requestId !== pendingInteraction.requestId);
          return secondInteraction !== undefined;
        } finally {
          observed.close();
        }
      }, 30_000);
      if (secondInteraction === undefined) throw new Error("second interaction was not created");
      const pendingSecondInteraction = secondInteraction;
      const incrementalStore = new WorkflowRunStore(databasePath);
      await incrementalStore.appendSessionEntry("large-resume-run", {
        id: "entry-after-first-resume",
        type: "message",
        content: "small unique change after the first resume",
      });
      incrementalStore.close();
      const secondResponse = await client.request({
        operation: "interaction.submit",
        runId: pendingSecondInteraction.runId,
        expectedRevision: pendingSecondInteraction.revision,
        payload: {
          ...authority,
          requestId: pendingSecondInteraction.requestId,
          submissionId: "large-resume-second-submission",
          value: { output: { answer: "done" } },
        },
      });
      expect(secondResponse.outcome).toBe("accepted");

      await waitUntil(() => {
        const state = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return state.getWorkflowRun("large-resume-run")?.status === "done";
        } finally {
          state.close();
        }
      }, 30_000);
      const completedStore = new WorkflowRunStore(databasePath);
      expect(completedStore.readRun("large-resume-run")?.sessionEntries).toHaveLength(18);
      const crashed = completedStore.state.connection
        .prepare(
          "SELECT count(*) AS count FROM run_workers WHERE run_id = ? AND status = 'crashed'",
        )
        .get("large-resume-run") as { count: number };
      expect(crashed.count).toBe(0);

      const history = completedStore.state.connection
        .prepare(
          `SELECT COALESCE(sum(b.byte_length), 0) AS bytes
           FROM session_entries e JOIN blobs b ON b.blob_hash = e.entry_hash
           WHERE e.run_id = ?`,
        )
        .get("large-resume-run") as { bytes: number };
      const resultBlobs = completedStore.state.connection
        .prepare(
          `SELECT count(*) AS count, COALESCE(sum(b.byte_length), 0) AS bytes
           FROM (
             SELECT DISTINCT m.result_hash AS resultHash
             FROM worker_messages m JOIN run_workers w ON w.worker_epoch = m.worker_epoch
             WHERE w.run_id = ? AND m.result_hash IS NOT NULL
           ) results JOIN blobs b ON b.blob_hash = results.resultHash`,
        )
        .get("large-resume-run") as { count: number; bytes: number };
      const resultRows = completedStore.state.connection
        .prepare(
          `SELECT m.message_id AS messageId, m.outcome,
                  m.accepted_revision AS revision, m.result_hash AS resultHash
           FROM worker_messages m JOIN run_workers w ON w.worker_epoch = m.worker_epoch
           WHERE w.run_id = ? AND m.result_hash IS NOT NULL`,
        )
        .all("large-resume-run") as Array<{
        messageId: string;
        outcome: WorkflowRunnerResponse["outcome"];
        revision: number | null;
        resultHash: Buffer;
      }>;
      const frameBytes = resultRows.map(
        (row) =>
          encodeRunnerLine({
            schema: "pi-workflows.worker-response.v1",
            messageId: row.messageId,
            outcome: row.outcome,
            ...(row.revision === null ? {} : { revision: row.revision }),
            result: completedStore.state.readJson(row.resultHash),
          }).byteLength,
      );
      const pageCount = completedStore.state.connection.pragma("page_count", { simple: true });
      const pageSize = completedStore.state.connection.pragma("page_size", { simple: true });
      expect(history.bytes).toBeGreaterThan(2 * 1024 * 1024);
      expect(resultBlobs.count).toBeGreaterThan(1);
      expect(resultBlobs.bytes).toBeLessThan(history.bytes);
      expect(Math.max(...frameBytes)).toBeLessThan(MAX_WORKFLOW_RUNNER_PROTOCOL_MESSAGE_BYTES);
      expect((pageCount as number) * (pageSize as number)).toBeLessThan(history.bytes * 4);
      completedStore.close();
    } finally {
      await client.close();
      await host.stop();
    }
  }, 60_000);

  it("prunes expired state after recovery and after a later runner exit", async () => {
    const cwd = await makeTempDir("host-automatic-prune-project");
    const databasePath = path.join(await makeTempDir("host-automatic-prune-state"), "state.sqlite");
    const workflowPath = await writeComputeWorkflow(cwd);
    const seedStore = new WorkflowRunStore(databasePath);
    try {
      const seedEngine = new WorkflowEngine({
        store: seedStore,
        executor: new ScriptedExecutor().respond("reply", { output: { reply: "first" } }),
      });
      await seedEngine.run(echoWorkflow, {}, { runId: "automatic-prune-first" });
      seedStore.state.connection
        .prepare("UPDATE runs SET finished_at = ? WHERE run_id = ?")
        .run(Date.now() - AUTOMATIC_STATE_RETENTION_MS - 1, "automatic-prune-first");
    } finally {
      seedStore.close();
    }

    const logs: string[] = [];
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      onLog: (message) => logs.push(message),
    });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await waitUntil(() => {
        const store = new WorkflowRunStore(databasePath, { readOnly: true });
        try {
          return store.readRun("automatic-prune-first") === null;
        } finally {
          store.close();
        }
      }, 10_000);
      await expect(client.getRun("automatic-prune-first")).resolves.toBeNull();

      const laterStore = new WorkflowRunStore(databasePath);
      try {
        const laterEngine = new WorkflowEngine({
          store: laterStore,
          executor: new ScriptedExecutor().respond("reply", { output: { reply: "later" } }),
        });
        await laterEngine.run(echoWorkflow, {}, { runId: "automatic-prune-later" });
        laterStore.state.connection
          .prepare("UPDATE runs SET finished_at = ? WHERE run_id = ?")
          .run(Date.now() - AUTOMATIC_STATE_RETENTION_MS - 1, "automatic-prune-later");
      } finally {
        laterStore.close();
      }

      const internal = host as unknown as {
        lastAutomaticStatePruneAt: number | null;
        requestAutomaticStatePrune(): void;
      };
      internal.requestAutomaticStatePrune();
      internal.requestAutomaticStatePrune();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const throttled = new WorkflowRunStore(databasePath, { readOnly: true });
      expect(throttled.readRun("automatic-prune-later")).not.toBeNull();
      throttled.close();

      internal.lastAutomaticStatePruneAt = Date.now() - AUTOMATIC_STATE_PRUNE_INTERVAL_MS - 1;
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "automatic-prune-trigger",
      });
      await waitUntil(() => {
        const store = new WorkflowRunStore(databasePath, { readOnly: true });
        try {
          return store.readRun("automatic-prune-later") === null;
        } finally {
          store.close();
        }
      }, 30_000);
      await waitUntil(
        () =>
          logs.filter((message) => message.startsWith("automatic state prune completed")).length ===
          2,
      );
      const settled = new WorkflowRunStore(databasePath, { readOnly: true });
      const settlement = settled.state.connection
        .prepare(
          `SELECT e.status
           FROM effects e JOIN runs r ON r.resource_id = e.source_resource_id
           WHERE r.run_id = ? AND e.effect_type = 'run.settle_queue'`,
        )
        .get("automatic-prune-trigger") as { status: string } | undefined;
      expect(settlement?.status).toBe("applied");
      settled.close();
    } finally {
      await client.close();
      await host.stop();
    }
  }, 60_000);

  it("keeps cleanup failures nonfatal and does not retry them in a tight loop", async () => {
    const databasePath = path.join(
      await makeTempDir("host-automatic-prune-failure"),
      "state.sqlite",
    );
    const logs: string[] = [];
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      onLog: (message) => logs.push(message),
    });
    const lockPath = `${databasePath}.maintenance.lock`;
    await fs.writeFile(lockPath, "busy");
    await host.start();
    try {
      await waitUntil(
        () =>
          logs.filter((message) => message.startsWith("automatic state prune failed")).length === 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        logs.filter((message) => message.startsWith("automatic state prune failed")),
      ).toHaveLength(1);

      await fs.rm(lockPath);
      const internal = host as unknown as {
        nextAutomaticStatePruneAttemptAt: number;
        requestAutomaticStatePrune(): void;
      };
      internal.nextAutomaticStatePruneAttemptAt = 0;
      internal.requestAutomaticStatePrune();
      await waitUntil(() =>
        logs.some((message) => message.startsWith("automatic state prune completed")),
      );
    } finally {
      await fs.rm(lockPath, { force: true });
      await host.stop();
    }
  });

  it("resolves a protected decision timeout and resumes the same run", async () => {
    const cwd = await makeTempDir("host-decision-timeout-project");
    const databasePath = path.join(
      await makeTempDir("host-decision-timeout-state"),
      "state.sqlite",
    );
    const workflowPath = await writeTimedDecisionWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    await host.start();
    try {
      await startRun({
        client: new WorkflowClient({ databasePath }),
        cwd,
        workflowPath,
        runId: "decision-timeout-parent",
        executionMode: "interactive",
      });
      let decisionId: string | undefined;
      await waitUntil(() => {
        const queue = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          const decision = queue.state.connection
            .prepare(
              `SELECT h.decision_id AS decisionId, r.provenance
               FROM human_decisions h
               LEFT JOIN human_decision_resolutions r ON r.decision_id = h.decision_id
               WHERE h.run_id = ? LIMIT 1`,
            )
            .get("decision-timeout-parent") as
            | { decisionId: string; provenance: string | null }
            | undefined;
          decisionId = decision?.decisionId;
          if (decision?.provenance !== "timeout_policy") return false;
          expect(queue.listWorkflowRuns()).toHaveLength(1);
          return queue.getWorkflowRun("decision-timeout-parent")?.status === "done";
        } finally {
          queue.close();
        }
      }, 30_000);
      if (decisionId === undefined) throw new Error("timed decision was not created");
      const state = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(state.getInteraction(decisionId)?.status).toBe("settled");
      } finally {
        state.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("keeps the host available and reports an invalid channel configuration", async () => {
    const databasePath = path.join(await makeTempDir("host-channel-invalid-state"), "state.sqlite");
    const configDir = await makeTempDir("host-channel-invalid-config");
    await fs.writeFile(
      path.join(configDir, "channels.json"),
      `${JSON.stringify({
        schema: "pi-workflows.channels.v1",
        audiences: {
          operator: { channels: ["unsupported"], accept: "first-valid-answer" },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      env: { PI_WORKFLOWS_CONFIG_DIR: configDir },
    });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      expect(await client.request({ operation: "server.status" })).toMatchObject({
        outcome: "accepted",
      });
      await expect
        .poll(async () => await client.request({ operation: "channel.status" }))
        .toMatchObject({
          outcome: "accepted",
          receipt: {
            configured: false,
            error: expect.stringContaining("references unknown channel"),
          },
        });
    } finally {
      await client.close();
      await host.stop();
    }
  });

  it("supervises Telegram presentation, answer, and settlement through the host", async () => {
    const cwd = await makeTempDir("host-channel-project");
    const databasePath = path.join(await makeTempDir("host-channel-state"), "state.sqlite");
    const configDir = await makeTempDir("host-channel-config");
    const tokenFile = path.join(configDir, "telegram-token");
    const logPath = path.join(configDir, "adapter-log.jsonl");
    await fs.writeFile(tokenFile, "fixture-token\n", { mode: 0o600 });
    await fs.writeFile(
      path.join(configDir, "channels.json"),
      `${JSON.stringify({
        schema: "pi-workflows.channels.v1",
        audiences: {
          operator: {
            channels: ["pi", "telegram:approval"],
            accept: "first-valid-answer",
          },
        },
        telegramProfiles: {
          approval: {
            credential: "approval",
            allowedUserIds: ["100"],
            allowedChatIds: ["-200"],
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(configDir, "credentials.json"),
      `${JSON.stringify({
        schema: "pi-workflows.credentials.v1",
        telegram: { approval: { tokenFile } },
      })}\n`,
      { mode: 0o600 },
    );
    const adapterEntryPath = await writeFakeChannelAdapter(cwd);
    const workflowPath = await writeChannelDecisionWorkflow(cwd);
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      channelAdapterEntryPath: adapterEntryPath,
      env: {
        PI_WORKFLOWS_CONFIG_DIR: configDir,
        PI_WORKFLOWS_CHANNEL_TEST_LOG: logPath,
      },
    });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "channel-decision-parent",
        executionMode: "interactive",
      });
      await waitUntil(() => {
        const queue = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return queue
            .listWorkflowRuns()
            .some((run) => run.runId === "channel-decision-parent" && run.status === "done");
        } finally {
          queue.close();
        }
      }, 30_000);
      await waitUntil(() => {
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          return (
            state.state.connection
              .prepare(
                "SELECT status FROM channel_messages WHERE purpose = 'settlement' AND status = 'confirmed'",
              )
              .get() !== undefined
          );
        } finally {
          state.close();
        }
      }, 30_000);
    } finally {
      await client.close();
      await host.stop();
    }
    const lines = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    expect(lines.map((line) => line.kind)).toEqual(
      expect.arrayContaining(["present", "answer", "settle"]),
    );
    const state = new ServerStateStore(databasePath, { readOnly: true });
    try {
      expect(
        state.state.connection
          .prepare(
            "SELECT status FROM channel_messages WHERE purpose = 'delivery' AND status = 'confirmed'",
          )
          .get(),
      ).toEqual({ status: "confirmed" });
      expect(
        state.state.connection
          .prepare(
            "SELECT status FROM channel_messages WHERE purpose = 'settlement' AND status = 'confirmed'",
          )
          .get(),
      ).toEqual({ status: "confirmed" });
    } finally {
      state.close();
    }
  }, 60_000);

  it("marks an interrupted Telegram effect ambiguous and retries only after explicit recovery", async () => {
    const cwd = await makeTempDir("host-channel-crash-project");
    const databasePath = path.join(await makeTempDir("host-channel-crash-state"), "state.sqlite");
    const configDir = await makeTempDir("host-channel-crash-config");
    const tokenFile = path.join(configDir, "telegram-token");
    const logPath = path.join(configDir, "adapter.log");
    await fs.writeFile(tokenFile, "test-token\n", { mode: 0o600 });
    await fs.writeFile(
      path.join(configDir, "channels.json"),
      `${JSON.stringify({
        schema: "pi-workflows.channels.v1",
        audiences: {
          operator: {
            channels: ["pi", "telegram:approval"],
            accept: "first-valid-answer",
          },
        },
        telegramProfiles: {
          approval: {
            credential: "approval",
            allowedUserIds: ["100"],
            allowedChatIds: ["-200"],
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(configDir, "credentials.json"),
      `${JSON.stringify({
        schema: "pi-workflows.credentials.v1",
        telegram: { approval: { tokenFile } },
      })}\n`,
      { mode: 0o600 },
    );
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      channelAdapterEntryPath: await writeCrashingChannelAdapter(cwd),
      env: {
        PI_WORKFLOWS_CONFIG_DIR: configDir,
        PI_WORKFLOWS_CHANNEL_TEST_LOG: logPath,
      },
    });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      const subscribed = await client.request({
        operation: "view.session.watch",
        payload: {
          subscriptionId: "channel-crash-session",
          sessionId: "host-test-session",
          coordinator: true,
        },
      });
      const coordinatorEpoch = (subscribed.receipt as { coordinatorEpoch?: string } | undefined)
        ?.coordinatorEpoch;
      if (coordinatorEpoch === undefined) throw new Error("coordinator epoch missing");
      await client.request({
        operation: "workflowMessage.reportBranch",
        payload: {
          targetSessionId: "host-test-session",
          coordinatorEpoch,
          entries: [],
          isIdle: true,
          hasPendingMessages: false,
        },
      });
      await startRun({
        client,
        cwd,
        workflowPath: await writeChannelDecisionWorkflow(cwd),
        runId: "channel-crash-parent",
        executionMode: "interactive",
      });
      await waitUntil(() => {
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          return (
            state.state.connection
              .prepare(
                "SELECT 1 FROM effects WHERE owner_scope = 'channel' AND status = 'ambiguous' AND attempt_count = 1",
              )
              .get() !== undefined
          );
        } finally {
          state.close();
        }
      }, 30_000);
      const firstStatus = await client.request({ operation: "channel.status" });
      const firstAmbiguous = (firstStatus.receipt as { ambiguous?: Array<{ messageId: string }> })
        .ambiguous?.[0]?.messageId;
      if (firstAmbiguous === undefined) throw new Error("ambiguous channel message missing");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(1);

      const recoveryId = "channel-crash-retry";
      const recovery = await client.request({
        operation: "channel.recover",
        idempotencyKey: recoveryId,
        payload: {
          targetSessionId: "host-test-session",
          coordinatorEpoch,
          messageId: firstAmbiguous,
          action: "retry",
        },
      });
      expect(recovery).toMatchObject({ outcome: "accepted" });
      await waitUntil(() => {
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          return (
            state.state.connection
              .prepare(
                "SELECT 1 FROM effects WHERE owner_scope = 'channel' AND status = 'ambiguous' AND attempt_count = 2",
              )
              .get() !== undefined
          );
        } finally {
          state.close();
        }
      }, 30_000);
      const secondStatus = await client.request({ operation: "channel.status" });
      const secondAmbiguous = (
        secondStatus.receipt as {
          ambiguous?: Array<{ messageId: string }>;
        }
      ).ambiguous?.[0]?.messageId;
      if (secondAmbiguous === undefined) throw new Error("second ambiguous message missing");
      expect(secondAmbiguous).not.toBe(firstAmbiguous);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(2);

      const confirmId = "channel-crash-confirm";
      expect(
        await client.request({
          operation: "channel.recover",
          idempotencyKey: confirmId,
          payload: {
            targetSessionId: "host-test-session",
            coordinatorEpoch,
            messageId: secondAmbiguous,
            action: "confirm",
          },
        }),
      ).toMatchObject({ outcome: "accepted" });
      const state = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(
          state.state.connection
            .prepare("SELECT status FROM effects WHERE owner_scope = 'channel'")
            .get(),
        ).toEqual({ status: "applied" });
        expect(
          state.state.connection
            .prepare(
              "SELECT 1 AS present FROM channel_messages WHERE purpose = 'delivery' AND status = 'confirmed'",
            )
            .get(),
        ).toEqual({ present: 1 });
      } finally {
        state.close();
      }
    } finally {
      await client.close();
      await host.stop();
    }
  }, 60_000);

  it("closes active time atomically when pausing a validating interaction", async () => {
    const cwd = await makeTempDir("pause-validation-project");
    const databasePath = path.join(await makeTempDir("pause-validation-state"), "state.sqlite");
    const workflowPath = path.join(cwd, "validation.workflow.ts");
    const started = path.join(cwd, "validation.started");
    await fs.writeFile(
      workflowPath,
      `
import fs from "node:fs";
import { agent, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({ name: "pause-validation", startAt: "work", nodes: {
  work: agent({ timeoutMs: 60000, prompt: () => "Return a result.", validate: async (result, ctx) => {
    fs.writeFileSync(${JSON.stringify(started)}, "started");
    while (!ctx.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
    ctx.signal.throwIfAborted();
    return result;
  } })
}, edges: [] });`,
    );
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    const observed = new ServerStateStore(databasePath, { readOnly: true });
    let submission: Promise<unknown> | undefined;
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "pause-validation",
        executionMode: "interactive",
      });
      await waitUntil(
        () => observed.listPendingInteractions("host-test-session").length === 1,
        30_000,
      );
      const interaction = observed.listPendingInteractions("host-test-session")[0];
      if (interaction === undefined) throw new Error("request missing");
      const message = observed.workflowMessages
        .listRun(interaction.runId)
        .find((item) => item.sourceId === interaction.requestId);
      if (message === undefined) throw new Error("step message missing");
      const authority = await ownSession(client);
      expect(
        await client.request({
          operation: "workflowMessage.reportBranch",
          payload: {
            ...authority,
            entries: [
              { workflowMessageId: message.workflowMessageId, piSessionEntryId: "step-entry" },
            ],
            isIdle: false,
            hasPendingMessages: false,
          },
        }),
      ).toMatchObject({ outcome: "accepted" });
      expect(
        await client.request({
          operation: "workflowTurn.report",
          payload: {
            ...authority,
            state: "started",
            runId: interaction.runId,
            workflowMessageId: message.workflowMessageId,
            workflowTurnId: "validation-turn",
          },
        }),
      ).toMatchObject({ outcome: "accepted" });
      submission = client
        .request({
          operation: "interaction.submit",
          payload: {
            ...authority,
            requestId: interaction.requestId,
            submissionId: "validation-result",
            value: { output: { done: true } },
          },
        })
        .catch((error) => error);
      await vi.waitFor(
        async () => {
          await fs.access(started);
        },
        { timeout: 30_000 },
      );
      const timing = () =>
        observed.state.connection
          .prepare(
            "SELECT SUM(elapsed_ms) AS elapsedMs, SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS openIntervals FROM attempt_active_intervals WHERE attempt_id = ?",
          )
          .get(interaction.attemptId) as { elapsedMs: number; openIntervals: number };
      expect(timing().openIntervals).toBe(1);
      expect(
        await client.request({ operation: "run.pause", runId: interaction.runId }),
      ).toMatchObject({ outcome: "accepted" });
      const paused = timing();
      expect(paused.openIntervals).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(timing()).toEqual(paused);
      expect(await client.request({ operation: "state.verify" })).toMatchObject({
        outcome: "accepted",
      });
    } finally {
      await client.close();
      await submission;
      await host.stop();
      observed.close();
    }
  }, 45_000);

  it("counts only active model time across overlapping pause, disconnect, and host recovery", async () => {
    const cwd = await makeTempDir("host-interaction-timeout-project");
    const databasePath = path.join(
      await makeTempDir("host-interaction-timeout-state"),
      "state.sqlite",
    );
    const workflowPath = await writeTimedInteractiveWorkflow(cwd, 1_500);
    let host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    let client = new WorkflowClient({ databasePath });
    await host.start();
    const state = new ServerStateStore(databasePath, { readOnly: true });
    const runId = "interaction-timeout-run";
    const timing = () =>
      state.state.connection
        .prepare(
          `SELECT a.status, a.started_at AS startedAt, a.timeout_ms AS timeoutMs,
         (SELECT COALESCE(SUM(elapsed_ms), 0) FROM attempt_active_intervals t WHERE t.attempt_id = a.attempt_id) AS elapsedMs,
         (SELECT COUNT(*) FROM attempt_active_intervals t WHERE t.attempt_id = a.attempt_id AND t.ended_at IS NULL) AS openIntervals
       FROM node_attempts a JOIN interactive_requests i ON i.attempt_id = a.attempt_id WHERE i.run_id = ?`,
        )
        .get(runId) as {
        status: string;
        startedAt: number;
        timeoutMs: number;
        elapsedMs: number;
        openIntervals: number;
      };
    const connect = async (message: WorkflowMessage, isIdle: boolean) => {
      const watched = await client.request({
        operation: "view.session.watch",
        payload: {
          subscriptionId: "timeout-watch",
          sessionId: "host-test-session",
          coordinator: true,
        },
      });
      const coordinatorEpoch = (watched.receipt as { coordinatorEpoch: string }).coordinatorEpoch;
      expect(
        await client.request({
          operation: "workflowMessage.reportBranch",
          payload: {
            targetSessionId: "host-test-session",
            coordinatorEpoch,
            entries: [
              { workflowMessageId: message.workflowMessageId, piSessionEntryId: "step-entry" },
            ],
            isIdle,
            hasPendingMessages: !isIdle,
          },
        }),
      ).toMatchObject({ outcome: "accepted" });
      return coordinatorEpoch;
    };
    try {
      await startRun({ client, cwd, workflowPath, runId, executionMode: "interactive" });
      await waitUntil(
        () => state.listPendingInteractions("host-test-session").length === 1,
        30_000,
      );
      const interaction = state.listPendingInteractions("host-test-session")[0];
      if (interaction === undefined) throw new Error("request missing");
      const initial = timing();
      expect(initial).toMatchObject({ timeoutMs: 1_500, elapsedMs: 0, openIntervals: 0 });
      expect(await client.request({ operation: "run.pause", runId })).toMatchObject({
        outcome: "accepted",
      });
      await client.close();
      await host.stop();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      host = new WorkflowServer({ databasePath, claimPollMs: 10 });
      client = new WorkflowClient({ databasePath });
      await host.start();
      expect(timing()).toEqual(initial);
      expect(state.getInteraction(interaction.requestId)?.status).toBe("pending");
      await client.request({ operation: "run.resume", runId });
      const message = state.workflowMessages
        .listSession("host-test-session")
        .findLast((candidate) => candidate.sourceId === interaction.requestId);
      if (message === undefined) throw new Error("resumed message missing");
      let coordinatorEpoch = await connect(message, false);
      const turn = {
        state: "started",
        workflowMessageId: message.workflowMessageId,
        workflowTurnId: "active-turn",
        runId,
        targetSessionId: "host-test-session",
      };
      expect(
        await client.request({
          operation: "workflowTurn.report",
          runId,
          payload: { ...turn, coordinatorEpoch },
        }),
      ).toMatchObject({ outcome: "accepted", receipt: { ownership: "active" } });
      expect(
        await client.request({
          operation: "workflowTurn.report",
          runId,
          payload: { ...turn, coordinatorEpoch },
        }),
      ).toMatchObject({ outcome: "adopted" });
      await waitUntil(() => timing().elapsedMs >= 50, 30_000);
      expect(timing().openIntervals).toBe(1);
      await client.request({ operation: "run.pause", runId });
      const paused = timing();
      expect(paused.openIntervals).toBe(0);
      await client.close(); // Disconnect overlaps the pause, not a second duration subtraction.
      await waitUntil(() => timing().status === "interrupted", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      expect(timing().elapsedMs).toBe(paused.elapsedMs);
      client = new WorkflowClient({ databasePath });
      coordinatorEpoch = await connect(message, false);
      expect(timing().openIntervals).toBe(0); // Reconnect does not override the durable pause.
      await client.request({ operation: "run.resume", runId });
      expect(timing().openIntervals).toBe(1);
      await waitUntil(() => timing().elapsedMs >= paused.elapsedMs + 50, 30_000);
      await client.close();
      await waitUntil(() => timing().status === "interrupted", 30_000);
      const disconnected = timing();
      await host.stop();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      host = new WorkflowServer({ databasePath, claimPollMs: 10 });
      client = new WorkflowClient({ databasePath });
      await host.start();
      expect(timing().elapsedMs).toBe(disconnected.elapsedMs);
      expect(timing().openIntervals).toBe(0);
      expect(state.getInteraction(interaction.requestId)?.status).toBe("pending");
      await connect(message, false);
      await waitUntil(() => timing().status === "timed_out", 30_000);
      expect(timing()).toMatchObject({
        startedAt: initial.startedAt,
        timeoutMs: 1_500,
        openIntervals: 0,
      });
      expect(timing().elapsedMs).toBeGreaterThanOrEqual(1_500);
      expect(state.getInteraction(interaction.requestId)?.status).toBe("cancelled");
    } finally {
      state.close();
      await client.close();
      await host.stop();
    }
  }, 60_000);

  it("rejects changed mounted source before the resumed child executes it", async () => {
    const cwd = await makeTempDir("host-mounted-source-project");
    const databasePath = path.join(await makeTempDir("host-mounted-source-state"), "state.sqlite");
    const markerPath = path.join(cwd, "changed-source-executed");
    const { workflowPath, childPath } = await writeIncludedInteractiveWorkflow(cwd);
    const first = new WorkflowServer({
      databasePath,
      runnerId: "host-source-first",
      claimPollMs: 10,
    });
    await first.start();
    await startRun({
      client: new WorkflowClient({ databasePath }),
      cwd,
      workflowPath,
      runId: "mounted-source-run",
      executionMode: "interactive",
    });
    let interaction: InteractiveRequestRecord | undefined;
    await waitUntil(() => {
      const observed = new ServerStateStore(databasePath, { readOnly: true });
      try {
        interaction = observed.listPendingInteractions("host-test-session")[0];
        return interaction !== undefined;
      } finally {
        observed.close();
      }
    }, 30_000);
    await first.stop();
    if (interaction === undefined) throw new Error("interaction was not created");
    const changedSourceInteraction = interaction;
    const state = new ServerStateStore(databasePath);
    state.beginInteractionValidation({
      requestId: changedSourceInteraction.requestId,
      submissionId: "changed-source-submission",
      idempotencyKey: "changed-source-submission",
      expectedRevision: changedSourceInteraction.revision,
      payload: { output: { answer: "done" } },
      receipt: { status: "validating" },
    });
    state.close();
    await fs.writeFile(
      childPath,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(markerPath)}, "executed");
export { default } from ${JSON.stringify(path.resolve("examples/workflows/echo.workflow.ts"))};\n`,
    );

    const restarted = new WorkflowServer({
      databasePath,
      runnerId: "host-source-restarted",
      claimPollMs: 10,
    });
    await restarted.start();
    try {
      await waitUntil(() => {
        const observed = new ServerStateStore(databasePath, { readOnly: true });
        try {
          return (
            observed.interactionSubmission(
              changedSourceInteraction.requestId,
              "changed-source-submission",
            )?.outcome === "rejected"
          );
        } finally {
          observed.close();
        }
      }, 30_000);
      await expect(fs.access(markerPath)).rejects.toThrow();
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  it("fails a workflow load error without starting a replacement worker", async () => {
    const cwd = await makeTempDir("host-source-load-project");
    const databasePath = path.join(await makeTempDir("host-source-load-state"), "state.sqlite");
    const workflowPath = await writeComputeWorkflow(cwd);
    const originalSource = await fs.readFile(workflowPath, "utf8");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
      await fs.writeFile(workflowPath, `${originalSource}\n// changed before worker load\n`);
      const response = await client.request({
        operation: "run.start",
        runId: "source-load-run",
        payload: {
          projectPath: cwd,
          workflowName: resolved.workflowName,
          workflowSourceRef: resolved.workflowSourceRef,
          workflowSource: resolved.workflowSource,
          definitionDigest: resolved.definitionDigest,
          definitionSnapshot: resolved.definitionSnapshot,
          input: { value: 1 },
          launchOptions: {},
          originSessionId: "host-test-session",
          executionMode: "interactive",
        },
      });
      expect(response.outcome).toBe("accepted");
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("source-load-run")?.errorCode === "workflowLoadFailed";
        } finally {
          store.close();
        }
      }, 30_000);
      const failed = new WorkflowRunQueueStore(databasePath, {
        readOnly: true,
        global: true,
      });
      try {
        const workers = failed.state.connection
          .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
          .get("source-load-run") as { count: number };
        expect(workers.count).toBe(1);
        const terminalMessages = failed.state.connection
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_messages WHERE run_id = ? AND kind = 'terminal'",
          )
          .get("source-load-run") as { count: number };
        expect(terminalMessages.count).toBe(1);
      } finally {
        failed.close();
      }

      await fs.writeFile(workflowPath, originalSource);
      await expect(
        client.request({ operation: "run.resume", runId: "source-load-run" }),
      ).resolves.toMatchObject({ outcome: "rejected" });
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("does not restart a worker that exits before workflow progress", async () => {
    const cwd = await makeTempDir("host-worker-no-progress-project");
    const databasePath = path.join(
      await makeTempDir("host-worker-no-progress-state"),
      "state.sqlite",
    );
    const workflowPath = await writeComputeWorkflow(cwd);
    const runnerPath = path.join(cwd, "worker-no-progress.mjs");
    await fs.writeFile(runnerPath, "process.exit(1);\n", "utf8");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10, runnerEntryPath: runnerPath });
    const client = new WorkflowClient({ databasePath, clientId: "worker-no-progress-client" });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "worker-no-progress-run" });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("worker-no-progress-run")?.errorCode === "runnerNoProgress";
        } finally {
          store.close();
        }
      }, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("worker-no-progress-run")).toMatchObject({
          status: "parked",
          errorCode: "runnerNoProgress",
        });
        expect(
          store.state.connection
            .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
            .get("worker-no-progress-run"),
        ).toEqual({ count: 1 });
      } finally {
        store.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("commits active cancellation before it returns the durable receipt", async () => {
    const cwd = await makeTempDir("host-cancel-project");
    const databasePath = path.join(await makeTempDir("host-cancel-state"), "state.sqlite");
    const workflowPath = await writeBlockingWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "cancel-client" });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "cancel-run",
        executionMode: "interactive",
      });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("cancel-run")?.status === "running";
        } finally {
          store.close();
        }
      }, 30_000);
      const terminalRead = vi
        .spyOn(WorkflowRunStore.prototype, "readTerminalData")
        .mockImplementation(() => {
          throw new Error("Injected terminal reporting failure");
        });
      const cancelled = await client.request({
        operation: "run.cancel",
        runId: "cancel-run",
        requestId: "cancel-request",
        idempotencyKey: "cancel-request",
      });
      expect(cancelled).toMatchObject({
        outcome: "accepted",
        receipt: { runId: "cancel-run", status: "cancelled" },
      });
      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("cancel-run")?.status).toBe("cancelled");
        expect(
          store.state.connection
            .prepare(
              "SELECT COUNT(*) AS count FROM workflow_messages WHERE run_id = ? AND kind = 'terminal'",
            )
            .get("cancel-run"),
        ).toEqual({ count: 0 });
      } finally {
        store.close();
      }

      terminalRead.mockRestore();
      await waitUntil(() => {
        const repaired = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          const terminalMessages = repaired.state.connection
            .prepare(
              "SELECT COUNT(*) AS count FROM workflow_messages WHERE run_id = ? AND kind = 'terminal'",
            )
            .get("cancel-run") as { count: number };
          return terminalMessages.count === 1;
        } finally {
          repaired.close();
        }
      }, 30_000);

      await expect(
        client.request({
          operation: "run.cancel",
          runId: "cancel-run",
          requestId: "cancel-request",
          idempotencyKey: "cancel-request",
        }),
      ).resolves.toMatchObject({ outcome: "adopted", receipt: { status: "cancelled" } });
    } finally {
      vi.restoreAllMocks();
      await host.stop();
    }
  }, 45_000);

  it("adopts a late turn end after terminal cleanup settles the turn", async () => {
    const cwd = await makeTempDir("host-late-turn-project");
    const databasePath = path.join(await makeTempDir("host-late-turn-state"), "state.sqlite");
    const workflowPath = await writeInteractiveWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "late-turn-client" });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "late-turn-run",
        executionMode: "interactive",
      });
      let message: WorkflowMessage | undefined;
      await waitUntil(() => {
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          message = state.workflowMessages
            .listSession("host-test-session")
            .find((candidate) => candidate.kind === "step");
          return message !== undefined;
        } finally {
          state.close();
        }
      }, 30_000);
      if (message === undefined) throw new Error("workflow step message missing");
      await waitUntil(() => {
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          const worker = state.state.connection
            .prepare(
              `SELECT status FROM run_workers
               WHERE run_id = ? ORDER BY started_at DESC LIMIT 1`,
            )
            .get("late-turn-run") as { status: string } | undefined;
          return worker !== undefined && !["starting", "ready", "running"].includes(worker.status);
        } finally {
          state.close();
        }
      }, 30_000);

      const subscribed = await client.request({
        operation: "view.session.watch",
        payload: {
          subscriptionId: "late-turn-session",
          sessionId: "host-test-session",
          coordinator: true,
        },
      });
      const coordinatorEpoch = (subscribed.receipt as { coordinatorEpoch?: string } | undefined)
        ?.coordinatorEpoch;
      if (coordinatorEpoch === undefined) throw new Error("coordinator epoch missing");
      await client.request({
        operation: "workflowMessage.reportBranch",
        payload: {
          targetSessionId: "host-test-session",
          coordinatorEpoch,
          entries: [
            {
              workflowMessageId: message.workflowMessageId,
              piSessionEntryId: "late-turn-entry",
            },
          ],
          isIdle: false,
          hasPendingMessages: true,
        },
      });
      const started = {
        state: "started" as const,
        workflowMessageId: message.workflowMessageId,
        workflowTurnId: "late-turn-1",
        runId: message.runId,
        targetSessionId: message.targetSessionId,
        coordinatorEpoch,
      };
      await expect(
        client.request({
          operation: "workflowTurn.report",
          runId: message.runId,
          payload: started,
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { ownership: "active", turn: { state: "started" } },
      });
      await expect(
        client.request({
          operation: "run.cancel",
          runId: message.runId,
          requestId: "late-turn-cancel",
          idempotencyKey: "late-turn-cancel",
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { runId: "late-turn-run", status: "cancelled" },
      });
      await expect(
        client.request({
          operation: "workflowTurn.report",
          runId: message.runId,
          payload: {
            ...started,
            state: "ended",
            stopReason: "error",
            responseSessionEntryId: null,
          },
        }),
      ).resolves.toMatchObject({
        outcome: "adopted",
        receipt: {
          ownership: "settled",
          turn: { state: "ended", stopReason: "lost" },
        },
      });
      await expect(
        client.request({
          operation: "workflowTurn.report",
          runId: message.runId,
          payload: {
            ...started,
            workflowMessageId: "other-workflow-message",
            state: "ended",
            stopReason: "error",
            responseSessionEntryId: null,
          },
        }),
      ).resolves.toMatchObject({
        outcome: "rejected",
        error: "Workflow message not found: other-workflow-message",
      });

      const state = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(state.workflowMessages.requireTurn("late-turn-1")).toMatchObject({
          state: "ended",
          stopReason: "lost",
        });
        expect(
          state.state.connection
            .prepare("SELECT COUNT(*) AS count FROM workflow_turns WHERE workflow_message_id = ?")
            .get(message.workflowMessageId),
        ).toEqual({ count: 1 });
      } finally {
        state.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("cancels a committed run before its scheduled activation starts", async () => {
    const cwd = await makeTempDir("host-cancel-pending-project");
    const databasePath = path.join(await makeTempDir("host-cancel-pending-state"), "state.sqlite");
    const workflowPath = await writeComputeWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      const resolved = await client.resolveWorkflow({ cwd, workflowRef: workflowPath });
      const runId = "cancel-pending-run";
      const responses = await sendServerPipeline(host.endpoint, [
        {
          schema: "pi-workflows.client.v1",
          type: "request",
          requestId: "pending-start-request",
          clientId: "pending-cancel-client",
          operation: "run.start",
          idempotencyKey: "pending-start-request",
          runId,
          payload: {
            projectPath: cwd,
            workflowName: resolved.workflowName,
            workflowSourceRef: resolved.workflowSourceRef,
            workflowSource: resolved.workflowSource,
            definitionDigest: resolved.definitionDigest,
            definitionSnapshot: resolved.definitionSnapshot,
            input: { value: 1 },
            launchOptions: {},
            originSessionId: "host-test-session",
            executionMode: "headless",
          },
        },
        {
          schema: "pi-workflows.client.v1",
          type: "request",
          requestId: "pending-cancel-request",
          clientId: "pending-cancel-client",
          operation: "run.cancel",
          idempotencyKey: "pending-cancel-request",
          runId,
          payload: null,
        },
      ]);
      expect(responses).toMatchObject([
        { requestId: "pending-start-request", outcome: "accepted" },
        {
          requestId: "pending-cancel-request",
          outcome: "accepted",
          receipt: { runId, status: "cancelled" },
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun(runId)?.status).toBe("cancelled");
        const workers = store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
          .get(runId) as { count: number };
        expect(workers.count).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      await host.stop();
    }
  });

  it("cancels a parked interaction in the same durable transition", async () => {
    const cwd = await makeTempDir("host-cancel-interaction-project");
    const databasePath = path.join(
      await makeTempDir("host-cancel-interaction-state"),
      "state.sqlite",
    );
    const workflowPath = await writeInteractiveWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "cancel-interaction-client" });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "cancel-interaction-run",
        executionMode: "interactive",
      });
      let interaction: InteractiveRequestRecord | undefined;
      await waitUntil(() => {
        const state = new ServerStateStore(databasePath, { readOnly: true });
        try {
          interaction = state.listPendingInteractions("host-test-session")[0];
          const worker = state.state.connection
            .prepare(
              `SELECT status FROM run_workers
               WHERE run_id = ? ORDER BY started_at DESC LIMIT 1`,
            )
            .get("cancel-interaction-run") as { status: string } | undefined;
          return (
            interaction !== undefined &&
            worker !== undefined &&
            !["starting", "ready", "running"].includes(worker.status)
          );
        } finally {
          state.close();
        }
      }, 30_000);
      if (interaction === undefined) throw new Error("interaction was not created");

      await expect(
        client.request({
          operation: "run.cancel",
          runId: "cancel-interaction-run",
          requestId: "cancel-interaction-request",
          idempotencyKey: "cancel-interaction-request",
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { runId: "cancel-interaction-run", status: "cancelled" },
      });

      const state = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(state.getInteraction(interaction.requestId)?.status).toBe("cancelled");
        expect(state.listPendingInteractions("host-test-session")).toEqual([]);
      } finally {
        state.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("marks an applying effect ambiguous before cancellation returns", async () => {
    const cwd = await makeTempDir("host-cancel-effect-project");
    const databasePath = path.join(await makeTempDir("host-cancel-effect-state"), "state.sqlite");
    const workflowPath = await writeBlockingEffectWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath, clientId: "cancel-effect-client" });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "cancel-effect-run" });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          const effect = store.state.connection
            .prepare(
              `SELECT e.status FROM effects e
               JOIN runs r ON r.resource_id = e.source_resource_id
               WHERE r.run_id = ? AND e.effect_type = ?`,
            )
            .get("cancel-effect-run", "test.host-blocking-effect") as
            | { status: string }
            | undefined;
          return effect?.status === "applying";
        } finally {
          store.close();
        }
      }, 30_000);

      await expect(
        client.request({
          operation: "run.cancel",
          runId: "cancel-effect-run",
          requestId: "cancel-effect-request",
          idempotencyKey: "cancel-effect-request",
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { runId: "cancel-effect-run", status: "cancelled" },
      });

      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("cancel-effect-run")?.status).toBe("cancelled");
        const effect = store.state.connection
          .prepare(
            `SELECT e.effect_id AS effectId, e.status, e.settled_at AS settledAt,
                    a.outcome AS attemptOutcome
             FROM effects e
             JOIN runs r ON r.resource_id = e.source_resource_id
             JOIN effect_attempts a ON a.effect_id = e.effect_id
             WHERE r.run_id = ? AND e.effect_type = ?`,
          )
          .get("cancel-effect-run", "test.host-blocking-effect") as
          | {
              effectId: string;
              status: string;
              settledAt: number | null;
              attemptOutcome: string | null;
            }
          | undefined;
        expect(effect).toMatchObject({
          status: "ambiguous",
          attemptOutcome: "interrupted",
        });
        expect(effect?.settledAt).toEqual(expect.any(Number));
        const event = store.state.connection
          .prepare(
            `SELECT event_type AS eventType FROM events
             WHERE resource_id = (SELECT resource_id FROM effects WHERE effect_id = ?)`,
          )
          .all(effect?.effectId) as Array<{ eventType: string }>;
        expect(event.map((record) => record.eventType)).toContain("effect.ambiguous");
      } finally {
        store.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("executes workflow code only in a supervised child", async () => {
    const cwd = await makeTempDir("host-child-project");
    const databasePath = path.join(await makeTempDir("host-child-state"), "state.sqlite");
    const workflowPath = await writeComputeWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "child-run" });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("child-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);
      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        expect(store.getWorkflowRun("child-run")).toMatchObject({
          status: "done",
          executionMode: "headless",
        });
      } finally {
        store.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("stores and serves hosted notifications and terminal workflow messages", async () => {
    const cwd = await makeTempDir("host-delivery-project");
    const databasePath = path.join(await makeTempDir("host-delivery-state"), "state.sqlite");
    const workflowPath = await writeDeliveryWorkflow(cwd);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({
        client,
        cwd,
        workflowPath,
        runId: "delivery-run",
        executionMode: "interactive",
      });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("delivery-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);

      const state = new ServerStateStore(databasePath, { readOnly: true });
      const messages = state.workflowMessages.listSession("host-test-session");
      state.close();
      expect(messages.map((message) => message.kind)).toEqual(["notification", "terminal"]);
      expect(messages[0]?.content.content).toBe("ServerBacked progress.");
      expect(messages[1]?.content.content).toContain('"finalOutput":{"delivered":true}');
      expect(messages[1]?.content).toMatchObject({ display: true, triggerTurn: false });

      const subscribed = await client.request({
        operation: "view.session.watch",
        payload: {
          subscriptionId: "delivery-session",
          sessionId: "host-test-session",
          coordinator: true,
        },
      });
      const coordinatorEpoch = (subscribed.receipt as { coordinatorEpoch?: string } | undefined)
        ?.coordinatorEpoch;
      if (coordinatorEpoch === undefined) throw new Error("coordinator epoch missing");
      expect(
        await client.request({
          operation: "workflowMessage.reportBranch",
          payload: {
            targetSessionId: "host-test-session",
            coordinatorEpoch,
            entries: messages.map((message, index) => ({
              workflowMessageId: message.workflowMessageId,
              piSessionEntryId: `entry-${index + 1}`,
            })),
            isIdle: true,
            hasPendingMessages: false,
          },
        }),
      ).toMatchObject({ outcome: "accepted" });

      const terminal = messages[1];
      if (terminal === undefined) throw new Error("terminal workflow message missing");
      await expect(
        client.request({
          operation: "workflowTurn.report",
          runId: terminal.runId,
          payload: {
            state: "started",
            workflowMessageId: terminal.workflowMessageId,
            workflowTurnId: "invalid-terminal-turn",
            runId: terminal.runId,
            targetSessionId: terminal.targetSessionId,
            coordinatorEpoch,
          },
        }),
      ).resolves.toMatchObject({
        outcome: "rejected",
        error: "Workflow message does not start a model turn",
      });
      const afterStaleReport = new ServerStateStore(databasePath, { readOnly: true });
      try {
        expect(
          afterStaleReport.state.connection
            .prepare("SELECT COUNT(*) AS count FROM workflow_turns WHERE workflow_message_id = ?")
            .get(terminal.workflowMessageId),
        ).toEqual({ count: 0 });
      } finally {
        afterStaleReport.close();
      }
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("renews a live claim while workflow code blocks longer than its lease", async () => {
    const cwd = await makeTempDir("host-blocked-worker-project");
    const databasePath = path.join(await makeTempDir("host-blocked-worker-state"), "state.sqlite");
    const workflowPath = await writeBlockingWorkflow(cwd, 5_000);
    const host = new WorkflowServer({
      databasePath,
      claimPollMs: 10,
      serverRenewMs: 40,
      runClaimLeaseMs: 200,
    });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "blocked-child-run" });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("blocked-child-run")?.status === "running";
        } finally {
          store.close();
        }
      }, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        const run = store.getWorkflowRun("blocked-child-run");
        expect(run?.status).toBe("running");
        expect(Date.parse(run?.claimExpiresAt ?? "")).toBeGreaterThan(Date.now());
      } finally {
        store.close();
      }
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("blocked-child-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("retries an interrupted idempotent effect and adopts its durable reservation", async () => {
    const cwd = await makeTempDir("host-idempotent-effect-project");
    const databasePath = path.join(
      await makeTempDir("host-idempotent-effect-state"),
      "state.sqlite",
    );
    const markerPath = path.join(cwd, "effect-applied");
    const workflowPath = await writeCrashEffectWorkflow(cwd, "idempotent", markerPath);
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "idempotent-crash-run" });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          return store.getWorkflowRun("idempotent-crash-run")?.status === "done";
        } finally {
          store.close();
        }
      }, 30_000);
      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        const effect = store.state.connection
          .prepare(
            `SELECT e.status, e.attempt_count AS attemptCount FROM effects e
             JOIN runs r ON r.resource_id = e.source_resource_id
             WHERE r.run_id = ? AND e.effect_type = ?`,
          )
          .get("idempotent-crash-run", "test.host-idempotent-crash") as
          | { status: string; attemptCount: number }
          | undefined;
        expect(effect).toEqual({ status: "applied", attemptCount: 2 });
        const workers = store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
          .get("idempotent-crash-run") as { count: number };
        expect(workers.count).toBe(2);
      } finally {
        store.close();
      }
      expect(await fs.readFile(markerPath, "utf8")).toBe("applied");
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("parks an interrupted manual effect as ambiguous without retrying it", async () => {
    const cwd = await makeTempDir("host-manual-effect-project");
    const databasePath = path.join(await makeTempDir("host-manual-effect-state"), "state.sqlite");
    const workflowPath = await writeCrashEffectWorkflow(cwd, "manual");
    const host = new WorkflowServer({ databasePath, claimPollMs: 10 });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      await startRun({ client, cwd, workflowPath, runId: "manual-crash-run" });
      await waitUntil(() => {
        const store = new WorkflowRunQueueStore(databasePath, {
          readOnly: true,
          global: true,
        });
        try {
          const run = store.getWorkflowRun("manual-crash-run");
          return run?.status === "parked" && run.errorCode === "effectAmbiguous";
        } finally {
          store.close();
        }
      }, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const store = new WorkflowRunQueueStore(databasePath, { readOnly: true, global: true });
      try {
        const effect = store.state.connection
          .prepare(
            `SELECT e.status, e.attempt_count AS attemptCount FROM effects e
             JOIN runs r ON r.resource_id = e.source_resource_id
             WHERE r.run_id = ? AND e.effect_type = ?`,
          )
          .get("manual-crash-run", "test.host-manual-crash") as
          | { status: string; attemptCount: number }
          | undefined;
        expect(effect).toEqual({ status: "ambiguous", attemptCount: 1 });
        const workers = store.state.connection
          .prepare("SELECT COUNT(*) AS count FROM run_workers WHERE run_id = ?")
          .get("manual-crash-run") as { count: number };
        expect(workers.count).toBe(1);
      } finally {
        store.close();
      }
      const status = await client.request({ operation: "server.status" });
      expect(status.receipt).toMatchObject({ ambiguousEffects: 1 });
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("returns privacy-safe host status counts", async () => {
    const databasePath = path.join(await makeTempDir("host-status"), "state.sqlite");
    const host = new WorkflowServer({ databasePath });
    const client = new WorkflowClient({ databasePath });
    await host.start();
    try {
      const status = await client.request({ operation: "server.status" });
      expect(status.receipt).toMatchObject({
        state: "running",
        socketAvailable: true,
        activeRunners: 0,
        queuedRuns: 0,
        pendingInteractions: 0,
        ambiguousEffects: 0,
        lifecycleContradictions: 0,
      });
      expect(status.receipt).not.toHaveProperty("serverId");
      expect(status.receipt).not.toHaveProperty("pid");
      expect(status.receipt).not.toHaveProperty("processStartIdentity");
    } finally {
      await host.stop();
    }
  });
});
