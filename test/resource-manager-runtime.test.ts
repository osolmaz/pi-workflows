import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conditionTrue } from "../src/resource-managers/conditions.js";
import { defineResourceManager } from "../src/resource-managers/definition.js";
import { ResourceManagerRuntime } from "../src/resource-managers/runtime.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import type { ResourceManagerStore } from "../src/resource-managers/store.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const stores: ResourceManagerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function makeStore(): Promise<SqliteResourceManagerStore> {
  const dir = await makeTempDir("pi-resource-manager-runtime");
  const store = new SqliteResourceManagerStore(path.join(dir, "state.sqlite"));
  stores.push(store);
  return store;
}

describe("ResourceManagerRuntime", () => {
  it("validates manager configuration and registration", async () => {
    const store = await makeStore();
    const controller = defineResourceManager<{}, {}>({
      name: "demo",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    expect(
      () => new ResourceManagerRuntime({ store, resourceManagers: [controller, controller] }),
    ).toThrow(/Duplicate/);
    expect(
      () =>
        new ResourceManagerRuntime({
          store,
          resourceManagers: [controller],
          resourceManagerConcurrency: { missing: 1 },
        }),
    ).toThrow(/unknown resource manager/);
    expect(
      () => new ResourceManagerRuntime({ store, resourceManagers: [controller], maxConcurrent: 0 }),
    ).toThrow(/positive/);
    expect(
      () =>
        new ResourceManagerRuntime({
          store,
          resourceManagers: [controller],
          baseBackoffMs: 10,
          maxBackoffMs: 5,
        }),
    ).toThrow(/greater/);
    expect(
      () => new ResourceManagerRuntime({ store, resourceManagers: [controller], jitterRatio: 2 }),
    ).toThrow(/between/);
    expect(
      () => new ResourceManagerRuntime({ store, resourceManagers: [controller], leaseMs: 299 }),
    ).toThrow(/at least 300/);
    const other = defineResourceManager<{}, {}>({
      name: "other",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    const manager = new ResourceManagerRuntime({ store, resourceManagers: [controller] });
    expect(() => manager.putResource(other, "one", {})).toThrow(/not registered/);
    expect(() => manager.putResourceByName("missing", "one", {})).toThrow(/Unknown/);
    expect(() => manager.enqueue({ resourceManager: "demo", key: "one" }, -1)).toThrow(
      /non-negative/,
    );
    await manager.stop();
  });

  it("returns resource revisions after their audit events", async () => {
    const store = await makeStore();
    const controller = defineResourceManager<{}, {}>({
      name: "event-revisions",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    const manager = new ResourceManagerRuntime({ store, resourceManagers: [controller] });
    const created = manager.putResource(controller, "one", {});
    expect(created.metadata.resourceVersion).toBe(
      store.getResource({ resourceManager: controller.name, key: "one" })?.metadata.resourceVersion,
    );
    const deleting = manager.requestDeletion({ resourceManager: controller.name, key: "one" });
    expect(deleting.metadata.resourceVersion).toBe(
      store.getResource({ resourceManager: controller.name, key: "one" })?.metadata.resourceVersion,
    );
  });

  it("reconciles current state and records observed generation", async () => {
    const store = await makeStore();
    let calls = 0;
    const controller = defineResourceManager<{ desired: string }, { seen?: string }>({
      name: "demo",
      initialStatus: () => ({}),
      reconcile: (ctx, resource) => {
        calls += 1;
        return ctx.settled({
          resourceManagerStatus: { seen: resource.spec.desired },
          conditions: [conditionTrue("Ready", "Observed")],
        });
      },
    });
    const manager = new ResourceManagerRuntime({ store, resourceManagers: [controller] });
    manager.putResource(controller, "one", { desired: "a" });
    for (let index = 0; index < 9; index += 1) {
      manager.enqueue({ resourceManager: "demo", key: "one" });
    }

    expect(await manager.runUntilIdle()).toBe(1);
    const resource = store.getResource<{ desired: string }, { seen?: string }>({
      resourceManager: "demo",
      key: "one",
    });
    expect(calls).toBe(1);
    expect(resource?.status).toMatchObject({
      observedGeneration: 1,
      resourceManagerStatus: { seen: "a" },
      conditions: [{ type: "Ready", status: true, observedGeneration: 1 }],
    });
    expect(store.listEvents({ key: "one" }).map((event) => event.type)).toContain(
      "reconcile_finished",
    );
  });

  it("discards stale status and reconciles the newer spec", async () => {
    const store = await makeStore();
    let calls = 0;
    const controller = defineResourceManager<{ value: number }, { value: number }>({
      name: "conflict",
      initialStatus: () => ({ value: 0 }),
      reconcile: (ctx, resource) => {
        calls += 1;
        if (resource.spec.value === 1) {
          store.putResource({
            resourceManager: "conflict",
            key: "one",
            spec: { value: 2 },
            initialStatus: { value: 0 },
          });
        }
        return ctx.settled({ resourceManagerStatus: { value: resource.spec.value } });
      },
    });
    const manager = new ResourceManagerRuntime({ store, resourceManagers: [controller] });
    manager.putResource(controller, "one", { value: 1 });

    expect(await manager.runUntilIdle()).toBe(2);
    const resource = store.getResource<{ value: number }, { value: number }>({
      resourceManager: "conflict",
      key: "one",
    });
    expect(calls).toBe(2);
    expect(resource?.metadata.generation).toBe(2);
    expect(resource?.status).toMatchObject({
      observedGeneration: 2,
      resourceManagerStatus: { value: 2 },
    });
  });

  it("uses delayed requeues and exponential error backoff", async () => {
    const store = await makeStore();
    let nowMs = Date.parse("2026-08-04T00:00:00.000Z");
    let calls = 0;
    const controller = defineResourceManager<{}, {}>({
      name: "retry",
      initialStatus: () => ({}),
      reconcile: (ctx) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary");
        }
        return calls === 2 ? ctx.requeueAfter(2_000) : ctx.settled();
      },
    });
    const manager = new ResourceManagerRuntime({
      store,
      resourceManagers: [controller],
      now: () => new Date(nowMs),
      random: () => 0.5,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      jitterRatio: 0,
    });
    manager.putResource(controller, "one", {});

    expect(await manager.runOne()).toBe(true);
    expect(store.listQueue()[0]).toMatchObject({ consecutiveErrors: 1 });
    expect(await manager.runOne()).toBe(false);
    nowMs += 1_000;
    expect(await manager.runOne()).toBe(true);
    expect(await manager.runOne()).toBe(false);
    nowMs += 2_000;
    expect(await manager.runOne()).toBe(true);
    expect(store.listQueue()).toEqual([]);
  });

  it("keeps one active reconciliation per key with several workers", async () => {
    const store = await makeStore();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controller = defineResourceManager<{}, {}>({
      name: "parallel",
      initialStatus: () => ({}),
      reconcile: async (ctx) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
          await first;
        }
        active -= 1;
        return ctx.settled();
      },
    });
    const manager = new ResourceManagerRuntime({
      store,
      resourceManagers: [controller],
      maxConcurrent: 3,
      pollIntervalMs: 5,
    });
    manager.putResource(controller, "one", {});
    manager.start();
    manager.start();
    await waitUntil(() => calls === 1);
    manager.enqueue({ resourceManager: "parallel", key: "one" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    releaseFirst?.();
    await waitUntil(() => calls === 2);
    await manager.stop();
    await manager.stop();

    expect(maxActive).toBe(1);
  });

  it("keeps polling after a reconciliation loses its claim", async () => {
    const store = await makeStore();
    let completedOther = 0;
    const controller = defineResourceManager<{}, {}>({
      name: "stale-claim",
      initialStatus: () => ({}),
      reconcile: (ctx, resource) => {
        if (resource.metadata.key === "a") {
          const now = Date.now();
          store.state.connection
            .prepare(
              `UPDATE leases
               SET generation = generation + 1, owner_type = 'resource-manager',
                   owner_id = 'replacement', token_hash = zeroblob(32),
                   acquired_at = ?, heartbeat_at = ?, expires_at = ?
               WHERE resource_id = (
                 SELECT resource_id FROM controller_resources WHERE resource_key = 'a'
               )`,
            )
            .run(now, now, now + 60_000);
        } else {
          completedOther += 1;
        }
        return ctx.settled();
      },
    });
    const manager = new ResourceManagerRuntime({
      store,
      resourceManagers: [controller],
      maxConcurrent: 1,
      pollIntervalMs: 5,
    });
    manager.putResource(controller, "a", {});
    manager.putResource(controller, "b", {});
    manager.start();
    await waitUntil(() => completedOther === 1);
    await manager.stop();
    expect(completedOther).toBe(1);
  });

  it("rejects invalid results and bounds immediate loops", async () => {
    const store = await makeStore();
    const invalid = defineResourceManager<{}, {}>({
      name: "invalid",
      initialStatus: () => ({}),
      reconcile: () => null as never,
    });
    const invalidManager = new ResourceManagerRuntime({
      store,
      resourceManagers: [invalid],
      baseBackoffMs: 100,
      jitterRatio: 0,
    });
    invalidManager.putResource(invalid, "one", {});
    await invalidManager.runOne();
    expect(store.listQueue()[0]?.consecutiveErrors).toBe(1);

    const loopStore = await makeStore();
    const loop = defineResourceManager<{}, {}>({
      name: "loop",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.requeue(),
    });
    const loopManager = new ResourceManagerRuntime({ store: loopStore, resourceManagers: [loop] });
    loopManager.putResource(loop, "one", {});
    await expect(loopManager.runUntilIdle(1)).rejects.toThrow(/exceeded/);
  });

  it("aborts a timed-out reconciler and retries it", async () => {
    const store = await makeStore();
    const sawAbort = vi.fn();
    const controller = defineResourceManager<{}, {}>({
      name: "timeout",
      timeoutMs: 10,
      initialStatus: () => ({}),
      reconcile: async (_ctx) => {
        await new Promise<void>((_resolve, reject) => {
          _ctx.signal.addEventListener(
            "abort",
            () => {
              sawAbort();
              reject(_ctx.signal.reason);
            },
            { once: true },
          );
        });
        return _ctx.settled();
      },
    });
    const manager = new ResourceManagerRuntime({
      store,
      resourceManagers: [controller],
      baseBackoffMs: 100,
      jitterRatio: 0,
    });
    manager.putResource(controller, "one", {});

    expect(await manager.runOne()).toBe(true);
    expect(sawAbort).toHaveBeenCalledOnce();
    expect(store.listQueue()[0]?.consecutiveErrors).toBe(1);
  });

  it("releases a timed-out reconciler that ignores cancellation", async () => {
    const store = await makeStore();
    const controller = defineResourceManager<{}, {}>({
      name: "hung",
      timeoutMs: 10,
      initialStatus: () => ({}),
      reconcile: async () => await new Promise(() => {}),
    });
    const manager = new ResourceManagerRuntime({
      store,
      resourceManagers: [controller],
      baseBackoffMs: 100,
      jitterRatio: 0,
    });
    manager.putResource(controller, "one", {});

    let timer: NodeJS.Timeout | undefined;
    let completed: boolean;
    try {
      completed = await Promise.race([
        manager.runOne(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("runOne stayed blocked")), 500);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    expect(completed).toBe(true);
    expect(store.listQueue()[0]).toMatchObject({ consecutiveErrors: 1 });
    expect(
      store
        .listEvents({ resourceManager: "hung", key: "one" })
        .some((event) => event.type === "reconcile_failed"),
    ).toBe(true);
  });

  it("deletes a resource after its finalizer is removed", async () => {
    const store = await makeStore();
    const controller = defineResourceManager<{}, {}>({
      name: "cleanup",
      initialStatus: () => ({}),
      reconcile: (ctx, resource) =>
        ctx.settled({
          finalizers: resource.metadata.deletionTimestamp === undefined ? ["example.cleanup"] : [],
        }),
    });
    const manager = new ResourceManagerRuntime({ store, resourceManagers: [controller] });
    manager.putResource(controller, "one", {});
    await manager.runUntilIdle();
    manager.requestDeletion({ resourceManager: "cleanup", key: "one" });
    await manager.runUntilIdle();

    expect(store.getResource({ resourceManager: "cleanup", key: "one" })).toBeUndefined();
    expect(store.listQueue()).toEqual([]);
  });
});
