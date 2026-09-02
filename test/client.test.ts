import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkflowClient, WorkflowClientVersionError } from "../src/client/client.js";
import {
  CLIENT_PROTOCOL_SCHEMA,
  NdjsonFrameDecoder,
  clientSocketPath,
  encodeProtocolLine,
  parseClientMessage,
  type ClientRequest,
} from "../src/client/protocol.js";
import { WorkflowHost } from "../src/host/runner.js";
import type { JsonValue } from "../src/state/json.js";
import { makeTempDir, waitUntil } from "./helpers.js";

describe("WorkflowClient", () => {
  it("keeps the cold-start retry wait referenced", async () => {
    const databasePath = path.join(await makeTempDir("client-cold-start"), "state.sqlite");
    const client = new WorkflowClient({ databasePath });
    const connect = vi
      .spyOn(client, "connect")
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue({
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "hello",
        connectionId: "cold-start",
        packageVersion: "0.15.3",
      });
    const start = vi
      .spyOn(client as unknown as { startDetached: () => void }, "startDetached")
      .mockImplementation(() => undefined);
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(client.ensureAvailable()).resolves.toMatchObject({
        connectionId: "cold-start",
      });
      const timerIndex = timers.mock.calls.findIndex((call) => call[1] === 50);
      const timer = timers.mock.results[timerIndex]?.value as NodeJS.Timeout | undefined;
      expect(timer?.hasRef()).toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      timers.mockRestore();
      await client.close();
    }
  });

  it("retries one durable invocation with the same idempotency key", async () => {
    const databasePath = path.join(await makeTempDir("client-durable-retry"), "state.sqlite");
    const client = new WorkflowClient({ databasePath });
    const request = vi
      .spyOn(client, "request")
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({
        schema: CLIENT_PROTOCOL_SCHEMA,
        type: "response",
        requestId: "retry",
        outcome: "adopted",
      });
    const available = vi.spyOn(client, "ensureAvailable").mockResolvedValue({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "hello",
      connectionId: "reconnected",
      packageVersion: "0.15.3",
    });
    try {
      await expect(
        client.requestDurable({
          operation: "state.backup",
          requestId: "first",
          idempotencyKey: "one-invocation",
          payload: { destination: "/tmp/backup.sqlite" },
        }),
      ).resolves.toMatchObject({ outcome: "adopted" });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]?.[0]).toMatchObject({
        requestId: "first",
        idempotencyKey: "one-invocation",
      });
      expect(request.mock.calls[1]?.[0]).toMatchObject({
        idempotencyKey: "one-invocation",
      });
      expect(request.mock.calls[1]?.[0].requestId).not.toBe("first");
      expect(available).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });

  it("rejects a backpressured request when its connection closes", async () => {
    const databasePath = path.join(await makeTempDir("client-drain-close"), "state.sqlite");
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    await host.start();
    const client = new WorkflowClient({ databasePath, clientId: "client-drain-close" });
    await client.connect();
    const socket = (client as unknown as { socket: net.Socket | null }).socket;
    if (socket === null) throw new Error("client socket missing");
    const write = vi.spyOn(socket, "write").mockReturnValue(false);
    try {
      const request = client.request({ operation: "host.status" });
      await waitUntil(() => write.mock.calls.length === 1, 5_000);
      socket.emit("close");
      await expect(request).rejects.toThrow("Workflow host connection closed");
    } finally {
      socket.destroy();
      await client.close();
      await host.stop();
    }
  });

  it("uses one connection and rejects watches for missing runs", async () => {
    const databasePath = path.join(await makeTempDir("client-live"), "state.sqlite");
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    await host.start();
    const client = new WorkflowClient({ databasePath, clientId: "client-live" });
    const events: string[] = [];
    let unwatchRuns: (() => Promise<void>) | undefined;
    let unwatchSession: (() => Promise<void>) | undefined;
    try {
      expect(client.connectionId).toBeUndefined();
      expect(client.packageVersion).toBeUndefined();
      const hello = await client.connect();
      expect(await client.connect()).toBe(hello);
      expect(client.connectionId).toBe(hello.connectionId);
      expect(client.packageVersion).toBe(hello.packageVersion);

      await expect(
        client.request({
          operation: "host.status",
          requestId: "status-request",
          idempotencyKey: "status-idempotency",
          expectedRevision: 0,
          payload: { probe: true },
        }),
      ).resolves.toMatchObject({ requestId: "status-request", outcome: "accepted" });
      await expect(client.request({ operation: "state.status" })).resolves.toMatchObject({
        outcome: "accepted",
        receipt: {
          sizeBytes: expect.any(Number),
          counts: {
            resources: expect.any(Number),
            runs: expect.any(Number),
            controllers: expect.any(Number),
            decisions: expect.any(Number),
            settingsScopes: expect.any(Number),
            pendingInteractions: expect.any(Number),
            pendingFollowUps: expect.any(Number),
            activeLeases: expect.any(Number),
            unsettledEffects: expect.any(Number),
          },
        },
      });
      await expect(
        client.request({
          operation: "view.runs.page",
          payload: { cursor: 0, revision: "0:0:0:0:0" },
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        receipt: { schema: "pi-workflows.run-list-page.v1", total: 0, items: [] },
      });
      await expect(
        client.request({
          operation: "view.runs.page",
          payload: { cursor: 0, revision: "stale" },
        }),
      ).resolves.toMatchObject({ outcome: "conflict" });
      await expect(client.getRun("missing-run")).resolves.toBeNull();

      unwatchRuns = await client.watchRuns((event) => events.push(event.subscriptionId), {
        subscriptionId: "runs-subscription",
        limit: 1,
      });
      await expect(
        client.watchRun("missing-run", (event) => events.push(event.subscriptionId), {
          subscriptionId: "run-subscription",
          revision: 0,
        }),
      ).rejects.toThrow("Workflow run not found");
      unwatchSession = await client.watchSession(
        "session-live",
        (event) => events.push(event.subscriptionId),
        { subscriptionId: "session-subscription" },
      );
      await expect(
        client.watchRun("missing-default-run", () => {
          events.push("default-run-subscription");
        }),
      ).rejects.toThrow("Workflow run not found");
      await waitUntil(
        () => events.includes("runs-subscription") && events.includes("session-subscription"),
        5_000,
      );
      expect(events).not.toContain("run-subscription");
      expect(events).not.toContain("default-run-subscription");

      await unwatchRuns();
      await unwatchSession();
      const unwatchDefaultRuns = await client.watchRuns(() => undefined);
      await unwatchDefaultRuns();
      await waitUntil(
        () =>
          [
            ...(
              host as unknown as {
                connections: Map<string, { subscriptions: Map<string, unknown> }>;
              }
            ).connections.values(),
          ].every((connection) => connection.subscriptions.size === 0),
        5_000,
      );
    } finally {
      await client.close();
      await client.close();
      await host.stop();
    }
    await expect(client.request({ operation: "host.status" })).rejects.toThrow(
      "Workflow client is closed",
    );
  });

  it("assembles a stable paged run list before notifying the viewer", async () => {
    const databasePath = path.join(await makeTempDir("client-run-pages"), "state.sqlite");
    const socketPath = clientSocketPath(databasePath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    const server = net.createServer((socket) => {
      const decoder = new NdjsonFrameDecoder();
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "run-pages-test",
          packageVersion: packageJson.version,
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (message.type !== "request") continue;
          socket.write(
            encodeProtocolLine({
              schema: CLIENT_PROTOCOL_SCHEMA,
              type: "response",
              requestId: message.requestId,
              outcome: "accepted",
              receipt:
                message.operation === "view.runs.page"
                  ? {
                      schema: "pi-workflows.run-list-page.v1",
                      revision: "3:10:20",
                      start: 2,
                      total: 3,
                      items: [{ runId: "run-3", workflowName: "three" }],
                    }
                  : { subscribed: true },
            }),
          );
          if (message.operation === "view.runs.watch") {
            socket.write(
              encodeProtocolLine({
                schema: CLIENT_PROTOCOL_SCHEMA,
                type: "event",
                subscriptionId: "run-pages",
                event: "runs",
                revision: 1,
                payload: {
                  schema: "pi-workflows.run-list-page.v1",
                  revision: "3:10:20",
                  start: 0,
                  total: 3,
                  items: [
                    { runId: "run-1", workflowName: "one" },
                    { runId: "run-2", workflowName: "two" },
                  ],
                },
              }),
            );
          }
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = new WorkflowClient({ databasePath });
    let payload: unknown;
    try {
      const unwatch = await client.watchRuns(
        (event) => {
          payload = event.payload;
        },
        { subscriptionId: "run-pages" },
      );
      await waitUntil(() => Array.isArray(payload), 5_000);
      expect(payload).toEqual([
        { runId: "run-1", workflowName: "one" },
        { runId: "run-2", workflowName: "two" },
        { runId: "run-3", workflowName: "three" },
      ]);
      await unwatch();
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("discards incomplete and stale run-list pages", async () => {
    const databasePath = path.join(await makeTempDir("client-run-page-errors"), "state.sqlite");
    const socketPath = clientSocketPath(databasePath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    let serverSocket: net.Socket | undefined;
    const requestCounts = new Map<string, number>();
    const heldRequests = new Map<string, ClientRequest>();
    const server = net.createServer((socket) => {
      serverSocket = socket;
      socket.on("error", () => undefined);
      const decoder = new NdjsonFrameDecoder();
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "run-page-errors-test",
          packageVersion: packageJson.version,
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (message.type !== "request") continue;
          if (message.operation !== "view.runs.page") {
            socket.write(
              encodeProtocolLine({
                schema: CLIENT_PROTOCOL_SCHEMA,
                type: "response",
                requestId: message.requestId,
                outcome: "accepted",
                receipt: { subscribed: true },
              }),
            );
            continue;
          }
          const requestPayload = message.payload as { revision: string };
          const revision = requestPayload.revision;
          requestCounts.set(revision, (requestCounts.get(revision) ?? 0) + 1);
          if (revision.startsWith("held-")) {
            heldRequests.set(revision, message);
            continue;
          }
          const outcome =
            revision === "conflict"
              ? "conflict"
              : revision === "rejected"
                ? "rejected"
                : "accepted";
          socket.write(
            encodeProtocolLine({
              schema: CLIENT_PROTOCOL_SCHEMA,
              type: "response",
              requestId: message.requestId,
              outcome,
              ...(outcome !== "accepted"
                ? {}
                : {
                    receipt: {
                      schema: "pi-workflows.run-list-page.v1",
                      revision: revision === "wrong-revision" ? "other" : revision,
                      start: revision === "wrong-start" ? 0 : 1,
                      total: revision === "wrong-total" ? 3 : 2,
                      items: revision === "empty" ? [] : [{ runId: "run-2", workflowName: "two" }],
                    },
                  }),
            }),
          );
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = new WorkflowClient({ databasePath });
    let payload: unknown;
    let eventRevision = 0;
    const sendEvent = (eventPayload: JsonValue): void => {
      eventRevision += 1;
      serverSocket?.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "event",
          subscriptionId: "run-page-errors",
          event: "runs",
          revision: eventRevision,
          payload: eventPayload,
        }),
      );
    };
    const respondHeld = (revision: string, total: number): void => {
      const held = heldRequests.get(revision);
      if (held === undefined) throw new Error(`Held request is missing: ${revision}`);
      serverSocket?.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "response",
          requestId: held.requestId,
          outcome: "accepted",
          receipt: {
            schema: "pi-workflows.run-list-page.v1",
            revision,
            start: 1,
            total,
            items: [{ runId: "run-2", workflowName: "two" }],
          },
        }),
      );
    };
    const sendFirstPage = (
      revision: string,
      start = 0,
      items: Array<{ runId: string; workflowName: string }> = [
        { runId: "run-1", workflowName: "one" },
      ],
    ): void => {
      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision,
        start,
        total: 2,
        items,
      });
    };
    try {
      const unwatch = await client.watchRuns(
        (event) => {
          payload = event.payload;
        },
        { subscriptionId: "run-page-errors", limit: 1 },
      );
      for (const revision of [
        "conflict",
        "rejected",
        "wrong-revision",
        "wrong-total",
        "wrong-start",
        "empty",
      ]) {
        payload = undefined;
        sendFirstPage(revision);
        await waitUntil(() => requestCounts.get(revision) === 1, 5_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(payload).toBeUndefined();
      }
      sendFirstPage("bad-start", 1);
      sendFirstPage("no-progress", 0, []);
      for (const invalid of [
        null,
        {},
        { schema: "pi-workflows.run-list-page.v1" },
        { schema: "pi-workflows.run-list-page.v1", revision: "invalid" },
        {
          schema: "pi-workflows.run-list-page.v1",
          revision: "invalid",
          start: -1,
          total: 1,
          items: [],
        },
        {
          schema: "pi-workflows.run-list-page.v1",
          revision: "invalid",
          start: 0,
          total: -1,
          items: [],
        },
        {
          schema: "pi-workflows.run-list-page.v1",
          revision: "invalid",
          start: 0,
          total: 1,
          items: null,
        },
        {
          schema: "pi-workflows.run-list-page.v1",
          revision: "invalid",
          start: 0,
          total: 1,
          items: [{}],
        },
      ]) {
        sendEvent(invalid as JsonValue);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(payload).toBeUndefined();

      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision: "held-loop",
        start: 0,
        total: 3,
        items: [{ runId: "run-1", workflowName: "one" }],
      });
      await waitUntil(() => heldRequests.has("held-loop"), 5_000);
      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision: "replacement-loop",
        start: 0,
        total: 1,
        items: [{ runId: "replacement-loop", workflowName: "replacement" }],
      });
      respondHeld("held-loop", 3);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(payload).toEqual([{ runId: "replacement-loop", workflowName: "replacement" }]);

      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision: "held-final",
        start: 0,
        total: 2,
        items: [{ runId: "run-1", workflowName: "one" }],
      });
      await waitUntil(() => heldRequests.has("held-final"), 5_000);
      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision: "replacement-final",
        start: 0,
        total: 1,
        items: [{ runId: "replacement-final", workflowName: "replacement" }],
      });
      respondHeld("held-final", 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(payload).toEqual([{ runId: "replacement-final", workflowName: "replacement" }]);

      payload = undefined;
      sendFirstPage("stable");
      await waitUntil(() => Array.isArray(payload), 5_000);
      expect(payload).toHaveLength(2);
      await unwatch();

      payload = undefined;
      const unwatchRemovedLoop = await client.watchRuns(
        (event) => {
          payload = event.payload;
        },
        { subscriptionId: "run-page-errors", limit: 1 },
      );
      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision: "held-removed-loop",
        start: 0,
        total: 3,
        items: [{ runId: "run-1", workflowName: "one" }],
      });
      await waitUntil(() => heldRequests.has("held-removed-loop"), 5_000);
      await unwatchRemovedLoop();
      respondHeld("held-removed-loop", 3);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(payload).toBeUndefined();

      const unwatchRemovedFinal = await client.watchRuns(
        (event) => {
          payload = event.payload;
        },
        { subscriptionId: "run-page-errors", limit: 1 },
      );
      sendEvent({
        schema: "pi-workflows.run-list-page.v1",
        revision: "held-removed-final",
        start: 0,
        total: 2,
        items: [{ runId: "run-1", workflowName: "one" }],
      });
      await waitUntil(() => heldRequests.has("held-removed-final"), 5_000);
      await unwatchRemovedFinal();
      respondHeld("held-removed-final", 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(payload).toBeUndefined();
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reads and verifies one complete content chunk", async () => {
    const databasePath = path.join(await makeTempDir("client-content"), "state.sqlite");
    const socketPath = clientSocketPath(databasePath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    const content = Buffer.from("complete content", "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const server = net.createServer((socket) => {
      const decoder = new NdjsonFrameDecoder();
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "content-test",
          packageVersion: packageJson.version,
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (message.type !== "request") continue;
          socket.write(
            encodeProtocolLine({
              schema: CLIENT_PROTOCOL_SCHEMA,
              type: "response",
              requestId: message.requestId,
              outcome: "accepted",
              receipt: {
                path: "artifacts/sha256/content.txt",
                offset: 0,
                data: content.toString("base64"),
                mediaType: "text/plain",
                sha256,
                bytes: content.byteLength,
                nextOffset: content.byteLength,
                complete: true,
              },
            }),
          );
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = new WorkflowClient({ databasePath });
    try {
      await expect(
        client.readContent("run-content", "artifacts/sha256/content.txt"),
      ).resolves.toEqual({ mediaType: "text/plain", content });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("accepts adopted subscriptions and reports rejected subscriptions", async () => {
    const databasePath = path.join(
      await makeTempDir("client-subscription-outcomes"),
      "state.sqlite",
    );
    const socketPath = clientSocketPath(databasePath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    let watchCount = 0;
    const server = net.createServer((socket) => {
      const decoder = new NdjsonFrameDecoder();
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "subscription-outcomes-test",
          packageVersion: packageJson.version,
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (message.type !== "request") continue;
          watchCount += 1;
          const outcome = watchCount === 2 ? "adopted" : "rejected";
          socket.write(
            encodeProtocolLine({
              schema: CLIENT_PROTOCOL_SCHEMA,
              type: "response",
              requestId: message.requestId,
              outcome,
              ...(watchCount === 1 ? { error: "subscription rejected" } : {}),
            }),
          );
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = new WorkflowClient({ databasePath });
    try {
      await expect(
        client.watchRuns(() => undefined, { subscriptionId: "rejected-subscription" }),
      ).rejects.toThrow("subscription rejected");
      const unwatch = await client.watchRuns(() => undefined, {
        subscriptionId: "adopted-subscription",
      });
      await unwatch();
      await expect(
        client.watchRuns(() => undefined, { subscriptionId: "rejected-without-error" }),
      ).rejects.toThrow("Workflow subscription was rejected");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("hydrates repeated content references once and preserves escaped user values", async () => {
    const client = new WorkflowClient();
    const content = Buffer.from('{"answer":"complete"}', "utf8");
    const opaqueContent = Buffer.from(
      '{"$artifact":{"path":"user-path","mediaType":"user-type","bytes":1,"sha256":"user-digest"}}',
      "utf8",
    );
    const plainContent = Buffer.from("plain text", "utf8");
    const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
    const read = vi
      .spyOn(client, "readContent")
      .mockImplementation(async (_runId, contentPath) =>
        contentPath.includes("opaque")
          ? { mediaType: "application/json", content: opaqueContent }
          : contentPath.endsWith(".txt")
            ? { mediaType: "text/plain", content: plainContent }
            : { mediaType: "application/json", content },
      );
    const reference = {
      $artifact: {
        path: "artifacts/sha256/content.json",
        mediaType: "application/json",
        bytes: content.byteLength,
        sha256: digest(content),
      },
    } as const;
    const textReference = {
      $artifact: {
        path: "artifacts/sha256/content.txt",
        mediaType: "text/plain",
        bytes: plainContent.byteLength,
        sha256: digest(plainContent),
      },
    } as const;
    const opaqueReference = {
      $artifact: {
        path: "artifacts/sha256/opaque.json",
        mediaType: "application/json",
        bytes: opaqueContent.byteLength,
        sha256: digest(opaqueContent),
        opaque: true,
      },
    } as const;
    await expect(
      client.hydrateContent("run-content", {
        first: reference,
        second: reference,
        array: [reference, "inline"],
        text: textReference,
        opaque: opaqueReference,
        escapedPrimitive: { $escaped: "literal" },
        userValue: {
          $escaped: {
            $artifact: {
              path: "user-path",
              mediaType: "user-type",
              bytes: 1,
              sha256: "user-digest",
            },
          },
        },
      }),
    ).resolves.toEqual({
      first: { answer: "complete" },
      second: { answer: "complete" },
      array: [{ answer: "complete" }, "inline"],
      text: "plain text",
      opaque: {
        $artifact: {
          path: "user-path",
          mediaType: "user-type",
          bytes: 1,
          sha256: "user-digest",
        },
      },
      escapedPrimitive: "literal",
      userValue: {
        $artifact: {
          path: "user-path",
          mediaType: "user-type",
          bytes: 1,
          sha256: "user-digest",
        },
      },
    });
    expect(read).toHaveBeenCalledTimes(3);
    await expect(
      client.hydrateContent("run-content", {
        $artifact: {
          path: "artifacts/sha256/content.json",
          mediaType: "application/json",
          bytes: content.byteLength + 1,
          sha256: digest(content),
        },
      }),
    ).rejects.toThrow(/does not match/);
    await expect(
      client.hydrateContent("run-content", {
        $artifact: {
          path: "artifacts/sha256/content.json",
          mediaType: "application/json",
          bytes: content.byteLength,
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow(/does not match/);
    await client.close();
  });

  it("rejects invalid and failed exact run responses", async () => {
    const client = new WorkflowClient();
    const request = vi.spyOn(client, "request");
    request.mockResolvedValueOnce({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "invalid-run",
      outcome: "accepted",
      receipt: {},
    });
    await expect(client.getRun("run-invalid")).rejects.toThrow(/invalid run view/);
    request.mockResolvedValueOnce({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "failed-run",
      outcome: "rejected",
      error: "exact run failed",
    });
    await expect(client.getRun("run-failed")).rejects.toThrow("exact run failed");
    request.mockResolvedValueOnce({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "failed-run-without-error",
      outcome: "rejected",
    });
    await expect(client.getRun("run-failed-without-error")).rejects.toThrow(/invalid run view/);
    request.mockResolvedValueOnce({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "missing-run",
      outcome: "notFound",
    });
    await expect(client.getRun("run-missing")).resolves.toBeNull();
    request.mockResolvedValueOnce({
      schema: CLIENT_PROTOCOL_SCHEMA,
      type: "response",
      requestId: "valid-run",
      outcome: "accepted",
      receipt: {
        schema: "pi-workflows.run-view.v1",
        runId: "run-valid",
        revision: 1,
      },
    });
    await expect(client.getRun("run-valid")).resolves.toMatchObject({ runId: "run-valid" });
    await client.close();
  });

  it("stops waiting for an aborted durable submission and accepts a later retry", async () => {
    const databasePath = path.join(await makeTempDir("client-abort"), "state.sqlite");
    const socketPath = clientSocketPath(databasePath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
      version: string;
    };
    let firstRequest: ClientRequest | undefined;
    let firstSocket: net.Socket | undefined;
    let seenResolve!: () => void;
    const seen = new Promise<void>((resolve) => {
      seenResolve = resolve;
    });
    const server = net.createServer((socket) => {
      const decoder = new NdjsonFrameDecoder();
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "abort-test",
          packageVersion: packageJson.version,
        }),
      );
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const message = parseClientMessage(frame);
          if (message.type !== "request") continue;
          if (firstRequest === undefined) {
            firstRequest = message;
            firstSocket = socket;
            seenResolve();
            continue;
          }
          socket.write(
            encodeProtocolLine({
              schema: CLIENT_PROTOCOL_SCHEMA,
              type: "response",
              requestId: message.requestId,
              outcome: "adopted",
              receipt: { submissionId: "submission-abort" },
            }),
          );
        }
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = new WorkflowClient({ databasePath });
    const controller = new AbortController();
    const options = {
      operation: "interaction.submit" as const,
      requestId: "submit-abort",
      idempotencyKey: "submit-abort-key",
      runId: "run-abort",
      payload: { requestId: "interaction-abort", submissionId: "submission-abort" },
    };
    try {
      const pending = client.request({ ...options, signal: controller.signal });
      await seen;
      controller.abort(new Error("tool cancelled"));
      await expect(pending).rejects.toThrow("tool cancelled");
      firstSocket?.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "response",
          requestId: firstRequest?.requestId ?? "submit-abort",
          outcome: "accepted",
          receipt: { submissionId: "submission-abort" },
        }),
      );
      await expect(
        client.request({ ...options, requestId: "submit-abort-retry" }),
      ).resolves.toMatchObject({ outcome: "adopted" });
      const preAborted = new AbortController();
      preAborted.abort("cancelled");
      await expect(
        client.request({
          ...options,
          requestId: "submit-pre-aborted",
          signal: preAborted.signal,
        }),
      ).rejects.toThrow("Workflow request was cancelled");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a package mismatch without trying to replace the live host", async () => {
    const databasePath = path.join(await makeTempDir("client-version"), "state.sqlite");
    const socketPath = clientSocketPath(databasePath);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const server = net.createServer((socket) => {
      socket.write(
        encodeProtocolLine({
          schema: CLIENT_PROTOCOL_SCHEMA,
          type: "hello",
          connectionId: "version-test",
          packageVersion: "99.0.0",
        }),
      );
    });
    server.listen(socketPath);
    await once(server, "listening");
    const client = new WorkflowClient({ databasePath });
    try {
      await expect(client.ensureRunning()).rejects.toBeInstanceOf(WorkflowClientVersionError);
      expect(server.listening).toBe(true);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
