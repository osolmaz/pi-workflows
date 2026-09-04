import fs from "node:fs";
import path from "node:path";
import { StateDatabase, workflowStatePath } from "../state/database.js";

/** Verify only an explicit inactive backup. Active state is verified through WorkflowClient. */
export function verifyInactiveBackup(
  databasePath: string,
  activeDatabasePath: string = workflowStatePath(),
): void {
  const resolved = path.resolve(databasePath);
  const active = path.resolve(activeDatabasePath);
  if (sameFile(resolved, active)) {
    throw new Error("Active workflow state must be verified through the workflow server");
  }
  const state = new StateDatabase({ filePath: resolved, mode: "read-only" });
  try {
    state.integrityCheck();
  } finally {
    state.close();
  }
}

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}
