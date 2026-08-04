import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conditionTrue } from "../src/controllers/conditions.js";
import { defineController } from "../src/controllers/definition.js";
import { ControllerManager } from "../src/controllers/manager.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import type { ControllerStore } from "../src/controllers/store.js";
import { makeTempDir, waitUntil } from "./helpers.js";

const stores: ControllerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function makeStore(): Promise<SqliteControllerStore> {
  const dir = await makeTempDir("pi-controller-manager");
  const store = new SqliteControllerStore(path.join(dir, "controller.sqlite"));
  stores.push(store);
  return store;
}

describe("ControllerManager", () => {
  it("validates manager configuration and registration", async () => {
    const store = await makeStore();
    const controller = defineController<{}, {}>({
      name: "demo",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    expect(() => new ControllerManager({ store, controllers: [controller, controller] })).toThrow(
      /Duplicate/,
    );
    expect(
      () =>
        new ControllerManager({
          store,
          controllers: [controller],
          controllerConcurrency: { missing: 1 },
        }),
    ).toThrow(/unknown controller/);
    expect(
      () => new ControllerManager({ store, controllers: [controller], maxConcurrent: 0 }),
    ).toThrow(/positive/);
    expect(
      () =>
        new ControllerManager({
          store,
          controllers: [controller],
          baseBackoffMs: 10,
          maxBackoffMs: 5,
        }),
    ).toThrow(/greater/);
    expect(
      () => new ControllerManager({ store, controllers: [controller], jitterRatio: 2 }),
    ).toThrow(/between/);
    const other = defineController<{}, {}>({
      name: "other",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.settled(),
    });
    const manager = new ControllerManager({ store, controllers: [controller] });
    expect(() => manager.putResource(other, "one", {})).toThrow(/not registered/);
    expect(() => manager.putResourceByName("missing", "one", {})).toThrow(/Unknown/);
    expect(() => manager.enqueue({ controller: "demo", key: "one" }, -1)).toThrow(/non-negative/);
    await manager.stop();
  });

  it("reconciles current state and records observed generation", async () => {
    const store = await makeStore();
    let calls = 0;
    const controller = defineController<{ desired: string }, { seen?: string }>({
      name: "demo",
      initialStatus: () => ({}),
      reconcile: (ctx, resource) => {
        calls += 1;
        return ctx.settled({
          controllerStatus: { seen: resource.spec.desired },
          conditions: [conditionTrue("Ready", "Observed")],
        });
      },
    });
    const manager = new ControllerManager({ store, controllers: [controller] });
    manager.putResource(controller, "one", { desired: "a" });
    for (let index = 0; index < 9; index += 1) {
      manager.enqueue({ controller: "demo", key: "one" });
    }

    expect(await manager.runUntilIdle()).toBe(1);
    const resource = store.getResource<{ desired: string }, { seen?: string }>({
      controller: "demo",
      key: "one",
    });
    expect(calls).toBe(1);
    expect(resource?.status).toMatchObject({
      observedGeneration: 1,
      controllerStatus: { seen: "a" },
      conditions: [{ type: "Ready", status: true, observedGeneration: 1 }],
    });
    expect(store.listEvents({ key: "one" }).map((event) => event.type)).toContain(
      "reconcile_finished",
    );
  });

  it("discards stale status and reconciles the newer spec", async () => {
    const store = await makeStore();
    let calls = 0;
    const controller = defineController<{ value: number }, { value: number }>({
      name: "conflict",
      initialStatus: () => ({ value: 0 }),
      reconcile: (ctx, resource) => {
        calls += 1;
        if (resource.spec.value === 1) {
          store.putResource({
            controller: "conflict",
            key: "one",
            spec: { value: 2 },
            initialStatus: { value: 0 },
          });
        }
        return ctx.settled({ controllerStatus: { value: resource.spec.value } });
      },
    });
    const manager = new ControllerManager({ store, controllers: [controller] });
    manager.putResource(controller, "one", { value: 1 });

    expect(await manager.runUntilIdle()).toBe(2);
    const resource = store.getResource<{ value: number }, { value: number }>({
      controller: "conflict",
      key: "one",
    });
    expect(calls).toBe(2);
    expect(resource?.metadata.generation).toBe(2);
    expect(resource?.status).toMatchObject({
      observedGeneration: 2,
      controllerStatus: { value: 2 },
    });
  });

  it("uses delayed requeues and exponential error backoff", async () => {
    const store = await makeStore();
    let nowMs = Date.parse("2026-08-04T00:00:00.000Z");
    let calls = 0;
    const controller = defineController<{}, {}>({
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
    const manager = new ControllerManager({
      store,
      controllers: [controller],
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
    const controller = defineController<{}, {}>({
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
    const manager = new ControllerManager({
      store,
      controllers: [controller],
      maxConcurrent: 3,
      pollIntervalMs: 5,
    });
    manager.putResource(controller, "one", {});
    manager.start();
    manager.start();
    await waitUntil(() => calls === 1);
    manager.enqueue({ controller: "parallel", key: "one" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    releaseFirst?.();
    await waitUntil(() => calls === 2);
    await manager.stop();
    await manager.stop();

    expect(maxActive).toBe(1);
  });

  it("rejects invalid results and bounds immediate loops", async () => {
    const store = await makeStore();
    const invalid = defineController<{}, {}>({
      name: "invalid",
      initialStatus: () => ({}),
      reconcile: () => null as never,
    });
    const invalidManager = new ControllerManager({
      store,
      controllers: [invalid],
      baseBackoffMs: 100,
      jitterRatio: 0,
    });
    invalidManager.putResource(invalid, "one", {});
    await invalidManager.runOne();
    expect(store.listQueue()[0]?.consecutiveErrors).toBe(1);

    const loopStore = await makeStore();
    const loop = defineController<{}, {}>({
      name: "loop",
      initialStatus: () => ({}),
      reconcile: (ctx) => ctx.requeue(),
    });
    const loopManager = new ControllerManager({ store: loopStore, controllers: [loop] });
    loopManager.putResource(loop, "one", {});
    await expect(loopManager.runUntilIdle(1)).rejects.toThrow(/exceeded/);
  });

  it("aborts a timed-out reconciler and retries it", async () => {
    const store = await makeStore();
    const sawAbort = vi.fn();
    const controller = defineController<{}, {}>({
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
    const manager = new ControllerManager({
      store,
      controllers: [controller],
      baseBackoffMs: 100,
      jitterRatio: 0,
    });
    manager.putResource(controller, "one", {});

    expect(await manager.runOne()).toBe(true);
    expect(sawAbort).toHaveBeenCalledOnce();
    expect(store.listQueue()[0]?.consecutiveErrors).toBe(1);
  });

  it("deletes a resource after its finalizer is removed", async () => {
    const store = await makeStore();
    const controller = defineController<{}, {}>({
      name: "cleanup",
      initialStatus: () => ({}),
      reconcile: (ctx, resource) =>
        ctx.settled({
          finalizers: resource.metadata.deletionTimestamp === undefined ? ["example.cleanup"] : [],
        }),
    });
    const manager = new ControllerManager({ store, controllers: [controller] });
    manager.putResource(controller, "one", {});
    await manager.runUntilIdle();
    manager.requestDeletion({ controller: "cleanup", key: "one" });
    await manager.runUntilIdle();

    expect(store.getResource({ controller: "cleanup", key: "one" })).toBeUndefined();
    expect(store.listQueue()).toEqual([]);
  });
});
