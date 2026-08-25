import { canonicalJson, type JsonValue } from "../state/json.js";
import type { ActorType, MutationActor } from "../state/mutation.js";
import {
  MAX_WORKFLOW_SETTINGS_BYTES,
  applyJsonPatchOperation,
  cloneJson,
  jsonPointerTarget,
  parseJsonPointer,
  validateJsonPatch,
  type JsonPatch,
  type JsonPatchOperation,
} from "./json-patch.js";
import type { ComputeNodeDefinition, MaybePromise, WorkflowValueParser } from "./types.js";

export type WorkflowSettingsPermission = "read" | "add" | "remove" | "replace";

export type WorkflowSettingsPathPermissions = Partial<
  Record<WorkflowSettingsPermission, readonly ActorType[]>
>;

export type WorkflowSettingsPathRule = {
  path: string;
  permissions: WorkflowSettingsPathPermissions;
};

export type WorkflowSettingsChangeContext<TSettings> = {
  before: TSettings;
  after: TSettings;
  actor: MutationActor;
  source: string;
  patch: JsonPatch;
};

export type WorkflowSettingsDefinition<TSettings = JsonValue, TInput = unknown> = {
  initial: TSettings | ((input: TInput) => MaybePromise<TSettings>);
  parse: WorkflowValueParser<TSettings>;
  paths: readonly WorkflowSettingsPathRule[];
  description?: string;
  validateChange?: (context: WorkflowSettingsChangeContext<TSettings>) => MaybePromise<void>;
};

export type WorkflowSettingsOptions<TSettings, TInput = unknown> = {
  initial: TSettings | ((input: TInput) => MaybePromise<TSettings>);
  parse: WorkflowValueParser<TSettings>;
  paths: readonly WorkflowSettingsPathRule[];
  description?: string;
  validateChange?: (context: WorkflowSettingsChangeContext<TSettings>) => MaybePromise<void>;
};

export type AppliedWorkflowSettings<TSettings> = {
  patch: JsonPatch;
  settings: TSettings;
  json: JsonValue;
};

export function workflowSettings<TSettings, TInput = unknown>(
  options: WorkflowSettingsOptions<TSettings, TInput>,
): WorkflowSettingsDefinition<TSettings, TInput> {
  if (typeof options.parse !== "function") {
    throw new Error("Invalid workflow settings: parse must be a function");
  }
  if (!Array.isArray(options.paths)) {
    throw new Error("Invalid workflow settings: paths must be an array");
  }
  validatePathRules(options.paths);
  if (options.description !== undefined && options.description.trim().length === 0) {
    throw new Error("Invalid workflow settings: description must not be empty");
  }
  if (options.validateChange !== undefined && typeof options.validateChange !== "function") {
    throw new Error("Invalid workflow settings: validateChange must be a function");
  }
  return Object.freeze({
    ...options,
    paths: Object.freeze(options.paths.map((rule) => freezeRule(rule))),
  });
}

export function allowSettingsPath(
  path: string,
  permissions: WorkflowSettingsPathPermissions,
): WorkflowSettingsPathRule {
  parseJsonPointer(path);
  if (Object.keys(permissions).length === 0) {
    throw new Error(`Workflow settings path ${JSON.stringify(path)} grants no permissions`);
  }
  for (const [permission, actors] of Object.entries(permissions)) {
    if (!isSettingsPermission(permission)) {
      throw new Error(`Unknown workflow settings permission: ${permission}`);
    }
    if (!Array.isArray(actors) || actors.length === 0) {
      throw new Error(
        `Workflow settings permission ${permission} at ${JSON.stringify(path)} requires actors`,
      );
    }
    for (const actor of actors) assertActorType(actor);
  }
  return { path, permissions };
}

export function settingsRoute(
  definition: Omit<ComputeNodeDefinition, "nodeType" | "settingsRoute">,
): ComputeNodeDefinition {
  if (typeof definition.run !== "function") {
    throw new Error("Invalid settings route: run must be a function");
  }
  return { nodeType: "compute", settingsRoute: true, ...definition };
}

export async function resolveInitialWorkflowSettings<TSettings, TInput>(
  definition: WorkflowSettingsDefinition<TSettings, TInput>,
  input: TInput,
): Promise<AppliedWorkflowSettings<TSettings>> {
  const raw =
    typeof definition.initial === "function"
      ? await (definition.initial as (value: TInput) => MaybePromise<TSettings>)(input)
      : definition.initial;
  const parsed = await definition.parse(raw);
  const json = cloneJson(parsed as JsonValue);
  assertSettingsSize(json);
  return { patch: [], settings: parsed, json };
}

export async function applyWorkflowSettingsPatch<TSettings>(
  definition: WorkflowSettingsDefinition<TSettings>,
  before: JsonValue,
  patchValue: unknown,
  actor: MutationActor,
  source: string,
): Promise<AppliedWorkflowSettings<TSettings>> {
  const patch = validateJsonPatch(patchValue);
  let current = cloneJson(before);
  for (const operation of patch) {
    authorizeOperation(definition.paths, current, operation, actor.type);
    current = applyJsonPatchOperation(current, operation);
  }
  assertSettingsSize(current);
  const parsed = await definition.parse(cloneJson(current));
  const normalized = cloneJson(parsed as JsonValue);
  assertSettingsSize(normalized);
  if (canonicalJson(normalized) !== canonicalJson(current)) {
    throw new Error("Workflow settings parser must validate without changing the patched value");
  }
  await definition.validateChange?.({
    before: cloneJson(before) as unknown as TSettings,
    after: parsed,
    actor,
    source,
    patch,
  });
  return { patch, settings: parsed, json: normalized };
}

export function settingsRuleForPath(
  rules: readonly WorkflowSettingsPathRule[],
  pointer: string,
): WorkflowSettingsPathRule | undefined {
  const path = parseJsonPointer(pointer);
  let match: WorkflowSettingsPathRule | undefined;
  let matchLength = -1;
  for (const rule of rules) {
    const prefix = parseJsonPointer(rule.path);
    if (prefix.length >= matchLength && prefix.every((segment, index) => path[index] === segment)) {
      if (prefix.length > matchLength) {
        match = rule;
        matchLength = prefix.length;
      }
    }
  }
  return match;
}

function authorizeOperation(
  rules: readonly WorkflowSettingsPathRule[],
  document: JsonValue,
  operation: JsonPatchOperation,
  actor: ActorType,
): void {
  switch (operation.op) {
    case "test":
      requirePermission(rules, operation.path, "read", actor);
      return;
    case "add":
      requirePermission(
        rules,
        operation.path,
        destinationPermission(document, operation.path),
        actor,
      );
      return;
    case "remove":
      requirePermission(rules, operation.path, "remove", actor);
      return;
    case "replace":
      requirePermission(rules, operation.path, "replace", actor);
      return;
    case "copy":
      requirePermission(rules, operation.from, "read", actor);
      requirePermission(
        rules,
        operation.path,
        destinationPermission(document, operation.path),
        actor,
      );
      return;
    case "move":
      requirePermission(rules, operation.from, "read", actor);
      requirePermission(rules, operation.from, "remove", actor);
      requirePermission(
        rules,
        operation.path,
        destinationPermission(document, operation.path),
        actor,
      );
      return;
  }
}

function destinationPermission(document: JsonValue, pointer: string): "add" | "replace" {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) return "replace";
  const parentPointer =
    segments.length === 1 ? "" : `/${segments.slice(0, -1).map(encodeSegment).join("/")}`;
  const parent = jsonPointerTarget(document, parentPointer);
  if (!parent.exists) return "add";
  if (Array.isArray(parent.value)) return "add";
  return jsonPointerTarget(document, pointer).exists ? "replace" : "add";
}

function requirePermission(
  rules: readonly WorkflowSettingsPathRule[],
  pointer: string,
  permission: WorkflowSettingsPermission,
  actor: ActorType,
): void {
  const rule = settingsRuleForPath(rules, pointer);
  if (rule?.permissions[permission]?.includes(actor) !== true) {
    throw new Error(
      `Workflow settings ${permission} is not allowed at ${JSON.stringify(pointer)} for actor ${actor}`,
    );
  }
}

function validatePathRules(rules: readonly WorkflowSettingsPathRule[]): void {
  const byPath = new Map<string, WorkflowSettingsPathRule>();
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error("Invalid workflow settings: each path rule must be an object");
    }
    parseJsonPointer(rule.path);
    const normalized = freezeRule(rule);
    const prior = byPath.get(rule.path);
    if (
      prior !== undefined &&
      canonicalJson(prior.permissions) !== canonicalJson(normalized.permissions)
    ) {
      throw new Error(`Conflicting workflow settings rules for ${JSON.stringify(rule.path)}`);
    }
    byPath.set(rule.path, normalized);
  }
}

function freezeRule(rule: WorkflowSettingsPathRule): WorkflowSettingsPathRule {
  const permissions: WorkflowSettingsPathPermissions = {};
  for (const [permission, actors] of Object.entries(rule.permissions)) {
    if (!isSettingsPermission(permission) || !Array.isArray(actors)) continue;
    permissions[permission] = Object.freeze([...new Set(actors)]);
  }
  return Object.freeze({ path: rule.path, permissions: Object.freeze(permissions) });
}

function assertSettingsSize(value: JsonValue): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_WORKFLOW_SETTINGS_BYTES) {
    throw new Error(`Workflow settings cannot exceed ${MAX_WORKFLOW_SETTINGS_BYTES} bytes`);
  }
}

function assertActorType(value: unknown): asserts value is ActorType {
  if (
    value !== "session" &&
    value !== "host" &&
    value !== "controller" &&
    value !== "channel" &&
    value !== "human" &&
    value !== "policy" &&
    value !== "control" &&
    value !== "system"
  ) {
    throw new Error(`Unknown workflow settings actor: ${JSON.stringify(value)}`);
  }
}

function isSettingsPermission(value: string): value is WorkflowSettingsPermission {
  return value === "read" || value === "add" || value === "remove" || value === "replace";
}

function encodeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
