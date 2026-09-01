import type { JsonValue } from "../state/json.js";
import type { WorkflowClient } from "./client.js";
import type { WorkflowSessionView } from "./view.js";

type ViewerPageKind =
  | "steps"
  | "trace"
  | "session_entries"
  | "session_events"
  | "settings"
  | "follow_ups"
  | "updates";

type ViewerPage = {
  start: number;
  total: number;
  items: JsonValue[];
};

/** Assemble one complete run revision and hydrate every referenced value. */
export async function materializeRunView(
  client: WorkflowClient,
  value: JsonValue,
): Promise<JsonValue> {
  if (
    !isRecord(value) ||
    value.schema !== "pi-workflows.run-view.v1" ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.revision)
  ) {
    return value;
  }
  const view = structuredClone(value);
  const runId = value.runId;
  const revision = value.revision as number;
  const state = isRecord(view.state) ? view.state : {};
  view.state = state;
  const initialSteps = Array.isArray(state.steps) ? state.steps : [];
  const steps = await completePage(client, runId, revision, "steps", {
    start: safeInteger(view.stepStart, 0),
    total: safeInteger(view.stepTotal, initialSteps.length),
    items: initialSteps,
  });
  state.steps = steps;
  view.stepStart = 0;
  view.stepTotal = steps.length;

  const tracePage = pageValue(view.tracePage);
  const trace = await completePage(client, runId, revision, "trace", tracePage);
  view.tracePage = { ...(isRecord(view.tracePage) ? view.tracePage : {}), start: 0, items: trace };

  const session = isRecord(view.session) ? view.session : {};
  view.session = session;
  const entryPage = pageValue(session.entryPage);
  const entries = await completePage(client, runId, revision, "session_entries", entryPage);
  session.entryPage = {
    ...(isRecord(session.entryPage) ? session.entryPage : {}),
    start: 0,
    items: entries,
  };
  const eventPage = pageValue(session.eventPage);
  const events = await completePage(client, runId, revision, "session_events", eventPage);
  session.eventPage = {
    ...(isRecord(session.eventPage) ? session.eventPage : {}),
    start: 0,
    items: events,
  };

  const initialSettings = Array.isArray(view.settingsScopes) ? view.settingsScopes : [];
  const settings = await completePage(client, runId, revision, "settings", {
    start: safeInteger(view.settingsStart, 0),
    total: safeInteger(view.settingsTotal, initialSettings.length),
    items: initialSettings,
  });
  view.settingsScopes = settings;
  view.settingsStart = 0;
  view.settingsTotal = settings.length;

  const followUpQueue = isRecord(view.followUpQueue) ? view.followUpQueue : {};
  const initialFollowUps = Array.isArray(followUpQueue.items) ? followUpQueue.items : [];
  const followUps = await completePage(client, runId, revision, "follow_ups", {
    start: safeInteger(view.followUpStart, 0),
    total: safeInteger(view.followUpTotal, initialFollowUps.length),
    items: initialFollowUps,
  });
  followUpQueue.items = followUps;
  view.followUpQueue = followUpQueue;
  view.followUpStart = 0;
  view.followUpTotal = followUps.length;

  const initialUpdates = Array.isArray(view.updates) ? view.updates : [];
  const updates = await completePage(client, runId, revision, "updates", {
    start: safeInteger(view.updateStart, 0),
    total: safeInteger(view.updateTotal, initialUpdates.length),
    items: initialUpdates,
  });
  view.updates = updates;
  state.updates = updates;
  view.updateStart = 0;
  view.updateTotal = updates.length;

  const hydrated = await client.hydrateContent(runId, view);
  if (!isRecord(hydrated)) return hydrated;
  const workflow = isRecord(hydrated.workflow) ? hydrated.workflow : null;
  if (workflow !== null && isDefinitionSnapshot(workflow.content)) {
    hydrated.workflow = workflow.content;
  }
  materializeGraphHistory(hydrated);
  return hydrated;
}

/** Assemble and hydrate the one session view consumed by the Pi extension. */
export async function materializeSessionView(
  client: WorkflowClient,
  session: WorkflowSessionView,
): Promise<WorkflowSessionView> {
  const run =
    session.run === null
      ? null
      : ((await materializeRunView(client, session.run as unknown as JsonValue)) as unknown as
          | WorkflowSessionView["run"]
          | null);
  const pendingInteractions = await Promise.all(
    session.pendingInteractions.map(async (interaction) => {
      const runId = isRecord(interaction) ? interaction.runId : undefined;
      return typeof runId === "string"
        ? await client.hydrateContent(runId, interaction)
        : interaction;
    }),
  );
  return { ...session, run, pendingInteractions };
}

async function completePage(
  client: WorkflowClient,
  runId: string,
  revision: number,
  kind: ViewerPageKind,
  initial: ViewerPage,
): Promise<JsonValue[]> {
  if (
    initial.start < 0 ||
    initial.total < 0 ||
    initial.start + initial.items.length > initial.total
  ) {
    throw new Error(`Workflow ${kind} page is invalid`);
  }
  const items = Array<JsonValue | undefined>(initial.total).fill(undefined);
  for (const [offset, item] of initial.items.entries()) items[initial.start + offset] = item;
  for (;;) {
    const cursor = items.findIndex((item) => item === undefined);
    if (cursor < 0) return items as JsonValue[];
    const response = await client.request({
      operation: "view.page",
      runId,
      expectedRevision: revision,
      payload: { kind, cursor },
    });
    if (response.outcome !== "accepted" || !isRecord(response.receipt)) {
      throw new Error(response.error ?? `Workflow ${kind} page is unavailable`);
    }
    const page = response.receipt;
    if (
      page.schema !== "pi-workflows.run-page.v1" ||
      page.runId !== runId ||
      page.revision !== revision ||
      page.kind !== kind ||
      page.cursor !== cursor ||
      !Number.isSafeInteger(page.start) ||
      page.total !== initial.total ||
      !Array.isArray(page.items)
    ) {
      throw new Error(`Workflow ${kind} page changed while loading`);
    }
    const start = page.start as number;
    if (start < 0 || start + page.items.length > initial.total) {
      throw new Error(`Workflow ${kind} page is outside its history`);
    }
    let added = 0;
    for (const [offset, item] of page.items.entries()) {
      const index = start + offset;
      if (items[index] === undefined) added += 1;
      items[index] = item;
    }
    if (added === 0) throw new Error(`Workflow ${kind} page made no progress`);
  }
}

function materializeGraphHistory(view: Record<string, JsonValue>): void {
  const state = isRecord(view.state) ? view.state : {};
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const cursor = Math.min(safeInteger(view.graphCursor, steps.length - 1), steps.length - 1);
  const latest = new Map<string, { index: number; step: JsonValue }>();
  const transitions = new Set<string>();
  let previousNodeId: string | undefined;
  for (const [index, step] of steps.entries()) {
    if (index > cursor || !isRecord(step) || typeof step.nodeId !== "string") continue;
    latest.set(step.nodeId, { index, step });
    if (previousNodeId !== undefined) transitions.add(`${previousNodeId}->${step.nodeId}`);
    previousNodeId = step.nodeId;
  }
  view.graphSteps = [...latest.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ step }) => step);
  view.takenTransitions = [...transitions].sort();
}

function pageValue(value: JsonValue | undefined): ViewerPage {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.items) ? record.items : [];
  const start = safeInteger(record.start, 0);
  return {
    start,
    total: safeInteger(record.total, start + items.length),
    items,
  };
}

function safeInteger(value: JsonValue | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function isDefinitionSnapshot(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return isRecord(value) && value.schema === "pi-workflows.definition-snapshot.v1";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
