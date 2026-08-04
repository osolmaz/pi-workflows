import type { ControllerStatusPatch, ReconcileContext, ReconcileResult } from "./types.js";

export function createResultHelpers<TStatus>(): Pick<
  ReconcileContext<TStatus>,
  "settled" | "requeue" | "requeueAfter"
> {
  return {
    settled: (status) => ({
      kind: "settled",
      ...(status !== undefined ? { status } : {}),
    }),
    requeue: (status) => ({
      kind: "requeue",
      ...(status !== undefined ? { status } : {}),
    }),
    requeueAfter: (afterMs, status) => {
      if (!Number.isSafeInteger(afterMs) || afterMs <= 0) {
        throw new Error("requeueAfter requires a positive safe integer");
      }
      return {
        kind: "requeue",
        afterMs,
        ...(status !== undefined ? { status } : {}),
      } satisfies ReconcileResult<TStatus>;
    },
  };
}

export function settled<TStatus>(
  status?: ControllerStatusPatch<TStatus>,
): ReconcileResult<TStatus> {
  return createResultHelpers<TStatus>().settled(status);
}

export function requeue<TStatus>(
  status?: ControllerStatusPatch<TStatus>,
): ReconcileResult<TStatus> {
  return createResultHelpers<TStatus>().requeue(status);
}

export function requeueAfter<TStatus>(
  afterMs: number,
  status?: ControllerStatusPatch<TStatus>,
): ReconcileResult<TStatus> {
  return createResultHelpers<TStatus>().requeueAfter(afterMs, status);
}
