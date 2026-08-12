import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WorkflowDefinition } from "./types.js";

export type BuiltinWorkflow = {
  definition: WorkflowDefinition;
  path: string;
  sourceHash: string;
};

export type BuiltinWorkflowCandidate = {
  name: string;
  definition: WorkflowDefinition;
  candidatePaths: string[];
};

/** Capture built-in definitions and source hashes for one process version. */
export function captureBuiltinWorkflows(candidates: BuiltinWorkflowCandidate[]): {
  byName: Map<string, BuiltinWorkflow>;
  byPath: Map<string, BuiltinWorkflow>;
} {
  const byName = new Map<string, BuiltinWorkflow>();
  const byPath = new Map<string, BuiltinWorkflow>();
  for (const candidate of candidates) {
    const moduleFiles = candidate.candidatePaths.flatMap((filePath) => {
      try {
        return [{ filePath, source: readFileSync(filePath) }];
      } catch {
        return [];
      }
    });
    const moduleFile = moduleFiles[0];
    if (moduleFile === undefined) {
      throw new Error(`Built-in workflow module is missing: ${candidate.name}`);
    }
    const workflow = {
      definition: candidate.definition,
      path: moduleFile.filePath,
      sourceHash: createHash("sha256").update(moduleFile.source).digest("hex"),
    };
    byName.set(candidate.name, workflow);
    for (const file of moduleFiles) {
      byPath.set(file.filePath, workflow);
    }
  }
  return { byName, byPath };
}
