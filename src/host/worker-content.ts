import { createHash } from "node:crypto";
import type { StateDatabase } from "../state/database.js";
import { canonicalJson, parseJson, type JsonValue } from "../state/json.js";
import {
  WORKER_CONTENT_CHUNK_BYTES,
  WORKER_CONTENT_CHUNK_SCHEMA,
  WORKER_CONTENT_REFERENCE_SCHEMA,
  encodeWorkerLine,
  type WorkerContentChunk,
  type WorkerContentReference,
  type WorkerResponse,
} from "./worker-protocol.js";

const CONTENT_MEDIA_TYPE = "application/json" as const;

export function boundWorkerResponse(
  state: StateDatabase,
  allowedDigests: Set<string>,
  response: WorkerResponse,
): WorkerResponse {
  try {
    encodeWorkerLine(response);
    return response;
  } catch {
    if (response.result === undefined) return responseTooLarge(response.messageId);
    try {
      const content = Buffer.from(canonicalJson(response.result), "utf8");
      const sha256 = state.putBlob(content, CONTENT_MEDIA_TYPE).toString("hex");
      allowedDigests.add(sha256);
      const referenced: WorkerResponse = {
        ...response,
        result: {
          schema: WORKER_CONTENT_REFERENCE_SCHEMA,
          sha256,
          mediaType: CONTENT_MEDIA_TYPE,
          bytes: content.byteLength,
        },
      };
      encodeWorkerLine(referenced);
      return referenced;
    } catch {
      return responseTooLarge(response.messageId);
    }
  }
}

export function readWorkerContentChunk(
  state: StateDatabase,
  allowedDigests: ReadonlySet<string>,
  sha256: string,
  offset: number,
): WorkerContentChunk {
  if (!/^[0-9a-f]{64}$/u.test(sha256) || !allowedDigests.has(sha256)) {
    throw new Error("Workflow worker content is unavailable");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Workflow worker content offset is invalid");
  }
  const stored = state.readBlob(Buffer.from(sha256, "hex"));
  if (stored === undefined || stored.mediaType !== CONTENT_MEDIA_TYPE) {
    throw new Error("Workflow worker content is unavailable");
  }
  if (offset > stored.byteLength) throw new Error("Workflow worker content offset is invalid");
  const nextOffset = Math.min(offset + WORKER_CONTENT_CHUNK_BYTES, stored.byteLength);
  return {
    schema: WORKER_CONTENT_CHUNK_SCHEMA,
    sha256,
    mediaType: CONTENT_MEDIA_TYPE,
    bytes: stored.byteLength,
    offset,
    nextOffset,
    complete: nextOffset === stored.byteLength,
    data: stored.content.subarray(offset, nextOffset).toString("base64url"),
  };
}

export async function materializeWorkerContent(
  reference: WorkerContentReference,
  readChunk: (offset: number) => Promise<WorkerContentChunk>,
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
      throw new Error("Workflow worker content chunk is invalid");
    }
    parts.push(bytes);
    offset = chunk.nextOffset;
    if (chunk.complete) break;
    if (bytes.byteLength === 0) throw new Error("Workflow worker content read made no progress");
  }
  const content = Buffer.concat(parts);
  if (
    content.byteLength !== reference.bytes ||
    createHash("sha256").update(content).digest("hex") !== reference.sha256
  ) {
    throw new Error("Workflow worker content does not match its reference");
  }
  return parseJson(content.toString("utf8"));
}

function responseTooLarge(messageId: string): WorkerResponse {
  return {
    schema: "pi-workflows.worker-response.v1",
    messageId,
    outcome: "rejected",
    error: "Workflow worker response could not be transferred within the protocol limit",
  };
}
