import { canonicalJson, type JsonValue } from "../state/json.js";

export const MAX_JSON_PATCH_OPERATIONS = 256;
export const MAX_JSON_PATCH_BYTES = 64 * 1024;
export const MAX_JSON_POINTER_BYTES = 1024;
export const MAX_WORKFLOW_SETTINGS_BYTES = 256 * 1024;

export type JsonPatchAddOperation = {
  op: "add";
  path: string;
  value: JsonValue;
};

export type JsonPatchRemoveOperation = {
  op: "remove";
  path: string;
};

export type JsonPatchReplaceOperation = {
  op: "replace";
  path: string;
  value: JsonValue;
};

export type JsonPatchMoveOperation = {
  op: "move";
  path: string;
  from: string;
};

export type JsonPatchCopyOperation = {
  op: "copy";
  path: string;
  from: string;
};

export type JsonPatchTestOperation = {
  op: "test";
  path: string;
  value: JsonValue;
};

export type JsonPatchOperation =
  | JsonPatchAddOperation
  | JsonPatchRemoveOperation
  | JsonPatchReplaceOperation
  | JsonPatchMoveOperation
  | JsonPatchCopyOperation
  | JsonPatchTestOperation;

export type JsonPatch = JsonPatchOperation[];

export type JsonPointerTarget = {
  exists: boolean;
  value?: JsonValue;
};

export function validateJsonPatch(value: unknown): JsonPatch {
  if (!Array.isArray(value)) {
    throw new Error("JSON Patch must be an array");
  }
  if (value.length > MAX_JSON_PATCH_OPERATIONS) {
    throw new Error(`JSON Patch cannot contain more than ${MAX_JSON_PATCH_OPERATIONS} operations`);
  }
  const patch = value.map((operation, index) => validateOperation(operation, index));
  const bytes = Buffer.byteLength(canonicalJson(patch), "utf8");
  if (bytes > MAX_JSON_PATCH_BYTES) {
    throw new Error(`JSON Patch cannot exceed ${MAX_JSON_PATCH_BYTES} bytes`);
  }
  return patch;
}

export function parseJsonPointer(pointer: string): string[] {
  if (typeof pointer !== "string") {
    throw new Error("JSON Pointer must be a string");
  }
  if (Buffer.byteLength(pointer, "utf8") > MAX_JSON_POINTER_BYTES) {
    throw new Error(`JSON Pointer cannot exceed ${MAX_JSON_POINTER_BYTES} bytes`);
  }
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: ${JSON.stringify(pointer)}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => {
      if (/~(?![01])/u.test(segment)) {
        throw new Error(`Invalid JSON Pointer escape in ${JSON.stringify(pointer)}`);
      }
      return segment.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

export function encodeJsonPointer(segments: readonly string[]): string {
  if (segments.length === 0) return "";
  return `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function jsonPointerTarget(document: JsonValue, pointer: string): JsonPointerTarget {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) return { exists: true, value: document };
  let current: JsonValue = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = parseArrayIndex(segment, current.length, false);
      if (index >= current.length) return { exists: false };
      current = current[index] as JsonValue;
      continue;
    }
    if (isJsonObject(current)) {
      if (!Object.hasOwn(current, segment)) return { exists: false };
      current = current[segment] as JsonValue;
      continue;
    }
    return { exists: false };
  }
  return { exists: true, value: current };
}

export function applyJsonPatch(document: JsonValue, value: unknown): JsonValue {
  const patch = validateJsonPatch(value);
  let current = cloneJson(document);
  for (const operation of patch) {
    current = applyJsonPatchOperation(current, operation);
  }
  const bytes = Buffer.byteLength(canonicalJson(current), "utf8");
  if (bytes > MAX_WORKFLOW_SETTINGS_BYTES) {
    throw new Error(`JSON Patch result cannot exceed ${MAX_WORKFLOW_SETTINGS_BYTES} bytes`);
  }
  return current;
}

export function applyJsonPatchOperation(
  document: JsonValue,
  operation: JsonPatchOperation,
): JsonValue {
  const path = parseJsonPointer(operation.path);
  switch (operation.op) {
    case "add":
      return addValue(document, path, cloneJson(operation.value));
    case "remove":
      return removeValue(document, path).document;
    case "replace":
      if (path.length === 0) return cloneJson(operation.value);
      requireTarget(document, path, operation.path);
      return addValue(document, path, cloneJson(operation.value), true);
    case "copy": {
      const source = requireTarget(document, parseJsonPointer(operation.from), operation.from);
      return addValue(document, path, cloneJson(source.value));
    }
    case "move": {
      const from = parseJsonPointer(operation.from);
      if (sameSegments(from, path)) return document;
      if (from.length === 0) {
        throw new Error("JSON Patch move cannot move the document root into a child path");
      }
      if (isPrefix(from, path)) {
        throw new Error("JSON Patch move destination cannot be inside its source");
      }
      const removed = removeValue(document, from);
      return addValue(removed.document, path, removed.value);
    }
    case "test": {
      const target = requireTarget(document, path, operation.path);
      if (canonicalJson(target.value) !== canonicalJson(operation.value)) {
        throw new Error(`JSON Patch test failed at ${JSON.stringify(operation.path)}`);
      }
      return document;
    }
  }
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return (Object.is(value, -0) ? 0 : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (!isJsonObject(value)) {
    throw new Error("Workflow settings must contain only JSON values");
  }
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    defineJsonProperty(output, key, cloneJson(value[key] as JsonValue));
  }
  return output as T;
}

function validateOperation(value: unknown, index: number): JsonPatchOperation {
  if (!isRecord(value) || typeof value.op !== "string" || typeof value.path !== "string") {
    throw new Error(`JSON Patch operation ${index + 1} must contain string op and path fields`);
  }
  parseJsonPointer(value.path);
  switch (value.op) {
    case "add":
    case "replace":
    case "test":
      assertExactFields(value, ["op", "path", "value"], index);
      if (!Object.hasOwn(value, "value")) {
        throw new Error(`JSON Patch ${value.op} operation ${index + 1} requires value`);
      }
      return { op: value.op, path: value.path, value: cloneJsonValue(value.value, index) };
    case "remove":
      assertExactFields(value, ["op", "path"], index);
      return { op: "remove", path: value.path };
    case "copy":
    case "move":
      assertExactFields(value, ["op", "path", "from"], index);
      if (typeof value.from !== "string") {
        throw new Error(`JSON Patch ${value.op} operation ${index + 1} requires string from`);
      }
      parseJsonPointer(value.from);
      return { op: value.op, path: value.path, from: value.from };
    default:
      throw new Error(`Unknown JSON Patch operation ${JSON.stringify(value.op)}`);
  }
}

function cloneJsonValue(value: unknown, index: number): JsonValue {
  try {
    return cloneJson(value as JsonValue);
  } catch (error) {
    throw new Error(`JSON Patch operation ${index + 1} value is not valid JSON`, { cause: error });
  }
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  index: number,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(
      `JSON Patch operation ${index + 1} has unknown field ${JSON.stringify(unknown)}`,
    );
  }
}

function addValue(
  document: JsonValue,
  path: readonly string[],
  value: JsonValue,
  replaceOnly = false,
): JsonValue {
  if (path.length === 0) return value;
  const { parent, key } = resolveParent(document, path);
  if (Array.isArray(parent)) {
    if (replaceOnly) {
      const index = parseArrayIndex(key, parent.length, false);
      if (index >= parent.length) throw missingPath(encodeJsonPointer(path));
      parent[index] = value;
      return document;
    }
    const index = parseArrayIndex(key, parent.length, true);
    if (index > parent.length) throw missingPath(encodeJsonPointer(path));
    parent.splice(index, 0, value);
    return document;
  }
  if (!isJsonObject(parent)) throw missingPath(encodeJsonPointer(path));
  if (replaceOnly && !Object.hasOwn(parent, key)) throw missingPath(encodeJsonPointer(path));
  defineJsonProperty(parent, key, value);
  return document;
}

function removeValue(
  document: JsonValue,
  path: readonly string[],
): { document: JsonValue; value: JsonValue } {
  if (path.length === 0) {
    throw new Error("JSON Patch remove cannot remove the document root");
  }
  const { parent, key } = resolveParent(document, path);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, false);
    if (index >= parent.length) throw missingPath(encodeJsonPointer(path));
    const [value] = parent.splice(index, 1);
    return { document, value: value as JsonValue };
  }
  if (!isJsonObject(parent) || !Object.hasOwn(parent, key)) {
    throw missingPath(encodeJsonPointer(path));
  }
  const value = parent[key] as JsonValue;
  delete parent[key];
  return { document, value };
}

function requireTarget(
  document: JsonValue,
  path: readonly string[],
  pointer: string,
): { value: JsonValue } {
  if (path.length === 0) return { value: document };
  const { parent, key } = resolveParent(document, path);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, false);
    if (index >= parent.length) throw missingPath(pointer);
    return { value: parent[index] as JsonValue };
  }
  if (!isJsonObject(parent) || !Object.hasOwn(parent, key)) throw missingPath(pointer);
  return { value: parent[key] as JsonValue };
}

function resolveParent(
  document: JsonValue,
  path: readonly string[],
): { parent: JsonValue; key: string } {
  let current = document;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = parseArrayIndex(segment, current.length, false);
      if (index >= current.length) throw missingPath(encodeJsonPointer(path));
      current = current[index] as JsonValue;
      continue;
    }
    if (isJsonObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment] as JsonValue;
      continue;
    }
    throw missingPath(encodeJsonPointer(path));
  }
  return { parent: current, key: path.at(-1) as string };
}

function parseArrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (allowEnd && segment === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/u.test(segment)) {
    throw new Error(`Invalid JSON Patch array index: ${JSON.stringify(segment)}`);
  }
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index > length || (!allowEnd && index === length)) {
    return length + 1;
  }
  return index;
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length < value.length && prefix.every((segment, index) => value[index] === segment);
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => right[index] === segment);
}

function missingPath(path: string): Error {
  return new Error(`JSON Patch path does not exist: ${JSON.stringify(path)}`);
}

function defineJsonProperty(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
