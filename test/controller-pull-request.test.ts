import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pullRequestController from "../examples/controllers/pull-request.controller.js";
import { ControllerManager } from "../src/controllers/manager.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import type { ControllerStore } from "../src/controllers/store.js";
import type { ControllerWorkflowScheduler } from "../src/controllers/workflows.js";
import { makeTempDir } from "./helpers.js";

const stores: ControllerStore[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(
    servers
      .splice(0)
      .map(
        async (server) =>
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("pull request controller example", () => {
  it("runs child work and performs one exact-head merge", async () => {
    const github = await fakeGitHub({ head: "abc", checks: "success" });
    const store = await makeStore();
    const scheduledInputs: unknown[] = [];
    const scheduler: ControllerWorkflowScheduler = {
      ensure: async (request) => {
        scheduledInputs.push(request.input);
        return { state: "succeeded", runId: "repair-run" };
      },
    };
    const manager = new ControllerManager({
      store,
      controllers: [pullRequestController],
      workflowScheduler: scheduler,
    });
    manager.putResource(pullRequestController, "owner/repo#1", {
      apiBaseUrl: github.url,
      repository: "owner/repo",
      number: 1,
      expectedHeadSha: "abc",
      repairWorkflow: "repair",
      mergeApproved: true,
    });
    for (let index = 0; index < 9; index += 1) {
      manager.enqueue({ controller: "pull-request", key: "owner/repo#1" });
    }

    expect(await manager.runUntilIdle()).toBe(2);
    const resource = store.getResource<unknown, { phase: string }>({
      controller: "pull-request",
      key: "owner/repo#1",
    });
    expect(github.mergeCalls()).toBe(1);
    expect(resource?.status).toMatchObject({
      observedGeneration: 1,
      controllerStatus: { phase: "merged", observedHeadSha: "abc" },
      conditions: [{ type: "Ready", status: true, reason: "Merged" }],
    });
    expect(scheduledInputs).toEqual([
      { repository: "owner/repo", number: 1, expectedHeadSha: "abc" },
    ]);
    expect(JSON.stringify(scheduledInputs)).not.toContain("token");
  });

  it("blocks a changed head before scheduling or mutation", async () => {
    const github = await fakeGitHub({ head: "new-head", checks: "success" });
    const store = await makeStore();
    const ensure = vi.fn(async () => ({ state: "succeeded" as const, runId: "repair-run" }));
    const manager = new ControllerManager({
      store,
      controllers: [pullRequestController],
      workflowScheduler: { ensure },
    });
    manager.putResource(pullRequestController, "owner/repo#1", {
      apiBaseUrl: github.url,
      repository: "owner/repo",
      number: 1,
      expectedHeadSha: "old-head",
      repairWorkflow: "repair",
      mergeApproved: true,
    });

    await manager.runUntilIdle();
    const resource = store.getResource({ controller: "pull-request", key: "owner/repo#1" });
    expect(resource?.status.conditions).toMatchObject([
      { type: "Ready", status: false, reason: "HeadChanged" },
    ]);
    expect(ensure).not.toHaveBeenCalled();
    expect(github.mergeCalls()).toBe(0);
  });
});

async function makeStore(): Promise<SqliteControllerStore> {
  const dir = await makeTempDir("pi-controller-pr");
  const store = new SqliteControllerStore(path.join(dir, "controller.sqlite"));
  stores.push(store);
  return store;
}

async function fakeGitHub(options: { head: string; checks: "pending" | "success" }) {
  let merged = false;
  let mergeCalls = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/repos/owner/repo/pulls/1") {
      response.end(
        JSON.stringify({
          merged,
          merge_commit_sha: merged ? "merge-sha" : null,
          head: { sha: options.head },
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/repos/owner/repo/commits/${options.head}/status`
    ) {
      response.end(JSON.stringify({ state: options.checks }));
      return;
    }
    if (request.method === "PUT" && url.pathname === "/repos/owner/repo/pulls/1/merge") {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      const parsed = JSON.parse(body) as { sha?: string };
      if (parsed.sha !== options.head) {
        response.statusCode = 409;
        response.end(JSON.stringify({ merged: false, message: "head changed" }));
        return;
      }
      mergeCalls += 1;
      merged = true;
      response.end(JSON.stringify({ merged: true, sha: "merge-sha" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake GitHub server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    mergeCalls: () => mergeCalls,
  };
}
