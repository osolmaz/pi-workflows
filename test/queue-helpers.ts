import type {
  WorkflowRunQueueStore,
  WorkflowRunReservationOptions,
} from "../src/workflows/queue.js";

/** A claimed queue fixture, without running the production scheduler. */
export function claimTestRun(
  queue: WorkflowRunQueueStore,
  options: WorkflowRunReservationOptions & {
    runnerId: string;
    claimToken: string;
    leaseMs: number;
  },
) {
  queue.reserveWorkflowRun(options);
  const claimed = queue.claimWorkflowRun(options);
  if (claimed === undefined) throw new Error(`Test run could not be claimed: ${options.runId}`);
  return claimed;
}
