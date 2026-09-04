import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import rawWorkflow from "../examples/workflows/echo.workflow.js";
import { SqliteResourceManagerStore } from "../src/resource-managers/sqlite.js";
import { canonicalJson } from "../src/state/json.js";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { makeTempDir } from "./helpers.js";

const workflow = compileWorkflowDefinition(rawWorkflow);
const snapshot = createDefinitionSnapshot(workflow);
const definitionDigest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
const stores: Array<{ queue: SqliteResourceManagerStore; runs: WorkflowRunStore }> = [];

afterEach(() => {
  for (const { queue, runs } of stores.splice(0)) {
    runs.close();
    queue.close();
  }
});

async function fixture(runId: string, claimed = true) {
  const projectPath = await makeTempDir("workflow-effects-project");
  const databasePath = path.join(await makeTempDir("workflow-effects-state"), "state.sqlite");
  const queue = new SqliteResourceManagerStore(databasePath, { projectPath });
  const reservation = {
    runId,
    workflowName: workflow.name,
    workflowSourceRef: "builtin:echo",
    workflowSource: { kind: "builtin" as const, id: "echo", revision: "test" },
    definitionDigest,
    definitionSnapshot: snapshot,
    input: {},
    launchOptions: {},
    runnerId: "effect-runner",
    originSessionId: "effect-session",
  };
  if (claimed) {
    queue.enqueueWorkflowRun({
      ...reservation,
      claimToken: "effect-token",
      leaseMs: 60_000,
    });
  } else {
    queue.reserveWorkflowRun(reservation);
  }
  const runs = new WorkflowRunStore(
    databasePath,
    claimed ? { authorityProvider: () => queue.workflowRunAuthority(runId, "effect-token") } : {},
  );
  runs.synchronizeRevision(runId);
  stores.push({ queue, runs });
  return { queue, runs };
}

describe("workflow managed effects", () => {
  it("adopts settled receipts and rejects reused requests", async () => {
    const { runs } = await fixture("effect-adoption");
    const options = {
      runId: "effect-adoption",
      attemptId: "attempt-1",
      effectType: "test.delivery",
      idempotencyKey: "delivery-1",
      request: { value: 1 },
      recovery: "idempotent" as const,
    };
    const first = await runs.reserveEffect(options);
    expect(first).toMatchObject({ attemptNumber: 1, disposition: "execute" });
    expect(await runs.reserveEffect(options)).toMatchObject({ disposition: "ambiguous" });

    await runs.settleEffect({
      runId: options.runId,
      effectId: first.effectId,
      attemptNumber: first.attemptNumber,
      outcome: "applied",
      result: { delivered: true },
    });
    expect(await runs.reserveEffect(options)).toMatchObject({
      attemptNumber: 1,
      disposition: "adopted",
      result: { delivered: true },
    });
    await expect(runs.reserveEffect({ ...options, request: { value: 2 } })).rejects.toThrow(
      "Managed effect key was reused with another request",
    );
    await expect(
      runs.settleEffect({
        runId: options.runId,
        effectId: first.effectId,
        attemptNumber: first.attemptNumber,
        outcome: "applied",
      }),
    ).rejects.toThrow("Managed effect is not applying");
  });

  it("records every terminal outcome and an empty adopted receipt", async () => {
    const { runs } = await fixture("effect-outcomes", false);
    for (const [key, outcome, error] of [
      ["empty", "applied", undefined],
      ["rejected", "rejected", "request failed"],
      ["cancelled", "cancelled", "cancelled"],
      ["ambiguous", "ambiguous", "unknown"],
    ] as const) {
      const reservation = await runs.reserveEffect({
        runId: "effect-outcomes",
        attemptId: `attempt-${key}`,
        effectType: "test.outcome",
        idempotencyKey: key,
        request: null,
        recovery: "manual",
      });
      await runs.settleEffect({
        runId: "effect-outcomes",
        effectId: reservation.effectId,
        attemptNumber: reservation.attemptNumber,
        outcome,
        ...(error === undefined ? {} : { error }),
      });
      const repeated = await runs.reserveEffect({
        runId: "effect-outcomes",
        attemptId: `attempt-${key}`,
        effectType: "test.outcome",
        idempotencyKey: key,
        request: null,
        recovery: "manual",
      });
      expect(repeated.disposition).toBe(outcome === "applied" ? "adopted" : "ambiguous");
      if (outcome === "applied") expect(repeated).not.toHaveProperty("result");
    }
  });

  it("retries interrupted idempotent effects and blocks manual effects", async () => {
    const { runs } = await fixture("effect-recovery");
    const idempotent = await runs.reserveEffect({
      runId: "effect-recovery",
      attemptId: "attempt-idempotent",
      effectType: "test.recovery",
      idempotencyKey: "idempotent",
      request: {},
      recovery: "idempotent",
    });
    await runs.reserveEffect({
      runId: "effect-recovery",
      attemptId: "attempt-manual",
      effectType: "test.recovery",
      idempotencyKey: "manual",
      request: {},
      recovery: "manual",
    });

    expect(await runs.recoverApplyingEffects("effect-recovery")).toBe("ambiguous");
    expect(
      await runs.reserveEffect({
        runId: "effect-recovery",
        attemptId: "attempt-idempotent",
        effectType: "test.recovery",
        idempotencyKey: "idempotent",
        request: {},
        recovery: "idempotent",
      }),
    ).toMatchObject({ effectId: idempotent.effectId, attemptNumber: 2, disposition: "execute" });
    expect(
      await runs.reserveEffect({
        runId: "effect-recovery",
        attemptId: "attempt-manual",
        effectType: "test.recovery",
        idempotencyKey: "manual",
        request: {},
        recovery: "manual",
      }),
    ).toMatchObject({ disposition: "ambiguous" });
  });

  it("returns safe when recovery has no applying effects and validates keys", async () => {
    const { runs } = await fixture("effect-validation", false);
    expect(await runs.recoverApplyingEffects("effect-validation")).toBe("safe");
    await expect(
      runs.reserveEffect({
        runId: "effect-validation",
        attemptId: "attempt-invalid",
        effectType: "",
        idempotencyKey: "valid",
        request: {},
        recovery: "manual",
      }),
    ).rejects.toThrow("Managed effect type must be nonempty text");
    await expect(
      runs.reserveEffect({
        runId: "effect-validation",
        attemptId: "attempt-invalid",
        effectType: "valid",
        idempotencyKey: "",
        request: {},
        recovery: "manual",
      }),
    ).rejects.toThrow("Managed effect idempotency key must be nonempty text");
  });
});
