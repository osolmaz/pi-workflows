import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EffectRequestConflictError,
  ResourceConflictError,
  WorkflowRequestConflictError,
} from "../src/controllers/errors.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import type { ControllerStore } from "../src/controllers/store.js";
import { makeTempDir } from "./helpers.js";

const T0 = "2026-08-04T00:00:00.000Z";
const T1 = "2026-08-04T00:00:01.000Z";
const T2 = "2026-08-04T00:00:02.000Z";

const stores: ControllerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function makeStore(): Promise<{ store: SqliteControllerStore; file: string }> {
  const dir = await makeTempDir("pi-controller-store");
  const file = path.join(dir, "state", "controller.sqlite");
  const store = new SqliteControllerStore(file);
  stores.push(store);
  return { store, file };
}

function putDemo(store: ControllerStore, key = "repo#1") {
  return store.putResource({
    controller: "pull-request",
    key,
    spec: { head: "a" },
    initialStatus: { phase: "new" },
    now: T0,
  });
}

describe("SqliteControllerStore resources", () => {
  it("creates private storage and enqueues a new resource", async () => {
    const { store, file } = await makeStore();
    const resource = putDemo(store);

    expect(resource.metadata).toMatchObject({
      controller: "pull-request",
      key: "repo#1",
      resourceVersion: 1,
      generation: 1,
      finalizers: [],
    });
    expect(resource.status).toEqual({
      observedGeneration: 0,
      conditions: [],
      controllerStatus: { phase: "new" },
    });
    expect(store.listQueue()).toHaveLength(1);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects oversized resource values", async () => {
    const { store } = await makeStore();
    const oversized = "é".repeat(524_289);
    expect(() =>
      store.putResource({
        controller: "pull-request",
        key: "large",
        spec: { payload: oversized },
        initialStatus: {},
        now: T0,
      }),
    ).toThrow(/storage limit/);

    const resource = putDemo(store);
    expect(() =>
      store.updateStatus({
        ref: { controller: "pull-request", key: "repo#1" },
        expectedResourceVersion: resource.metadata.resourceVersion,
        status: {
          ...resource.status,
          controllerStatus: { payload: oversized },
        },
        now: T1,
      }),
    ).toThrow(/storage limit/);
  });

  it("increments generation only when spec changes", async () => {
    const { store } = await makeStore();
    const first = putDemo(store);
    const same = store.putResource({
      controller: "pull-request",
      key: "repo#1",
      spec: { head: "a" },
      initialStatus: { phase: "ignored" },
      now: T1,
    });
    const changed = store.putResource({
      controller: "pull-request",
      key: "repo#1",
      spec: { head: "b" },
      initialStatus: { phase: "ignored" },
      now: T2,
    });

    expect(same.metadata.resourceVersion).toBe(first.metadata.resourceVersion);
    expect(same.status.controllerStatus).toEqual({ phase: "new" });
    expect(changed.metadata).toMatchObject({ resourceVersion: 2, generation: 2 });
    expect(store.listQueue()).toHaveLength(1);
  });

  it("rejects non-JSON input", async () => {
    const { store } = await makeStore();
    expect(() =>
      store.putResource({
        controller: "demo",
        key: "bad",
        spec: { date: new Date() },
        initialStatus: {},
      }),
    ).toThrow(/plain objects/);
  });

  it("uses compare-and-swap status updates and skips identical writes", async () => {
    const { store } = await makeStore();
    const resource = putDemo(store);
    const status = {
      observedGeneration: 1,
      conditions: [],
      controllerStatus: { phase: "ready" },
    };
    const updated = store.updateStatus({
      ref: { controller: "pull-request", key: "repo#1" },
      expectedResourceVersion: resource.metadata.resourceVersion,
      status,
      finalizers: ["example.cleanup"],
      now: T1,
    });
    const unchanged = store.updateStatus({
      ref: { controller: "pull-request", key: "repo#1" },
      expectedResourceVersion: updated.metadata.resourceVersion,
      status,
      finalizers: ["example.cleanup"],
      now: T2,
    });

    expect(updated.metadata).toMatchObject({ resourceVersion: 2, generation: 1 });
    expect(updated.metadata.finalizers).toEqual(["example.cleanup"]);
    expect(unchanged.metadata.resourceVersion).toBe(2);
    expect(() =>
      store.updateStatus({
        ref: { controller: "pull-request", key: "repo#1" },
        expectedResourceVersion: 1,
        status,
      }),
    ).toThrow(ResourceConflictError);
  });

  it("lists by controller and resolves stable UIDs", async () => {
    const { store } = await makeStore();
    const one = putDemo(store, "one");
    store.putResource({ controller: "other", key: "two", spec: {}, initialStatus: {} });
    expect(store.getResourceByUid(one.metadata.uid)?.metadata.key).toBe("one");
    expect(store.listResources({ controller: "pull-request" })).toHaveLength(1);
    expect(() =>
      store.updateFinalizers({
        ref: { controller: "pull-request", key: "one" },
        expectedResourceVersion: one.metadata.resourceVersion,
        finalizers: ["same", "same"],
      }),
    ).toThrow(/Duplicate/);
  });

  it("supports deletion after finalizers are removed", async () => {
    const { store } = await makeStore();
    const resource = putDemo(store);
    const withFinalizer = store.updateFinalizers({
      ref: { controller: "pull-request", key: "repo#1" },
      expectedResourceVersion: resource.metadata.resourceVersion,
      finalizers: ["example.cleanup"],
      now: T1,
    });
    const deleting = store.requestDeletion({ controller: "pull-request", key: "repo#1" }, T2);
    expect(
      store.requestDeletion({ controller: "pull-request", key: "repo#1" }, T2).metadata
        .resourceVersion,
    ).toBe(deleting.metadata.resourceVersion);
    expect(deleting.metadata.deletionTimestamp).toBe(T2);
    expect(() =>
      store.deleteResource(
        { controller: "pull-request", key: "repo#1" },
        deleting.metadata.resourceVersion,
      ),
    ).toThrow(/not ready/);
    const ready = store.updateFinalizers({
      ref: { controller: "pull-request", key: "repo#1" },
      expectedResourceVersion: deleting.metadata.resourceVersion,
      finalizers: [],
    });
    expect(ready.metadata.resourceVersion).toBeGreaterThan(withFinalizer.metadata.resourceVersion);
    expect(
      store.deleteResource(
        { controller: "pull-request", key: "repo#1" },
        ready.metadata.resourceVersion,
      ),
    ).toBe(true);
    expect(store.getResource({ controller: "pull-request", key: "repo#1" })).toBeUndefined();
  });
});

describe("SqliteControllerStore queue", () => {
  it("deduplicates enqueues and preserves an event that arrives during a claim", async () => {
    const { store } = await makeStore();
    putDemo(store);
    for (let index = 0; index < 9; index += 1) {
      store.enqueue({ controller: "pull-request", key: "repo#1" }, T1);
    }
    expect(store.listQueue()).toHaveLength(1);
    const claim = store.claimNext({ controllers: ["pull-request"], leaseMs: 1_000, now: T1 });
    expect(claim).toBeDefined();
    store.enqueue({ controller: "pull-request", key: "repo#1" }, T1);
    expect(store.settleClaim(claim as NonNullable<typeof claim>, T1)).toBe(true);
    expect(store.listQueue()).toHaveLength(1);
  });

  it("requeues errors, renews claims, and recovers expired claims", async () => {
    const { store } = await makeStore();
    putDemo(store);
    const first = store.claimNext({ controllers: ["pull-request"], leaseMs: 500, now: T0 });
    expect(first).toBeDefined();
    expect(store.renewClaim(first as NonNullable<typeof first>, 2_000, T0)).toBe(true);
    expect(
      store.claimNext({ controllers: ["pull-request"], leaseMs: 500, now: T1 }),
    ).toBeUndefined();
    expect(store.renewClaim(first as NonNullable<typeof first>, 2_000, T2)).toBe(false);
    const recovered = store.claimNext({ controllers: ["pull-request"], leaseMs: 500, now: T2 });
    expect(recovered).toBeDefined();
    store.requeueClaim(
      recovered as NonNullable<typeof recovered>,
      { availableAt: T2, error: "temporary" },
      T2,
    );
    expect(store.listQueue()[0]?.consecutiveErrors).toBe(1);
  });

  it("rejects invalid claim input and an empty controller set", async () => {
    const { store } = await makeStore();
    putDemo(store);
    expect(store.claimNext({ controllers: [], leaseMs: 100, now: T0 })).toBeUndefined();
    expect(() => store.claimNext({ controllers: ["pull-request"], leaseMs: 0, now: T0 })).toThrow(
      /positive/,
    );
  });

  it("honors delayed availability and stale claim tokens", async () => {
    const { store } = await makeStore();
    putDemo(store);
    const claim = store.claimNext({ controllers: ["pull-request"], leaseMs: 1_000, now: T0 });
    expect(claim).toBeDefined();
    store.requeueClaim(claim as NonNullable<typeof claim>, { availableAt: T2 }, T0);
    expect(
      store.claimNext({ controllers: ["pull-request"], leaseMs: 1_000, now: T1 }),
    ).toBeUndefined();
    const second = store.claimNext({ controllers: ["pull-request"], leaseMs: 1_000, now: T2 });
    expect(second).toBeDefined();
    expect(store.settleClaim(claim as NonNullable<typeof claim>, T2)).toBe(false);
    expect(store.settleClaim(second as NonNullable<typeof second>, T2)).toBe(true);
    expect(store.listQueue()).toEqual([]);
  });
});

describe("SqliteControllerStore effects, workflows, and events", () => {
  it("reserves effects and rejects key reuse with changed input", async () => {
    const { store } = await makeStore();
    const resource = putDemo(store);
    const first = store.reserveEffect({
      key: "merge:1",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "github-merge",
      requestFingerprint: "aaa",
      now: T0,
    });
    expect(first.created).toBe(true);
    expect(first.record.state).toBe("pending");
    const applied = store.updateEffect({
      resourceUid: resource.metadata.uid,
      key: "merge:1",
      state: "applied",
      externalRef: "merge-sha",
      now: T1,
    });
    expect(applied).toMatchObject({ state: "applied", externalRef: "merge-sha" });
    expect(() =>
      store.reserveEffect({
        key: "merge:1",
        resourceUid: resource.metadata.uid,
        generation: 1,
        kind: "github-merge",
        requestFingerprint: "bbb",
      }),
    ).toThrow(EffectRequestConflictError);
    expect(() =>
      store.updateEffect({
        resourceUid: resource.metadata.uid,
        key: "merge:1",
        state: "indeterminate",
      }),
    ).toThrow(/already applied/);
  });

  it("reserves and updates child workflow requests", async () => {
    const { store } = await makeStore();
    const resource = putDemo(store);
    const first = store.reserveWorkflow({
      resourceUid: resource.metadata.uid,
      requestKey: "repair:a",
      workflow: "repair",
      inputFingerprint: "aaa",
    });
    expect(first.record).toMatchObject({ state: "pending", attempt: 0 });
    const running = store.updateWorkflow(first.record.requestId, {
      state: "running",
      runId: "run-1",
      attempt: 1,
    });
    expect(running).toMatchObject({ state: "running", runId: "run-1", attempt: 1 });
    expect(() =>
      store.reserveWorkflow({
        resourceUid: resource.metadata.uid,
        requestKey: "repair:a",
        workflow: "repair",
        inputFingerprint: "bbb",
      }),
    ).toThrow(WorkflowRequestConflictError);
  });

  it("opens an existing store read-only", async () => {
    const { store, file } = await makeStore();
    putDemo(store);
    const reader = new SqliteControllerStore(file, { readOnly: true });
    stores.push(reader);
    expect(reader.listResources()).toHaveLength(1);
    expect(() => reader.enqueue({ controller: "pull-request", key: "repo#1" })).toThrow();
  });

  it("records bounded structured events", async () => {
    const { store } = await makeStore();
    putDemo(store);
    const event = store.recordEvent({
      controller: "pull-request",
      key: "repo#1",
      type: "test_event",
      payload: { ok: true },
      now: T0,
    });
    expect(event).toMatchObject({ seq: 1, recordedAt: T0, payload: { ok: true } });
    expect(store.listEvents({ controller: "pull-request", key: "repo#1" })).toEqual([event]);
    expect(() =>
      store.recordEvent({
        controller: "pull-request",
        key: "repo#1",
        type: "too_large",
        payload: { text: "x".repeat(70_000) },
      }),
    ).toThrow(/exceeds/);
  });
});
