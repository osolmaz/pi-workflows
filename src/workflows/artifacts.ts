import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef, ArtifactValue } from "./types.js";

/**
 * Value externalization for run bundles (see docs/run-bundles.md): string
 * leaves larger than the threshold are written once, content-addressed, under
 * `artifacts/` and replaced by `{ "$artifact": ref }`. Because artifacts are
 * immutable and deduplicated by hash, the same output appearing in `outputs`,
 * `results`, `steps`, and the trace costs one file plus small references.
 */

export const ARTIFACT_THRESHOLD_BYTES = 4096;
export const ARTIFACTS_DIR = "artifacts";

const ARTIFACT_KEY = "$artifact";
const ESCAPED_KEY = "$escaped";

export function isArtifactValue(value: unknown): value is ArtifactValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    ARTIFACT_KEY in value
  );
}

function isEscapedValue(value: unknown): value is { $escaped: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    ESCAPED_KEY in value
  );
}

/** True for a single-key object that would be misread as a sentinel. */
function needsEscape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === ARTIFACT_KEY || keys[0] === ESCAPED_KEY);
}

/**
 * Writes externalized string leaves for one run bundle. Instances serialize
 * their writes and deduplicate by content hash, so encoding the same large
 * string in several value positions touches the filesystem once.
 */
export class ArtifactWriter {
  private readonly runDir: string;
  private readonly written = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private dirCreated = false;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  /** True once any artifact exists for this run. */
  get hasArtifacts(): boolean {
    return this.written.size > 0;
  }

  async externalize(text: string): Promise<ArtifactValue> {
    const bytes = Buffer.from(text, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const relativePath = `${ARTIFACTS_DIR}/sha256-${sha256}.txt`;
    const task = this.chain.then(async () => {
      if (this.written.has(sha256)) {
        return;
      }
      if (!this.dirCreated) {
        await fs.mkdir(path.join(this.runDir, ARTIFACTS_DIR), { recursive: true, mode: 0o700 });
        this.dirCreated = true;
      }
      const filePath = path.join(this.runDir, relativePath);
      // Content-addressed files are immutable; an existing file is complete
      // unless a previous crash left a partial write, which the temp-rename
      // pattern prevents.
      const tempPath = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, bytes, { mode: 0o600 });
      await fs.rename(tempPath, filePath);
      this.written.add(sha256);
    });
    this.chain = task.catch(() => undefined);
    await task;
    return {
      $artifact: {
        path: relativePath,
        mediaType: "text/plain",
        bytes: bytes.byteLength,
        sha256,
      },
    };
  }
}

/**
 * Encode a persisted value: externalize large string leaves and escape
 * single-key `$artifact`/`$escaped` objects so the sentinel stays
 * unambiguous. Returns the original value when nothing changed.
 */
export async function encodeValue(
  value: unknown,
  writer: ArtifactWriter,
  thresholdBytes: number = ARTIFACT_THRESHOLD_BYTES,
): Promise<unknown> {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= thresholdBytes) {
      return value;
    }
    return await writer.externalize(value);
  }
  if (Array.isArray(value)) {
    const encoded = await Promise.all(
      value.map((item) => encodeValue(item, writer, thresholdBytes)),
    );
    return encoded.some((item, index) => item !== value[index]) ? encoded : value;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = await Promise.all(
      Object.entries(record).map(
        async ([key, item]) => [key, await encodeValue(item, writer, thresholdBytes)] as const,
      ),
    );
    const changed = entries.some(([key, item]) => item !== record[key]);
    const encoded = changed ? Object.fromEntries(entries) : record;
    return needsEscape(record) ? { [ESCAPED_KEY]: encoded } : encoded;
  }
  return value;
}

/**
 * Walk a persisted value, replacing every `$artifact` sentinel via `resolve`
 * and unwrapping `$escaped` objects. `resolve` may return the artifact
 * contents or a placeholder; it receives the reference untouched.
 */
export function decodeValueWith(value: unknown, resolve: (ref: ArtifactRef) => unknown): unknown {
  if (isArtifactValue(value)) {
    return resolve(value.$artifact);
  }
  if (isEscapedValue(value)) {
    // The unwrapped object is user data: process its children but do not
    // re-test the object itself as a sentinel.
    return decodeChildren(value.$escaped, resolve);
  }
  if (Array.isArray(value)) {
    return value.map((item) => decodeValueWith(item, resolve));
  }
  if (typeof value === "object" && value !== null) {
    return decodeChildren(value as Record<string, unknown>, resolve);
  }
  return value;
}

function decodeChildren(
  record: Record<string, unknown>,
  resolve: (ref: ArtifactRef) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, decodeValueWith(item, resolve)]),
  );
}

/** Resolve every artifact reference in `value` by reading the bundle files. */
export async function resolveArtifacts(value: unknown, runDir: string): Promise<unknown> {
  const refs: ArtifactRef[] = [];
  decodeValueWith(value, (ref) => {
    refs.push(ref);
    return null;
  });
  const contents = new Map<string, string>();
  for (const ref of refs) {
    if (contents.has(ref.path)) {
      continue;
    }
    const resolved = path.resolve(runDir, ref.path);
    // A reference must never escape the bundle directory.
    if (!resolved.startsWith(path.resolve(runDir) + path.sep)) {
      throw new Error(`Artifact path escapes the bundle: ${ref.path}`);
    }
    contents.set(ref.path, await fs.readFile(resolved, "utf8"));
  }
  return decodeValueWith(value, (ref) => contents.get(ref.path) ?? null);
}
