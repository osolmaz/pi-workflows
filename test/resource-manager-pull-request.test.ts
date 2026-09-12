import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import type { ResourceManagerStore } from "../src/resource-managers/store.js";
import { WorkflowServer } from "../src/server/server.js";
import { WorkflowRunQueueStore } from "../src/workflows/queue.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const stores: ResourceManagerStore[] = [];
const workflowServers: WorkflowServer[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(workflowServers.splice(0).map((server) => server.stop()));
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

describe("pull request resource manager example", () => {
  it("runs child work and performs one exact-head merge", async () => {
    const github = await fakeGitHub({ head: "abc", checks: "success" });
    const { store, queue, server } = await makeStore();
    const spec = {
      apiBaseUrl: github.url,
      repository: "owner/repo",
      number: 1,
      expectedHeadSha: "abc",
      repairWorkflow: "repair",
      mergeApproved: true,
    };
    store.putResource({
      resourceManager: "pull-request",
      key: "owner/repo#1",
      spec,
      initialStatus: { phase: "observing" },
    });
    for (let index = 0; index < 9; index += 1) {
      store.enqueue({ resourceManager: "pull-request", key: "owner/repo#1" });
    }
    await server.start();
    await waitUntil(
      () =>
        store.getResource<unknown, { phase: string }>({
          resourceManager: "pull-request",
          key: "owner/repo#1",
        })?.status.resourceManagerStatus?.phase === "merged",
      30_000,
    );
    const resource = store.getResource<unknown, { phase: string }>({
      resourceManager: "pull-request",
      key: "owner/repo#1",
    });
    expect(github.mergeCalls()).toBe(1);
    expect(resource?.status).toMatchObject({
      observedGeneration: 1,
      resourceManagerStatus: { phase: "merged", observedHeadSha: "abc" },
      conditions: [{ type: "Ready", status: true, reason: "Merged" }],
    });
    const scheduledInputs = queue.listWorkflowRuns().map((run) => run.input);
    expect(scheduledInputs).toEqual([
      { repository: "owner/repo", number: 1, expectedHeadSha: "abc" },
    ]);
    expect(JSON.stringify(scheduledInputs)).not.toContain("token");
  }, 45_000);

  it("blocks a changed head before scheduling or mutation", async () => {
    const github = await fakeGitHub({ head: "new-head", checks: "success" });
    const { store, queue, server } = await makeStore();
    const spec = {
      apiBaseUrl: github.url,
      repository: "owner/repo",
      number: 1,
      expectedHeadSha: "old-head",
      repairWorkflow: "repair",
      mergeApproved: true,
    };
    store.putResource({
      resourceManager: "pull-request",
      key: "owner/repo#1",
      spec,
      initialStatus: { phase: "observing" },
    });
    store.enqueue({ resourceManager: "pull-request", key: "owner/repo#1" });
    await server.start();
    await waitUntil(
      () =>
        store.getResource({ resourceManager: "pull-request", key: "owner/repo#1" })?.status
          .observedGeneration === 1,
      30_000,
    );
    const resource = store.getResource({ resourceManager: "pull-request", key: "owner/repo#1" });
    expect(resource?.status.conditions).toMatchObject([
      { type: "Ready", status: false, reason: "HeadChanged" },
    ]);
    expect(queue.listWorkflowRuns()).toEqual([]);
    expect(github.mergeCalls()).toBe(0);
  }, 45_000);
});

async function makeStore() {
  const dir = await makeTempDir("pi-resource-manager-pr");
  const managerDir = path.join(dir, ".pi", "resource-managers");
  const workflowDir = path.join(dir, ".pi", "workflows");
  await fs.mkdir(managerDir, { recursive: true });
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(
    path.join(managerDir, "pull-request.resource-manager.ts"),
    `export { default } from ${JSON.stringify(path.resolve("examples/resource-managers/pull-request.resource-manager.ts"))};`,
  );
  await fs.writeFile(
    path.join(workflowDir, "repair.workflow.ts"),
    `import { compute, defineWorkflow } from ${JSON.stringify(path.resolve("src/workflows/index.ts"))};
export default defineWorkflow({ name: "repair", startAt: "work", nodes: { work: compute({ run: ({ input }) => input }) }, edges: [] });`,
  );
  const databasePath = path.join(dir, "state.sqlite");
  const store = new SqliteResourceManagerStore(databasePath, { projectPath: dir });
  const queue = new WorkflowRunQueueStore(databasePath, { state: store.state, projectPath: dir });
  const server = new WorkflowServer({
    databasePath,
    claimPollMs: 10,
    maxRunners: 1,
    env: { GITHUB_TOKEN: "test-token" },
  });
  stores.push(store);
  workflowServers.push(server);
  return { store, queue, server };
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
