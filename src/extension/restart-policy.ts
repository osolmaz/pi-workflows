import { createHash } from "node:crypto";
import { canonicalJson } from "../state/json.js";

export const RESTART_LINEAGE_SCHEMA = "pi-workflows.restart-lineage.v1";
export const TERMINAL_SELECTION_SCHEMA = "pi-workflows.terminal-selection.v1";
export const MAX_RESTARTS = 3;

export type RestartLineage = {
  schema: typeof RESTART_LINEAGE_SCHEMA;
  rootRunId: string;
  parentRunId: string;
  restartNumber: number;
  parentTerminalFingerprint: string;
};

export type TerminalLaunchSelection = {
  schema: typeof TERMINAL_SELECTION_SCHEMA;
  sourceRunId: string;
  turnIntentId: string;
  toolCallId: string;
  requestFingerprint: string;
};

export type RestartPolicyDecision = {
  lineage: RestartLineage;
  chainRunIds: string[];
};

export function restartRequestFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function createTerminalLaunchSelection(options: {
  sourceRunId: string;
  turnIntentId: string;
  toolCallId: string;
  request: unknown;
}): TerminalLaunchSelection {
  return {
    schema: TERMINAL_SELECTION_SCHEMA,
    sourceRunId: options.sourceRunId,
    turnIntentId: options.turnIntentId,
    toolCallId: options.toolCallId,
    requestFingerprint: restartRequestFingerprint(options.request),
  };
}

export function terminalSuccessorRunId(turnIntentId: string): string {
  const digest = createHash("sha256").update(turnIntentId).digest("hex");
  return `terminal-successor-${digest}`;
}

export function parseRestartLineage(value: unknown): RestartLineage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Stored workflow restart lineage is invalid");
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "parentRunId,parentTerminalFingerprint,restartNumber,rootRunId,schema" ||
    value.schema !== RESTART_LINEAGE_SCHEMA ||
    typeof value.rootRunId !== "string" ||
    typeof value.parentRunId !== "string" ||
    !Number.isInteger(value.restartNumber) ||
    (value.restartNumber as number) < 1 ||
    (value.restartNumber as number) > MAX_RESTARTS ||
    typeof value.parentTerminalFingerprint !== "string"
  ) {
    throw new Error("Stored workflow restart lineage is invalid");
  }
  return value as RestartLineage;
}

export function parseTerminalLaunchSelection(value: unknown): TerminalLaunchSelection | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Stored workflow terminal selection is invalid");
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "requestFingerprint,schema,sourceRunId,toolCallId,turnIntentId" ||
    value.schema !== TERMINAL_SELECTION_SCHEMA ||
    typeof value.sourceRunId !== "string" ||
    typeof value.turnIntentId !== "string" ||
    typeof value.toolCallId !== "string" ||
    typeof value.requestFingerprint !== "string"
  ) {
    throw new Error("Stored workflow terminal selection is invalid");
  }
  return value as TerminalLaunchSelection;
}

export function evaluateRestartPolicy(options: {
  runId: string;
  terminalFingerprint: string;
  lineage: RestartLineage | undefined;
  lineageForRun: (runId: string) => RestartLineage | undefined;
}): RestartPolicyDecision {
  const chainRunIds = restartChainRunIds(options.runId, options.lineage, options.lineageForRun);
  const restartNumber = options.lineage?.restartNumber ?? 0;
  if (restartNumber >= MAX_RESTARTS) {
    throw new Error(`Workflow restart limit reached (${MAX_RESTARTS} restarts)`);
  }

  let cursor = options.lineage;
  while (cursor !== undefined) {
    if (cursor.parentTerminalFingerprint === options.terminalFingerprint) {
      throw new Error("The same terminal outcome already occurred in this restart chain");
    }
    cursor = options.lineageForRun(cursor.parentRunId);
  }

  return {
    lineage: {
      schema: RESTART_LINEAGE_SCHEMA,
      rootRunId: options.lineage?.rootRunId ?? options.runId,
      parentRunId: options.runId,
      restartNumber: restartNumber + 1,
      parentTerminalFingerprint: options.terminalFingerprint,
    },
    chainRunIds,
  };
}

export function restartChainRunIds(
  runId: string,
  lineage: RestartLineage | undefined,
  lineageForRun: (runId: string) => RestartLineage | undefined,
): string[] {
  const reverse = [runId];
  const seen = new Set(reverse);
  let cursor = lineage;
  let expectedRestartNumber = lineage?.restartNumber ?? 0;
  const rootRunId = lineage?.rootRunId ?? runId;

  while (cursor !== undefined) {
    if (
      cursor.rootRunId !== rootRunId ||
      cursor.restartNumber !== expectedRestartNumber ||
      seen.has(cursor.parentRunId)
    ) {
      throw new Error("Stored workflow restart chain is invalid");
    }
    reverse.push(cursor.parentRunId);
    seen.add(cursor.parentRunId);
    expectedRestartNumber -= 1;
    const parent = lineageForRun(cursor.parentRunId);
    if (expectedRestartNumber === 0) {
      if (cursor.parentRunId !== rootRunId || parent !== undefined) {
        throw new Error("Stored workflow restart chain is invalid");
      }
      cursor = undefined;
    } else {
      if (parent === undefined) throw new Error("Stored workflow restart chain is invalid");
      cursor = parent;
    }
  }

  if (expectedRestartNumber !== 0 || reverse.at(-1) !== rootRunId) {
    throw new Error("Stored workflow restart chain is invalid");
  }
  return reverse.reverse();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
