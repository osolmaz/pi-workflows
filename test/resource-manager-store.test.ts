import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedResourceConflictError } from "../src/resource-managers/errors.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import type { ResourceManagerQueueClaim } from "../src/resource-managers/types.js";
import { makeTempDir } from "./helpers.js";

async function setup() {
  const projectPath = await makeTempDir("resource-manager-project");
  const databasePath = path.join(await makeTempDir("resource-manager-state"), "state.sqlite");
  const store = new SqliteResourceManagerStore(databasePath, { projectPath });
  return { store, databasePath, projectPath };
}

function claim(store: SqliteResourceManagerStore, ownerId = "worker-1"): ResourceManagerQueueClaim {
  const value = store.claimNext({
    resourceManagers: ["jobs"],
    ownerId,
    leaseMs: 60_000,
  });
  if (value === undefined) throw new Error("resource manager claim missing");
  return value;
}

describe("SqliteResourceManagerStore", () => {
  it("stores normalized project resources in the canonical database", async () => {
    const { store } = await setup();
    const resource = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: { image: "worker" },
      initialStatus: { phase: "new" },
    });
    expect(resource.metadata).toMatchObject({ resourceManager: "jobs", key: "one", generation: 1 });
    expect(store.listResources()).toHaveLength(1);
    expect(store.state.connection.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
      count: 1,
    });
    expect(
      store.state.connection.prepare("SELECT count(*) AS count FROM controller_resources").get(),
    ).toEqual({ count: 1 });
    expect(store.listEvents()).not.toHaveLength(0);
    expect(store.listEvents({ resourceManager: "jobs", key: "one", limit: 1 })).toHaveLength(1);
    store.close();
  });

  it("supports idempotent close and read-only cross-project inspection", async () => {
    const { store, databasePath } = await setup();
    store.putResource({ resourceManager: "jobs", key: "one", spec: {}, initialStatus: {} });
    const reader = new SqliteResourceManagerStore(databasePath, {
      readOnly: true,
      projectPath: "/missing/project",
    });
    expect(reader.listResources()).toHaveLength(1);
    expect(() =>
      reader.putResource({ resourceManager: "jobs", key: "two", spec: {}, initialStatus: {} }),
    ).toThrow(/read-only/);
    reader.close();
    reader.close();
    store.close();
  });

  it("adopts unchanged specs and advances changed generations", async () => {
    const { store } = await setup();
    const first = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: { value: 1 },
      initialStatus: {},
    });
    const adopted = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: { value: 1 },
      initialStatus: { ignored: true },
    });
    const changed = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: { value: 2 },
      initialStatus: {},
    });
    expect(adopted.metadata.resourceVersion).toBe(first.metadata.resourceVersion);
    expect(changed.metadata.generation).toBe(2);
    expect(store.listResources({ resourceManager: "missing" })).toEqual([]);
    store.close();
  });

  it("requires the current claim and expected revision for status writes", async () => {
    const { store } = await setup();
    store.putResource({ resourceManager: "jobs", key: "one", spec: {}, initialStatus: {} });
    const currentClaim = claim(store);
    const resource = store.getResource({ resourceManager: "jobs", key: "one" });
    if (resource === undefined) throw new Error("resource missing");
    const updated = store.updateStatus({
      ref: { resourceManager: "jobs", key: "one" },
      expectedResourceVersion: resource.metadata.resourceVersion,
      claim: currentClaim,
      status: { observedGeneration: 1, conditions: [], resourceManagerStatus: { phase: "ready" } },
    });
    expect(updated.status.resourceManagerStatus).toEqual({ phase: "ready" });
    expect(() =>
      store.updateStatus({
        ref: { resourceManager: "jobs", key: "one" },
        expectedResourceVersion: resource.metadata.resourceVersion,
        claim: currentClaim,
        status: { observedGeneration: 1, conditions: [], resourceManagerStatus: {} },
      }),
    ).toThrow(ManagedResourceConflictError);
    store.close();
  });

  it("increments claim generations and rejects a superseded owner", async () => {
    const { store } = await setup();
    store.putResource({ resourceManager: "jobs", key: "one", spec: {}, initialStatus: {} });
    const first = claim(store, "worker-1");
    expect(first.generation).toBe(1);
    expect(store.requeueClaim(first, { availableAt: new Date().toISOString() })).toBe(true);
    const second = store.claimNext({
      resourceManagers: ["jobs"],
      ownerId: "worker-2",
      leaseMs: 60_000,
    });
    expect(second?.generation).toBe(2);
    expect(store.renewClaim(first, 60_000)).toBe(false);
    store.close();
  });

  it("tracks queue retries, renewals, and error counts", async () => {
    const { store } = await setup();
    store.putResource({ resourceManager: "jobs", key: "one", spec: {}, initialStatus: {} });
    const currentClaim = claim(store);
    expect(store.renewClaim(currentClaim, 60_000)).toBe(true);
    expect(
      store.requeueClaim(currentClaim, {
        availableAt: new Date().toISOString(),
        error: "temporary",
      }),
    ).toBe(true);
    expect(store.listQueue()[0]).toMatchObject({ consecutiveErrors: 1 });
    const next = claim(store, "worker-2");
    expect(store.settleClaim(next)).toBe(true);
    expect(store.listQueue()).toEqual([]);
    store.close();
  });

  it("reserves effects and child workflows under the resource manager claim", async () => {
    const { store } = await setup();
    const resource = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: {},
      initialStatus: {},
    });
    const currentClaim = claim(store);
    const effect = store.reserveEffect({
      key: "publish",
      resourceUid: resource.metadata.uid,
      claim: currentClaim,
      generation: resource.metadata.generation,
      kind: "publish",
      requestFingerprint: "a".repeat(64),
    });
    expect(effect.created).toBe(true);
    expect(
      store.reserveEffect({
        key: "publish",
        resourceUid: resource.metadata.uid,
        claim: currentClaim,
        generation: resource.metadata.generation,
        kind: "publish",
        requestFingerprint: "a".repeat(64),
      }).created,
    ).toBe(false);
    expect(() =>
      store.reserveEffect({
        key: "publish",
        resourceUid: resource.metadata.uid,
        claim: currentClaim,
        generation: resource.metadata.generation,
        kind: "publish",
        requestFingerprint: "b".repeat(64),
      }),
    ).toThrow(/different request/);
    expect(
      store.updateEffect({
        resourceUid: resource.metadata.uid,
        key: "publish",
        claim: currentClaim,
        state: "applied",
        externalRef: "remote-1",
      }).state,
    ).toBe("applied");

    const child = store.reserveWorkflow({
      resourceUid: resource.metadata.uid,
      claim: currentClaim,
      requestKey: "repair",
      workflow: "autoimplement",
      inputFingerprint: "b".repeat(64),
    });
    expect(child.created).toBe(true);
    expect(
      store.reserveWorkflow({
        resourceUid: resource.metadata.uid,
        claim: currentClaim,
        requestKey: "repair",
        workflow: "autoimplement",
        inputFingerprint: "b".repeat(64),
      }).created,
    ).toBe(false);
    expect(() =>
      store.reserveWorkflow({
        resourceUid: resource.metadata.uid,
        claim: currentClaim,
        requestKey: "repair",
        workflow: "different",
        inputFingerprint: "b".repeat(64),
      }),
    ).toThrow(/different input/);
    expect(
      store.updateWorkflow(child.record.requestId, { state: "running", attempt: 1 }, currentClaim)
        .state,
    ).toBe("running");
    store.close();
  });

  it("keeps marked resources while finalizers remain", async () => {
    const { store } = await setup();
    const created = store.putResource({
      resourceManager: "jobs",
      key: "one",
      spec: {},
      initialStatus: {},
    });
    const withFinalizer = store.updateFinalizers({
      ref: { resourceManager: "jobs", key: "one" },
      expectedResourceVersion: created.metadata.resourceVersion,
      finalizers: ["cleanup"],
    });
    const requested = store.requestDeletion({ resourceManager: "jobs", key: "one" });
    expect(
      store.requestDeletion({ resourceManager: "jobs", key: "one" }).metadata.deletionTimestamp,
    ).toBe(requested.metadata.deletionTimestamp);
    const currentClaim = claim(store);
    const current = store.getResource({ resourceManager: "jobs", key: "one" });
    if (current === undefined) throw new Error("resource missing");
    expect(withFinalizer.metadata.finalizers).toEqual(["cleanup"]);
    expect(requested.metadata.deletionTimestamp).toBeDefined();
    expect(
      store.deleteResource(
        { resourceManager: "jobs", key: "one" },
        current.metadata.resourceVersion,
        currentClaim,
      ),
    ).toBe(false);
    store.close();
  });

  it("deletes only a marked resource with no finalizers under its claim", async () => {
    const { store } = await setup();
    store.putResource({ resourceManager: "jobs", key: "one", spec: {}, initialStatus: {} });
    const requested = store.requestDeletion({ resourceManager: "jobs", key: "one" });
    const currentClaim = claim(store);
    const current = store.getResource({ resourceManager: "jobs", key: "one" });
    if (current === undefined) throw new Error("resource missing");
    expect(requested.metadata.deletionTimestamp).toBeDefined();
    expect(
      store.deleteResource(
        { resourceManager: "jobs", key: "one" },
        current.metadata.resourceVersion,
        currentClaim,
      ),
    ).toBe(true);
    expect(store.getResource({ resourceManager: "jobs", key: "one" })).toBeUndefined();
    store.close();
  });
});
