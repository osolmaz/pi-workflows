import type {
  WorkflowDisplayStatus,
  WorkflowSessionNodeRow,
  WorkflowSessionRunView,
} from "../client/view.js";
import type {
  WorkflowDefinitionSnapshot,
  WorkflowNodeResult,
  WorkflowRunState,
  WorkflowStepRecord,
  WorkflowUpdateRecord,
} from "../workflows/types.js";

/** Widget inputs rebuilt from the bounded session run view. */
export type WidgetRunInput = {
  state: WorkflowRunState;
  snapshot: WorkflowDefinitionSnapshot;
  updates: WorkflowUpdateRecord[];
};

/**
 * Rebuild the widget inputs from the compact session run view.
 *
 * The server sends semantic facts only: node identity, kind, state, attempts,
 * and bounded detail. The widget keeps its existing rendering, coloring, and
 * scrolling code. This adapter restores the shape that code consumes so the
 * session snapshot never has to carry complete run history.
 */
export function widgetRunInput(run: WorkflowSessionRunView): WidgetRunInput {
  const runningNode = displayedRunningNode(run);
  const nodes: Record<string, WorkflowDefinitionSnapshot["nodes"][string]> = {};
  const results: WorkflowRunState["results"] = {};
  const steps: WorkflowStepRecord[] = [];
  let currentNode: string | undefined;
  let waitingOn: string | undefined;
  let humanDecision: WorkflowRunState["humanDecision"];
  let finalOutput: unknown;
  let currentSettingsChangeNumber: number | undefined;

  for (const row of run.nodes) {
    nodes[row.nodeId] = nodeSnapshot(row);
    if (row.state === "running") currentNode = row.nodeId;
    if (row.state === "waiting") waitingOn = row.nodeId;
    const isCurrent = row.nodeId === runningNode;
    if (row.state === "ok" || row.state === "failed") {
      results[row.nodeId] = nodeResult(row);
    }
    // The widget counts one extra attempt for the node it shows as running and
    // reads the fixed settings number of the current node from the run state.
    const completed = Math.max(0, row.attempts - (isCurrent ? 1 : 0));
    for (let index = 0; index < completed; index += 1) {
      steps.push(stepRecord(row, index === completed - 1 ? row.settingsChangeNumber : undefined));
    }
    if (isCurrent && row.settingsChangeNumber !== null) {
      currentSettingsChangeNumber = row.settingsChangeNumber;
    }
    if (row.humanDecision !== null) {
      if (row.humanDecision.choiceValue !== null) {
        humanDecision = {
          nodeId: row.nodeId,
          response: { choice: row.humanDecision.choiceValue },
        } as WorkflowRunState["humanDecision"];
      }
      if (row.state === "waiting") finalOutput = decisionRequest(row);
    }
  }

  const state: WorkflowRunState = {
    schema: "pi-workflows.run-state.v1",
    traceSeq: run.revision,
    runId: run.runId,
    workflowName: run.workflowName,
    ...(run.runTitle === null ? {} : { runTitle: run.runTitle }),
    startedAt: "",
    updatedAt: "",
    status: runStatus(run.display.status),
    input: null,
    outputs: run.monitorEstimate === null ? {} : { estimate: run.monitorEstimate },
    results,
    steps,
    updates: sessionUpdates(run),
    ...(run.paused ? { paused: true } : {}),
    ...(currentNode === undefined ? {} : { currentNode }),
    ...(waitingOn === undefined ? {} : { waitingOn }),
    ...(currentSettingsChangeNumber === undefined ? {} : { currentSettingsChangeNumber }),
    ...(run.error === null ? {} : { error: run.error }),
    ...(humanDecision === undefined ? {} : { humanDecision }),
    ...(finalOutput === undefined ? {} : { finalOutput }),
  };

  return {
    state,
    snapshot: {
      schema: "pi-workflows.definition-snapshot.v1",
      name: run.workflowName,
      startAt: run.nodes[0]?.nodeId ?? "",
      nodes,
      edges: [],
    },
    updates: state.updates ?? [],
  };
}

/** The node the widget shows as running: the same rule as the widget itself. */
function displayedRunningNode(run: WorkflowSessionRunView): string | undefined {
  const running = run.nodes.find((row) => row.state === "running")?.nodeId;
  if (running !== undefined) return running;
  if (run.display.status !== "running") return undefined;
  return run.nodes.find((row) => row.state === "waiting")?.nodeId;
}

function nodeSnapshot(row: WorkflowSessionNodeRow): WorkflowDefinitionSnapshot["nodes"][string] {
  const humanDecision =
    row.humanDecision === null
      ? undefined
      : {
          audience: row.humanDecision.audience,
          choices: Object.fromEntries(
            row.humanDecision.choices.map((choice) => [choice.value, { label: choice.label }]),
          ),
        };
  return {
    nodeType: row.nodeType as WorkflowDefinitionSnapshot["nodes"][string]["nodeType"],
    ...(row.assistantResponse ? { expectedOutput: { kind: "assistant-message" as const } } : {}),
    ...(humanDecision === undefined ? {} : { humanDecision }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.statusDetail === null ? {} : { statusDetail: row.statusDetail }),
    ...(row.actionExecution ? { actionExecution: "function" as const } : {}),
  };
}

function nodeResult(row: WorkflowSessionNodeRow): WorkflowNodeResult {
  return {
    attemptId: "",
    nodeId: row.nodeId,
    nodeType: row.nodeType as WorkflowNodeResult["nodeType"],
    outcome: row.outcome ?? (row.state === "ok" ? "ok" : "failed"),
    startedAt: row.startedAt ?? "",
    finishedAt: "",
    durationMs: row.durationMs ?? Number.NaN,
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function stepRecord(
  row: WorkflowSessionNodeRow,
  settingsChangeNumber: number | null | undefined,
): WorkflowStepRecord {
  return {
    attemptId: "",
    nodeId: row.nodeId,
    nodeType: row.nodeType as WorkflowStepRecord["nodeType"],
    outcome: row.outcome ?? (row.state === "ok" ? "ok" : "failed"),
    startedAt: "",
    finishedAt: "",
    prompt: null,
    output: null,
    ...(settingsChangeNumber === null || settingsChangeNumber === undefined
      ? {}
      : { settingsChangeNumber }),
  };
}

/** The decision request facts the widget shows for a waiting human-decision node. */
function decisionRequest(row: WorkflowSessionNodeRow): unknown {
  const human = row.humanDecision;
  if (human === null) return undefined;
  return {
    schema: "pi-workflows.human-decision-request.v1",
    nodeId: row.nodeId,
    audience: human.audience,
    ...(human.summary === null ? {} : { presentation: { summary: human.summary } }),
    ...(human.presentationDigest === null ? {} : { presentationDigest: human.presentationDigest }),
  };
}

/**
 * The widget reads progress and monitor schedule facts from update records. The
 * session view carries the same facts directly, so one record per fact restores
 * the existing progress lines.
 */
function sessionUpdates(run: WorkflowSessionRunView): WorkflowUpdateRecord[] {
  const updates: WorkflowUpdateRecord[] = [];
  for (const [index, progress] of run.progressUpdates.entries()) {
    updates.push({
      updateId: `session-progress-${progress.key}`,
      seq: index + 1,
      at: progress.at,
      runId: run.runId,
      nodeId: "",
      attemptId: "",
      type: "progress",
      key: progress.key,
      data: progress.data as Record<string, unknown>,
    });
  }
  if (run.monitorSchedule !== null) {
    updates.push({
      updateId: "session-monitor-schedule",
      seq: updates.length + 1,
      at: run.monitorSchedule.recordedAt,
      runId: run.runId,
      nodeId: "",
      attemptId: "",
      type: "monitor.schedule",
      key: "next-check",
      data: { nextCheckAt: run.monitorSchedule.nextCheckAt },
    });
  }
  return updates;
}

function runStatus(status: WorkflowDisplayStatus): WorkflowRunState["status"] {
  if (status === "queued") return "running";
  if (status === "paused") return "waiting";
  if (status === "ambiguous") return "failed";
  return status;
}
