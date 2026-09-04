#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { builtinWorkflowCatalog } from "../builtins/catalog.js";
import { MAX_PROTOCOL_MESSAGE_BYTES } from "../client/protocol.js";
import type {
  ResolvedResourceManagerInitialization,
  ResolvedSettingsChange,
  ResolvedWorkflowLaunch,
} from "../client/resolver.js";
import { discoverResourceManagers, loadResourceManagerFile } from "../resource-managers/loader.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import { compositionMetadata } from "../workflows/composition.js";
import { errorMessage } from "../workflows/errors.js";
import { validateWorkflowDefinition } from "../workflows/graph.js";
import { resolveWorkflowRef } from "../workflows/loader.js";
import { applyWorkflowSettingsPatch } from "../workflows/settings.js";
import { createDefinitionSnapshot } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowSource } from "../workflows/types.js";
export type {
  ResolvedResourceManagerInitialization,
  ResolvedSettingsChange,
  ResolvedWorkflowLaunch,
} from "../client/resolver.js";

type ResolverRequest = {
  schema: "pi-workflows.resolve-request.v1";
  cwd: string;
  workflowRef: string;
};

type SettingsValidationRequest = {
  schema: "pi-workflows.settings-validation-request.v1";
  cwd: string;
  workflowRef: string;
  definitionDigest: string;
  mountPath: string;
  current: JsonValue;
  patch: JsonValue;
  actorId: string;
};

type ResourceManagerInitializationRequest = {
  schema: "pi-workflows.resource-manager-initialization-request.v1";
  cwd: string;
  resourceManagerName: string;
  spec: JsonValue;
};

type ResolverInput =
  | ResolverRequest
  | SettingsValidationRequest
  | ResourceManagerInitializationRequest;
type ResolverOutput =
  | ResolvedWorkflowLaunch
  | ResolvedSettingsChange
  | ResolvedResourceManagerInitialization;

export async function resolveWorkflowLaunch(
  request: ResolverRequest,
): Promise<ResolvedWorkflowLaunch> {
  if (request.schema !== "pi-workflows.resolve-request.v1") {
    throw new Error("Invalid workflow resolver request schema");
  }
  const resolved = await loadResolvedWorkflow(request.cwd, request.workflowRef);
  return {
    schema: "pi-workflows.resolved-launch.v1",
    workflowName: resolved.definition.name,
    workflowSourceRef: sourceRef(resolved.source),
    workflowSource: {
      root: resolved.source,
      mounted: compositionMetadata(resolved.definition)?.sources ?? [],
    } as JsonValue,
    definitionDigest: resolved.definitionDigest,
    definitionSnapshot: resolved.snapshot,
  };
}

export async function resolveResourceManagerInitialization(
  request: ResourceManagerInitializationRequest,
): Promise<ResolvedResourceManagerInitialization> {
  const discovered = (await discoverResourceManagers({ cwd: request.cwd })).find(
    (candidate) => candidate.name === request.resourceManagerName,
  );
  if (discovered === undefined) {
    throw new Error(`ResourceManager not found: ${request.resourceManagerName}`);
  }
  const definition = await loadResourceManagerFile(discovered.path);
  if (definition.name !== request.resourceManagerName) {
    throw new Error("ResourceManager source name does not match its discovered name");
  }
  const initialStatus = parseJson(canonicalJson(definition.initialStatus(request.spec)));
  const sourceHash = createHash("sha256")
    .update(await fs.readFile(discovered.path))
    .digest("hex");
  return {
    schema: "pi-workflows.resolved-resource-manager-initialization.v1",
    resourceManagerName: definition.name,
    resourceManagerPath: discovered.path,
    sourceHash,
    initialStatus,
  };
}

export async function resolveSettingsChange(
  request: SettingsValidationRequest,
): Promise<ResolvedSettingsChange> {
  if (request.schema !== "pi-workflows.settings-validation-request.v1") {
    throw new Error("Invalid workflow settings validation request schema");
  }
  const resolved = await loadResolvedWorkflow(request.cwd, request.workflowRef);
  if (resolved.definitionDigest !== request.definitionDigest) {
    throw new Error("Workflow source changed before the settings proposal was validated");
  }
  const definition = settingsDefinition(resolved.definition, request.mountPath);
  if (definition === undefined) {
    throw new Error(
      `Workflow scope ${request.mountPath || "/"} does not declare editable settings`,
    );
  }
  const applied = await applyWorkflowSettingsPatch(
    definition,
    request.current,
    request.patch,
    { type: "controller", id: request.actorId },
    "controller-request",
  );
  return {
    schema: "pi-workflows.resolved-settings-change.v1",
    definitionDigest: resolved.definitionDigest,
    patch: applied.patch as JsonValue,
    settings: applied.json,
    paths: definition.paths as unknown as JsonValue,
  };
}

async function loadResolvedWorkflow(
  cwd: string,
  workflowRef: string,
): Promise<{
  definition: WorkflowDefinition;
  source: WorkflowSource;
  snapshot: JsonValue;
  definitionDigest: string;
}> {
  const resolved = await resolveWorkflowRef(workflowRef, { cwd }, builtinWorkflowCatalog);
  validateWorkflowDefinition(resolved.definition);
  const snapshot = createDefinitionSnapshot(resolved.definition) as unknown as JsonValue;
  const definitionDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(snapshot))
    .digest("hex")}`;
  return { definition: resolved.definition, source: resolved.source, snapshot, definitionDigest };
}

function settingsDefinition(definition: WorkflowDefinition, mountPath: string) {
  return mountPath === ""
    ? definition.settings
    : compositionMetadata(definition)?.scopes[mountPath]?.settings;
}

function sourceRef(source: WorkflowSource): string {
  return source.kind === "builtin" ? `builtin:${source.id}` : source.path;
}

async function readRequest(): Promise<ResolverInput> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new Error("Workflow resolver request exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  const value = parseJson(Buffer.concat(chunks).toString("utf8").trimEnd());
  if (!isRecord(value) || typeof value.cwd !== "string") {
    throw new Error("Invalid source resolver request");
  }
  if (value.schema === "pi-workflows.resolve-request.v1" && typeof value.workflowRef === "string") {
    return value as ResolverRequest;
  }
  if (
    value.schema === "pi-workflows.resource-manager-initialization-request.v1" &&
    typeof value.resourceManagerName === "string" &&
    Object.hasOwn(value, "spec")
  ) {
    return value as ResourceManagerInitializationRequest;
  }
  if (
    value.schema === "pi-workflows.settings-validation-request.v1" &&
    typeof value.workflowRef === "string" &&
    typeof value.definitionDigest === "string" &&
    typeof value.mountPath === "string" &&
    typeof value.actorId === "string" &&
    Object.hasOwn(value, "current") &&
    Object.hasOwn(value, "patch")
  ) {
    return value as SettingsValidationRequest;
  }
  throw new Error("Invalid workflow resolver request schema");
}

async function main(): Promise<void> {
  try {
    const request = await readRequest();
    const result: ResolverOutput =
      request.schema === "pi-workflows.resolve-request.v1"
        ? await resolveWorkflowLaunch(request)
        : request.schema === "pi-workflows.resource-manager-initialization-request.v1"
          ? await resolveResourceManagerInitialization(request)
          : await resolveSettingsChange(request);
    const encoded = `${canonicalJson(result)}\n`;
    if (Buffer.byteLength(encoded) > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new Error("Workflow resolver result exceeds 1 MiB");
    }
    process.stdout.write(encoded);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
