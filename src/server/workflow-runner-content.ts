import { createHash } from "node:crypto";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import {
  WORKFLOW_RUNNER_CONTENT_CHUNK_BYTES,
  WORKFLOW_RUNNER_CONTENT_CHUNK_SCHEMA,
  WORKFLOW_RUNNER_CONTENT_REFERENCE_SCHEMA,
  encodeRunnerLine,
  type WorkflowRunnerContentChunk,
  type WorkflowRunnerContentReference,
  type WorkflowRunnerResponse,
} from "./workflow-runner-protocol.js";

const CONTENT_MEDIA_TYPE = "application/json" as const;

export function boundRunnerResponse(
  state: StateDatabase,
  allowedDigests: Set<string>,
  response: WorkflowRunnerResponse,
): WorkflowRunnerResponse {
  try {
    encodeRunnerLine(response);
    return response;
  } catch {
    if (response.result === undefined) return responseTooLarge(response.messageId);
    try {
      const content = Buffer.from(canonicalJson(response.result), "utf8");
      const sha256 = state.putBlob(content, CONTENT_MEDIA_TYPE).toString("hex");
      allowedDigests.add(sha256);
      const referenced: WorkflowRunnerResponse = {
        ...response,
        result: {
          schema: WORKFLOW_RUNNER_CONTENT_REFERENCE_SCHEMA,
          sha256,
          mediaType: CONTENT_MEDIA_TYPE,
          bytes: content.byteLength,
        },
      };
      encodeRunnerLine(referenced);
      return referenced;
    } catch {
      return responseTooLarge(response.messageId);
    }
  }
}

export function readRunnerContentChunk(
  state: StateDatabase,
  allowedDigests: ReadonlySet<string>,
  sha256: string,
  offset: number,
): WorkflowRunnerContentChunk {
  if (!/^[0-9a-f]{64}$/u.test(sha256) || !allowedDigests.has(sha256)) {
    throw new Error("Workflow runner content is unavailable");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Workflow runner content offset is invalid");
  }
  const stored = state.readBlob(Buffer.from(sha256, "hex"));
  if (stored === undefined || stored.mediaType !== CONTENT_MEDIA_TYPE) {
    throw new Error("Workflow runner content is unavailable");
  }
  if (offset > stored.byteLength) throw new Error("Workflow runner content offset is invalid");
  const nextOffset = Math.min(offset + WORKFLOW_RUNNER_CONTENT_CHUNK_BYTES, stored.byteLength);
  return {
    schema: WORKFLOW_RUNNER_CONTENT_CHUNK_SCHEMA,
    sha256,
    mediaType: CONTENT_MEDIA_TYPE,
    bytes: stored.byteLength,
    offset,
    nextOffset,
    complete: nextOffset === stored.byteLength,
    data: stored.content.subarray(offset, nextOffset).toString("base64url"),
  };
}

export async function materializeRunnerContent(
  reference: WorkflowRunnerContentReference,
  readChunk: (offset: number) => Promise<WorkflowRunnerContentChunk>,
): Promise<JsonValue> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await readChunk(offset);
    const bytes = Buffer.from(chunk.data, "base64url");
    if (
      chunk.sha256 !== reference.sha256 ||
      chunk.mediaType !== reference.mediaType ||
      chunk.bytes !== reference.bytes ||
      chunk.offset !== offset ||
      chunk.nextOffset !== offset + bytes.byteLength ||
      chunk.nextOffset > reference.bytes ||
      chunk.complete !== (chunk.nextOffset === reference.bytes)
    ) {
      throw new Error("Workflow runner content chunk is invalid");
    }
    parts.push(bytes);
    offset = chunk.nextOffset;
    if (chunk.complete) break;
    if (bytes.byteLength === 0) throw new Error("Workflow runner content read made no progress");
  }
  const content = Buffer.concat(parts);
  if (
    content.byteLength !== reference.bytes ||
    createHash("sha256").update(content).digest("hex") !== reference.sha256
  ) {
    throw new Error("Workflow runner content does not match its reference");
  }
  return parseJson(content.toString("utf8"));
}

function responseTooLarge(messageId: string): WorkflowRunnerResponse {
  return {
    schema: "pi-workflows.worker-response.v1",
    messageId,
    outcome: "rejected",
    error: "Workflow runner response could not be transferred within the protocol limit",
  };
}
