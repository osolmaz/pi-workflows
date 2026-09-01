import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkflowClient, WorkflowClientVersionError } from "../src/client/client.js";
import {
  CLIENT_PROTOCOL_SCHEMA,
  clientSocketPath,
  encodeProtocolLine,
} from "../src/client/protocol.js";
import { WorkflowHost } from "../src/host/runner.js";
import { makeTempDir, waitUntil } from "./helpers.js";

describe("WorkflowClient", () => {
  it("uses one connection for requests and all live view subscriptions", async () => {
    const databasePath = path.join(await makeTempDir("client-live"), "state.sqlite");
    const host = new WorkflowHost({ databasePath, claimPollMs: 10 });
    await host.start();
    const client = new WorkflowClient({ databasePath, clientId: "client-live" });
    const events: string[] = [];
    let unwatchRuns: (() => Promise<void>) | undefined;
    let unwatchRun: (() => Promise<void>) | undefined;
    let unwatchSession: (() => Promise<void>) | undefined;
    let unwatchDefaultRun: (() => Promise<void>) | undefined;
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

      unwatchRuns = await client.watchRuns((event) => events.push(event.subscriptionId), {
        subscriptionId: "runs-subscription",
        limit: 1,
      });
      unwatchRun = await client.watchRun(
        "missing-run",
        (event) => events.push(event.subscriptionId),
        {
          subscriptionId: "run-subscription",
          revision: 0,
        },
      );
      unwatchSession = await client.watchSession(
        "session-live",
        (event) => events.push(event.subscriptionId),
        { subscriptionId: "session-subscription" },
      );
      unwatchDefaultRun = await client.watchRun("missing-default-run", () => {
        events.push("default-run-subscription");
      });
      await waitUntil(
        () =>
          events.includes("runs-subscription") &&
          events.includes("run-subscription") &&
          events.includes("session-subscription") &&
          events.includes("default-run-subscription"),
        5_000,
      );

      await unwatchRun();
      await unwatchRun();
      await unwatchRuns();
      await unwatchSession();
      await unwatchDefaultRun();
    } finally {
      await client.close();
      await client.close();
      await host.stop();
    }
    await expect(client.request({ operation: "host.status" })).rejects.toThrow(
      "Workflow client is closed",
    );
  });

  it("hydrates repeated content references once and preserves escaped user values", async () => {
    const client = new WorkflowClient();
    const content = Buffer.from('{"answer":"complete"}', "utf8");
    const read = vi
      .spyOn(client, "readContent")
      .mockImplementation(async (_runId, path) =>
        path.endsWith(".txt")
          ? { mediaType: "text/plain", content: Buffer.from("plain text", "utf8") }
          : { mediaType: "application/json", content },
      );
    const reference = {
      $artifact: {
        path: "artifacts/sha256/content.json",
        mediaType: "application/json",
        bytes: content.byteLength,
        sha256: "unused-by-hydration",
      },
    } as const;
    const textReference = {
      $artifact: {
        path: "artifacts/sha256/content.txt",
        mediaType: "text/plain",
        bytes: 10,
        sha256: "unused-by-hydration",
      },
    } as const;
    await expect(
      client.hydrateContent("run-content", {
        first: reference,
        second: reference,
        array: [reference, "inline"],
        text: textReference,
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
      userValue: {
        $artifact: {
          path: "user-path",
          mediaType: "user-type",
          bytes: 1,
          sha256: "user-digest",
        },
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
    await client.close();
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
