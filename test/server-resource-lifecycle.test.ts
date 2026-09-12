import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import { WorkflowServer } from "../src/server/server.js";
import { makeTempDir, waitUntil } from "./helpers.js";

async function setup(body: string, extra = "") {
  const cwd = await makeTempDir("server-resource-lifecycle");
  const directory = path.join(cwd, ".pi", "resource-managers");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "test.resource-manager.ts"),
    `import fs from "node:fs/promises";
import path from "node:path";
import { defineResourceManager } from ${JSON.stringify(path.resolve("src/resource-managers/index.ts"))};
const directory = ${JSON.stringify(cwd)};
async function waitFor(name) { for (;;) { try { await fs.access(path.join(directory, name)); return; } catch {} await new Promise(resolve => setTimeout(resolve, 10)); } }
export default defineResourceManager({ name: "test", initialStatus: () => ({}), ${extra}
async reconcile(ctx, resource) { ${body} } });`,
  );
  const databasePath = path.join(cwd, "state.sqlite");
  const store = new SqliteResourceManagerStore(databasePath, { projectPath: cwd });
  const server = new WorkflowServer({ databasePath, claimPollMs: 10, maxRunners: 2 });
  return {
    cwd,
    store,
    server,
    put(key: string, spec: unknown = {}) {
      const resource = store.putResource({ resourceManager: "test", key, spec, initialStatus: {} });
      store.enqueue({ resourceManager: "test", key });
      return resource;
    },
    current(key: string) {
      return store.getResource({ resourceManager: "test", key });
    },
    async release(name: string) {
      await fs.writeFile(path.join(cwd, name), "ready");
    },
    async close() {
      await server.stop();
      store.close();
    },
  };
}

describe("workflow server resource lifecycle", () => {
  it("discards an old generation's result and runs the updated spec", async () => {
    const test =
      await setup(`await fs.writeFile(path.join(directory, 'started-' + resource.spec.value), 'started');
if (resource.spec.value === 1) await waitFor('release');
return ctx.settled({ resourceManagerStatus: { value: resource.spec.value } });`);
    try {
      test.put("one", { value: 1 });
      await test.server.start();
      await waitUntil(() => existsSync(path.join(test.cwd, "started-1")), 30_000);
      test.put("one", { value: 2 });
      await test.release("release");
      await waitUntil(() => test.current("one")?.status.observedGeneration === 2, 30_000);
      expect(test.current("one")?.status.resourceManagerStatus).toEqual({ value: 2 });
      expect(test.store.listEvents({ key: "one" }).map((event) => event.type)).toContain(
        "reconcile_conflict",
      );
    } finally {
      await test.close();
    }
  }, 45_000);

  it("does not launch a second reconciliation for an active resource key", async () => {
    const test =
      await setup(`await fs.appendFile(path.join(directory, resource.metadata.key + '.calls'), 'started\\n');
await waitFor('release'); return ctx.settled();`);
    try {
      test.put("one");
      test.put("two");
      await test.server.start();
      await waitUntil(
        () =>
          existsSync(path.join(test.cwd, "one.calls")) &&
          existsSync(path.join(test.cwd, "two.calls")),
        30_000,
      );
      for (let index = 0; index < 9; index += 1)
        test.store.enqueue({ resourceManager: "test", key: "one" });
      expect(await fs.readFile(path.join(test.cwd, "one.calls"), "utf8")).toBe("started\n");
      await test.release("release");
      await waitUntil(() => test.store.listQueue().length === 0, 30_000);
      expect(
        (await fs.readFile(path.join(test.cwd, "one.calls"), "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      expect(
        (await fs.readFile(path.join(test.cwd, "two.calls"), "utf8")).trim().split("\n"),
      ).toHaveLength(1);
    } finally {
      await test.close();
    }
  }, 45_000);

  it("rejects a stale runner and continues independent resource work", async () => {
    const test = await setup(`if (resource.metadata.key === 'stale') {
await fs.writeFile(path.join(directory, 'started'), 'started'); await waitFor('release');
} return ctx.settled({ resourceManagerStatus: { completed: true } });`);
    try {
      test.put("stale");
      await test.server.start();
      await waitUntil(() => existsSync(path.join(test.cwd, "started")), 30_000);
      const now = Date.now();
      test.store.state.connection
        .prepare(`UPDATE leases SET generation = generation + 1,
        owner_type = 'resource_manager', owner_id = 'replacement', token_hash = zeroblob(32),
        acquired_at = ?, heartbeat_at = ?, expires_at = ?
        WHERE resource_id = (SELECT resource_id FROM managed_resources WHERE resource_key = 'stale')`)
        .run(now, now, now + 60_000);
      test.put("other");
      await test.release("release");
      await waitUntil(() => test.current("other")?.status.observedGeneration === 1, 30_000);
      await test.server.stop();
      expect(test.current("stale")?.status.observedGeneration).not.toBe(1);
      expect(
        test.store
          .listEvents({ key: "stale" })
          .some(
            (event) => event.type === "reconcile_finished" || event.type === "reconcile_failed",
          ),
      ).toBe(false);
    } finally {
      await test.close();
    }
  }, 45_000);

  it.each(["return null;", "return new Promise(() => {});"])(
    "saves failure and requeues an invalid or timed-out reconcile: %s",
    async (body) => {
      const test = await setup(body, "timeoutMs: 20,");
      try {
        test.put("one");
        await test.server.start();
        await waitUntil(() => test.store.listQueue()[0]?.consecutiveErrors === 1, 30_000);
        const failure = test.store
          .listEvents({ key: "one" })
          .find((event) => event.type === "reconcile_failed");
        expect(failure?.payload.requeueAfterMs).toBe(1_000);
        expect(failure?.payload.error).toMatch(/result must be an object|timed out/);
        await test.server.stop();
        expect(test.store.listQueue()[0]?.consecutiveErrors).toBe(1);
        expect(test.current("one")?.status.observedGeneration).not.toBe(1);
      } finally {
        await test.close();
      }
    },
    45_000,
  );

  it("keeps delayed requeue timing and deletes only after finalizer removal", async () => {
    const test =
      await setup(`if (resource.metadata.deletionTimestamp !== undefined) return ctx.settled({ finalizers: [] });
return ctx.requeueAfter(60000, { finalizers: ['test.cleanup'], resourceManagerStatus: { observed: true } });`);
    try {
      test.put("one");
      await test.server.start();
      await waitUntil(() => test.current("one")?.status.observedGeneration === 1, 30_000);
      expect(test.current("one")?.metadata.finalizers).toEqual(["test.cleanup"]);
      const finished = test.store
        .listEvents({ key: "one" })
        .find((event) => event.type === "reconcile_finished");
      expect(finished?.payload.requeueAfterMs).toBe(60_000);
      const ref = { resourceManager: "test", key: "one" };
      test.store.requestDeletion(ref);
      test.store.enqueue(ref);
      await waitUntil(() => test.current("one") === undefined, 30_000);
      expect(test.store.listQueue()).toEqual([]);
    } finally {
      await test.close();
    }
  }, 45_000);
});
