import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceManagerEffectService } from "../src/resource-managers/effects.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import type { ResourceManagerStore } from "../src/resource-managers/store.js";
import {
  ResourceManagerWorkflowCoordinator,
  type ResourceManagerWorkflowScheduler,
} from "../src/resource-managers/workflows.js";
import { makeTempDir } from "./helpers.js";

const stores: ResourceManagerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function fixture() {
  const dir = await makeTempDir("pi-resource-manager-services");
  const store = new SqliteResourceManagerStore(path.join(dir, "state.sqlite"));
  stores.push(store);
  const resource = store.putResource({
    resourceManager: "demo",
    key: "one",
    spec: {},
    initialStatus: {},
  });
  const claim = store.claimNext({
    resourceManagers: ["demo"],
    ownerId: "test-worker",
    leaseMs: 60_000,
  });
  if (claim === undefined) throw new Error("resource manager claim missing");
  return { store, resource, claim };
}

describe("ResourceManagerEffectService", () => {
  it("applies a new effect and returns a saved receipt", async () => {
    const { store, resource, claim } = await fixture();
    const observe = vi.fn(() => ({ state: "not_applied" as const }));
    const apply = vi.fn(() => ({ state: "applied" as const, externalRef: "sha" }));
    const effects = new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    );

    const record = await effects.ensure({
      key: "merge:one",
      kind: "merge",
      request: { head: "a" },
      observe,
      apply,
    });

    expect(record).toMatchObject({ state: "applied", externalRef: "sha" });
    expect(observe).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("records an uncertain call and observes it before retrying", async () => {
    const { store, resource, claim } = await fixture();
    const first = new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    );
    const uncertain = await first.ensure({
      key: "merge:one",
      kind: "merge",
      request: { head: "a" },
      observe: () => ({ state: "not_applied" }),
      apply: () => {
        throw new Error("x".repeat(9_000));
      },
    });
    expect(uncertain.state).toBe("indeterminate");
    expect(uncertain.error).toHaveLength(8_193);
    expect(uncertain.error?.endsWith("…")).toBe(true);

    const applyAgain = vi.fn();
    const recovered = await new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    ).ensure({
      key: "merge:one",
      kind: "merge",
      request: { head: "a" },
      observe: () => ({ state: "applied", externalRef: "sha" }),
      apply: applyAgain,
    });
    expect(recovered).toMatchObject({ state: "applied", externalRef: "sha" });
    expect(applyAgain).not.toHaveBeenCalled();
  });

  it("retries only after observation reports that the effect is absent", async () => {
    const { store, resource, claim } = await fixture();
    store.reserveEffect({
      claim,
      key: "merge:one",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "merge",
      requestFingerprint: "40764401a76928bdb533b0a6f4fcdb0c89d16c453354f704c610c36d3b3bb063",
    });
    const apply = vi.fn(() => ({ state: "applied" as const }));
    const record = await new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    ).ensure({
      key: "merge:one",
      kind: "merge",
      request: { head: "a" },
      observe: () => ({ state: "not_applied" }),
      apply,
    });
    expect(record.state).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
  });

  it("returns terminal effects and handles rejected or uncertain observations", async () => {
    const { store, resource, claim } = await fixture();
    const applied = new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    );
    await applied.ensure({
      key: "applied",
      kind: "test",
      request: {},
      observe: () => ({ state: "not_applied" }),
      apply: () => ({ state: "applied", externalRef: "ref" }),
    });
    const observe = vi.fn();
    const apply = vi.fn();
    expect(
      await new ResourceManagerEffectService(
        store,
        resource,
        claim,
        new AbortController().signal,
      ).ensure({
        key: "applied",
        kind: "test",
        request: {},
        observe,
        apply,
      }),
    ).toMatchObject({ state: "applied" });
    expect(observe).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    store.reserveEffect({
      claim,
      key: "uncertain",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "test",
      requestFingerprint: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
    const uncertain = await new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    ).ensure({
      key: "uncertain",
      kind: "test",
      request: {},
      observe: () => ({ state: "indeterminate" }),
      apply: () => ({ state: "rejected", error: "must not run" }),
    });
    expect(uncertain.state).toBe("indeterminate");

    const rejected = await new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    ).ensure({
      key: "rejected",
      kind: "test",
      request: {},
      observe: () => ({ state: "not_applied" }),
      apply: () => ({ state: "rejected", error: "denied" }),
    });
    expect(rejected).toMatchObject({ state: "rejected", error: "denied" });
  });

  it("retries when effect observation fails", async () => {
    const { store, resource, claim } = await fixture();
    store.reserveEffect({
      claim,
      key: "observe-error",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "test",
      requestFingerprint: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
    await expect(
      new ResourceManagerEffectService(store, resource, claim, new AbortController().signal).ensure(
        {
          key: "observe-error",
          kind: "test",
          request: {},
          observe: () => {
            throw new Error("observe failed");
          },
          apply: () => ({ state: "applied" }),
        },
      ),
    ).rejects.toThrow("observe failed");
  });

  it("allows one effect per pass", async () => {
    const { store, resource, claim } = await fixture();
    const effects = new ResourceManagerEffectService(
      store,
      resource,
      claim,
      new AbortController().signal,
    );
    const definition = {
      key: "first",
      kind: "test",
      request: {},
      observe: () => ({ state: "not_applied" as const }),
      apply: () => ({ state: "applied" as const }),
    };
    await effects.ensure(definition);
    await expect(effects.ensure({ ...definition, key: "second" })).rejects.toThrow(/only one/);
  });
});

describe("ResourceManagerWorkflowCoordinator", () => {
  it("rejects control methods that the host does not provide", async () => {
    const { store, resource, claim } = await fixture();
    const workflows = new ResourceManagerWorkflowCoordinator(store, {
      ensure: async (request) => ({ state: "running", runId: request.runId }),
    }).forResource(resource, claim, new AbortController().signal);
    await expect(
      workflows.changeSettings({
        requestKey: "settings",
        runId: "run-1",
        patch: [],
      }),
    ).rejects.toThrow(/does not support workflow settings/);
    await expect(
      workflows.queueFollowUp({ requestKey: "queue", runId: "run-1", prompt: "later" }),
    ).rejects.toThrow(/does not support workflow follow-ups/);
    await expect(
      workflows.removeFollowUp({
        requestKey: "remove",
        runId: "run-1",
        followUpId: "follow-up-1",
      }),
    ).rejects.toThrow(/does not support workflow follow-ups/);
  });

  it("adds managed resource identity to settings and follow-up requests", async () => {
    const { store, resource, claim } = await fixture();
    const changeSettings = vi.fn(async (request) => ({
      runId: request.runId,
      scopeId: request.scopeId ?? "scope-1",
      changeNumber: 2,
      adopted: false,
    }));
    const queueFollowUp = vi.fn(async (request) => ({
      runId: request.runId,
      followUpId: "follow-up-1",
      order: 1,
      state: "queued",
      adopted: false,
    }));
    const removeFollowUp = vi.fn(async (request) => ({
      runId: request.runId,
      followUpId: request.followUpId,
      order: 1,
      state: "removed",
      adopted: false,
    }));
    const coordinator = new ResourceManagerWorkflowCoordinator(store, {
      ensure: async (request) => ({ state: "running", runId: request.runId }),
      changeSettings,
      queueFollowUp,
      removeFollowUp,
    });
    const workflows = coordinator.forResource(resource, claim, new AbortController().signal);
    await expect(
      workflows.changeSettings({ requestKey: " ", runId: "run-1", patch: [] }),
    ).rejects.toThrow(/requestKey must not be empty/);
    await workflows.changeSettings({
      requestKey: "settings-1",
      runId: "run-1",
      patch: [{ op: "replace", path: "/mode", value: "safe" }],
    });
    const queued = await workflows.queueFollowUp({
      requestKey: "follow-1",
      runId: "run-1",
      prompt: "Continue later",
    });
    await workflows.removeFollowUp({
      requestKey: "remove-1",
      runId: "run-1",
      followUpId: queued.followUpId,
    });
    expect(changeSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        managedResourceUid: resource.metadata.uid,
        actorRequestKey: `resourceManager:${resource.metadata.uid}:settings-1`,
      }),
      expect.any(AbortSignal),
    );
    expect(queueFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRequestKey: `resourceManager:${resource.metadata.uid}:follow-1`,
      }),
      expect.any(AbortSignal),
    );
    expect(removeFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRequestKey: `resourceManager:${resource.metadata.uid}:remove-1`,
      }),
      expect.any(AbortSignal),
    );
  });

  it("keeps a stable child request and reports completion to the parent", async () => {
    const { store, resource, claim } = await fixture();
    const scheduler: ResourceManagerWorkflowScheduler = {
      ensure: vi.fn(async (request) => {
        expect(store.getWorkflowByRequestId(request.requestId)).toMatchObject({
          attempt: request.attempt,
          runId: request.runId,
        });
        return { state: "running" as const, runId: request.runId };
      }),
    };
    const coordinator = new ResourceManagerWorkflowCoordinator(store, scheduler);
    const workflows = coordinator.forResource(resource, claim, new AbortController().signal);
    const first = await workflows.ensure({
      requestKey: "repair:a",
      workflow: "repair",
      input: { head: "a" },
    });
    const second = await workflows.ensure({
      requestKey: "repair:a",
      workflow: "repair",
      input: { head: "a" },
    });

    expect(first).toMatchObject({
      state: "running",
      runId: expect.any(String),
      attempt: 1,
    });
    expect(second.requestId).toBe(first.requestId);
    const completed = coordinator.complete(first.requestId, {
      state: "succeeded",
      ...(first.runId !== undefined ? { runId: first.runId } : {}),
    });
    expect(completed.state).toBe("succeeded");
    expect(store.listQueue()).toHaveLength(1);
  });

  it("accepts asynchronous child completion after the reconcile claim is released", async () => {
    const { store, resource, claim } = await fixture();
    let complete: ((result: { state: "succeeded"; runId: string }) => void) | undefined;
    const coordinator = new ResourceManagerWorkflowCoordinator(store, {
      ensure: async (request, _signal, onComplete) => {
        complete = onComplete as typeof complete;
        return { state: "running", runId: request.runId };
      },
    });
    const child = await coordinator
      .forResource(resource, claim, new AbortController().signal)
      .ensure({ requestKey: "async", workflow: "repair", input: {} });
    expect(store.settleClaim(claim)).toBe(true);
    complete?.({ state: "succeeded", runId: child.runId as string });
    expect(store.getWorkflowByRequestId(child.requestId)?.state).toBe("succeeded");
    expect(store.listQueue()).toHaveLength(1);
  });

  it("rejects invalid asynchronous completion authority", async () => {
    const { store, resource, claim } = await fixture();
    const child = store.reserveWorkflow({
      resourceUid: resource.metadata.uid,
      claim,
      requestKey: "completion",
      workflow: "repair",
      inputFingerprint: "c".repeat(64),
    }).record;
    store.updateWorkflow(
      child.requestId,
      { state: "pending", runId: "reserved-run", attempt: 1 },
      claim,
    );
    expect(() =>
      store.completeWorkflow(child.requestId, { state: "running", runId: "reserved-run" }),
    ).toThrow(/settled child state/);
    expect(() =>
      store.completeWorkflow(child.requestId, { state: "succeeded", runId: "other-run" }),
    ).toThrow(/does not match/);
  });

  it("persists a run ID before scheduler startup and reuses it after failure", async () => {
    const { store, resource, claim } = await fixture();
    let reservedRunId: string | undefined;
    const firstCoordinator = new ResourceManagerWorkflowCoordinator(store, {
      ensure: async (request) => {
        reservedRunId = request.runId;
        expect(store.getWorkflowByRequestId(request.requestId)?.runId).toBe(request.runId);
        throw new Error("host stopped after startup");
      },
    });
    const childRequest = { requestKey: "repair:a", workflow: "repair", input: {} };
    await expect(
      firstCoordinator
        .forResource(resource, claim, new AbortController().signal)
        .ensure(childRequest),
    ).rejects.toThrow(/host stopped/);
    expect(reservedRunId).toEqual(expect.any(String));

    const secondCoordinator = new ResourceManagerWorkflowCoordinator(store, {
      ensure: async (request) => {
        expect(request.runId).toBe(reservedRunId);
        return { state: "interrupted", runId: request.runId };
      },
    });
    const recovered = await secondCoordinator
      .forResource(resource, claim, new AbortController().signal)
      .ensure(childRequest);
    expect(recovered).toMatchObject({
      state: "interrupted",
      attempt: 1,
      runId: reservedRunId,
    });
  });

  it("starts another attempt after interruption", async () => {
    const { store, resource, claim } = await fixture();
    const scheduler: ResourceManagerWorkflowScheduler = {
      ensure: async (request) => ({ state: "running", runId: request.runId }),
    };
    const coordinator = new ResourceManagerWorkflowCoordinator(store, scheduler);
    const workflows = coordinator.forResource(resource, claim, new AbortController().signal);
    const first = await workflows.ensure({
      requestKey: "repair:a",
      workflow: "repair",
      input: {},
    });
    coordinator.complete(first.requestId, {
      state: "interrupted",
      ...(first.runId !== undefined ? { runId: first.runId } : {}),
    });
    const second = await workflows.ensure({
      requestKey: "repair:a",
      workflow: "repair",
      input: {},
    });
    expect(second).toMatchObject({
      attempt: 2,
      runId: expect.any(String),
      state: "running",
    });
    expect(second.runId).not.toBe(first.runId);
  });

  it("returns terminal requests and rejects unknown completion IDs", async () => {
    const { store, resource, claim } = await fixture();
    const coordinator = new ResourceManagerWorkflowCoordinator(store, {
      ensure: async () => ({ state: "failed", error: "failed to start" }),
    });
    const workflows = coordinator.forResource(resource, claim, new AbortController().signal);
    const first = await workflows.ensure({ requestKey: "repair:a", workflow: "repair", input: {} });
    const second = await workflows.ensure({
      requestKey: "repair:a",
      workflow: "repair",
      input: {},
    });
    expect(first.state).toBe("failed");
    expect(second.state).toBe("failed");
    expect(() => coordinator.complete("missing", { state: "succeeded" })).toThrow(/not found/);
  });

  it("leaves requests pending when the host has no scheduler", async () => {
    const { store, resource, claim } = await fixture();
    const record = await new ResourceManagerWorkflowCoordinator(store)
      .forResource(resource, claim, new AbortController().signal)
      .ensure({ requestKey: "repair:a", workflow: "repair", input: {} });
    expect(record).toMatchObject({ state: "pending", attempt: 0 });
  });
});
