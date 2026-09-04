import type { JsonValue } from "../state/json.js";

export type ResolvedWorkflowLaunch = {
  schema: "pi-workflows.resolved-launch.v1";
  workflowName: string;
  workflowSourceRef: string;
  workflowSource: JsonValue;
  definitionDigest: string;
  definitionSnapshot: JsonValue;
};

export type ResolvedResourceManagerInitialization = {
  schema: "pi-workflows.resolved-resource-manager-initialization.v1";
  resourceManagerName: string;
  resourceManagerPath: string;
  sourceHash: string;
  initialStatus: JsonValue;
};

export type ResolvedSettingsChange = {
  schema: "pi-workflows.resolved-settings-change.v1";
  definitionDigest: string;
  patch: JsonValue;
  settings: JsonValue;
  paths: JsonValue;
};
