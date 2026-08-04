import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerEffectService } from "../src/controllers/effects.js";
import { SqliteControllerStore } from "../src/controllers/sqlite.js";
import type { ControllerStore } from "../src/controllers/store.js";
import {
  ControllerWorkflowCoordinator,
  type ControllerWorkflowScheduler,
} from "../src/controllers/workflows.js";
import { makeTempDir } from "./helpers.js";

const stores: ControllerStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

async function fixture() {
  const dir = await makeTempDir("pi-controller-services");
  const store = new SqliteControllerStore(path.join(dir, "controller.sqlite"));
  stores.push(store);
  const resource = store.putResource({
    controller: "demo",
    key: "one",
    spec: {},
    initialStatus: {},
  });
  return { store, resource };
}

describe("ControllerEffectService", () => {
  it("applies a new effect and returns a saved receipt", async () => {
    const { store, resource } = await fixture();
    const observe = vi.fn(() => ({ state: "not_applied" as const }));
    const apply = vi.fn(() => ({ state: "applied" as const, externalRef: "sha" }));
    const effects = new ControllerEffectService(store, resource, new AbortController().signal);

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
    const { store, resource } = await fixture();
    const first = new ControllerEffectService(store, resource, new AbortController().signal);
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
    const recovered = await new ControllerEffectService(
      store,
      resource,
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
    const { store, resource } = await fixture();
    store.reserveEffect({
      key: "merge:one",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "merge",
      requestFingerprint: "40764401a76928bdb533b0a6f4fcdb0c89d16c453354f704c610c36d3b3bb063",
    });
    const apply = vi.fn(() => ({ state: "applied" as const }));
    const record = await new ControllerEffectService(
      store,
      resource,
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
    const { store, resource } = await fixture();
    const applied = new ControllerEffectService(store, resource, new AbortController().signal);
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
      await new ControllerEffectService(store, resource, new AbortController().signal).ensure({
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
      key: "uncertain",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "test",
      requestFingerprint: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
    const uncertain = await new ControllerEffectService(
      store,
      resource,
      new AbortController().signal,
    ).ensure({
      key: "uncertain",
      kind: "test",
      request: {},
      observe: () => ({ state: "indeterminate" }),
      apply: () => ({ state: "rejected", error: "must not run" }),
    });
    expect(uncertain.state).toBe("indeterminate");

    const rejected = await new ControllerEffectService(
      store,
      resource,
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
    const { store, resource } = await fixture();
    store.reserveEffect({
      key: "observe-error",
      resourceUid: resource.metadata.uid,
      generation: 1,
      kind: "test",
      requestFingerprint: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
    await expect(
      new ControllerEffectService(store, resource, new AbortController().signal).ensure({
        key: "observe-error",
        kind: "test",
        request: {},
        observe: () => {
          throw new Error("observe failed");
        },
        apply: () => ({ state: "applied" }),
      }),
    ).rejects.toThrow("observe failed");
  });

  it("allows one effect per pass", async () => {
    const { store, resource } = await fixture();
    const effects = new ControllerEffectService(store, resource, new AbortController().signal);
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

describe("ControllerWorkflowCoordinator", () => {
  it("keeps a stable child request and reports completion to the parent", async () => {
    const { store, resource } = await fixture();
    const scheduler: ControllerWorkflowScheduler = {
      ensure: vi.fn(async (request) => ({
        state: "running" as const,
        runId: request.runId ?? `run-${request.attempt}`,
      })),
    };
    const coordinator = new ControllerWorkflowCoordinator(store, scheduler);
    const workflows = coordinator.forResource(resource, new AbortController().signal);
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

    expect(first).toMatchObject({ state: "running", runId: "run-1", attempt: 1 });
    expect(second.requestId).toBe(first.requestId);
    const completed = coordinator.complete(first.requestId, {
      state: "succeeded",
      runId: "run-1",
    });
    expect(completed.state).toBe("succeeded");
    expect(store.listQueue()).toHaveLength(1);
  });

  it("starts another attempt after interruption", async () => {
    const { store, resource } = await fixture();
    const scheduler: ControllerWorkflowScheduler = {
      ensure: async (request) => ({ state: "running", runId: `run-${request.attempt}` }),
    };
    const coordinator = new ControllerWorkflowCoordinator(store, scheduler);
    const workflows = coordinator.forResource(resource, new AbortController().signal);
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
    expect(second).toMatchObject({ attempt: 2, runId: "run-2", state: "running" });
  });

  it("returns terminal requests and rejects unknown completion IDs", async () => {
    const { store, resource } = await fixture();
    const coordinator = new ControllerWorkflowCoordinator(store, {
      ensure: async () => ({ state: "failed", error: "failed to start" }),
    });
    const workflows = coordinator.forResource(resource, new AbortController().signal);
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
    const { store, resource } = await fixture();
    const record = await new ControllerWorkflowCoordinator(store)
      .forResource(resource, new AbortController().signal)
      .ensure({ requestKey: "repair:a", workflow: "repair", input: {} });
    expect(record).toMatchObject({ state: "pending", attempt: 0 });
  });
});
