import type { JsonValue } from "../src/state/json.js";
import { recordWorkflowSubmission, requestForAttempt } from "../src/workflows/requests.js";
import type { WorkflowRunStore } from "../src/workflows/store.js";
import type { HumanDecisionRequest, WorkflowRunState } from "../src/workflows/types.js";

export function checkpointRequest(store: WorkflowRunStore, state: WorkflowRunState) {
  const request = requestForAttempt(store.state, state.runId, state.currentAttemptId!);
  if (request === undefined) throw new Error("Test checkpoint request is missing");
  return request;
}

export function humanRequest(
  store: WorkflowRunStore,
  state: WorkflowRunState,
): HumanDecisionRequest {
  const request = checkpointRequest(store, state);
  if (request.kind !== "decision") throw new Error("Test checkpoint is not a human decision");
  return request.contract as unknown as HumanDecisionRequest;
}

export function submitCheckpoint(
  store: WorkflowRunStore,
  state: WorkflowRunState,
  output: JsonValue,
) {
  const request = checkpointRequest(store, state);
  return recordWorkflowSubmission(store.state, {
    requestId: request.requestId,
    submissionId: `answer-${request.requestId}`,
    idempotencyKey: `answer-${request.requestId}`,
    expectedRevision: request.revision,
    payload: output,
    outcome: "accepted",
    settle: true,
  });
}
