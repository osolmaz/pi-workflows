import { isDeepStrictEqual } from "node:util";

/** Match an abort to the fixture's exact saved workflow input, not later chat. */
export function workflowAbortAttempt(event, entries, runId) {
  if (
    event.type !== "message_end" ||
    event.message?.role !== "assistant" ||
    event.message.stopReason !== "error" ||
    !/\babort(?:ed)?\b/i.test(event.message.errorMessage ?? "") ||
    !Array.isArray(entries)
  )
    return undefined;
  const index = entries.findIndex(
    (entry) => entry.type === "message" && isDeepStrictEqual(entry.message, event.message),
  );
  if (index < 0) return undefined;
  const input = entries
    .slice(0, index)
    .reverse()
    .find(
      (entry) =>
        entry.type === "custom_message" ||
        (entry.type === "message" && entry.message?.role === "user"),
    );
  const contract = input?.details?.contract;
  return input?.customType === "pi-workflows-step" &&
    contract?.runId === runId &&
    contract.nodeId === "work" &&
    typeof contract.attemptId === "string"
    ? contract.attemptId
    : undefined;
}

/** Accept the abort only after the workflow server has recorded that same attempt's timeout. */
export function isExpectedWorkflowAbort(event, entries, state, runId) {
  const attemptId = workflowAbortAttempt(event, entries, runId);
  return (
    attemptId !== undefined &&
    state?.runId === runId &&
    Array.isArray(state.steps) &&
    state.steps.some(
      (step) =>
        step.nodeId === "work" && step.attemptId === attemptId && step.outcome === "timed_out",
    )
  );
}
