import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_THRESHOLD_BYTES,
  ArtifactWriter,
  decodeValueWith,
  encodeValue,
  isArtifactValue,
  resolveArtifacts,
} from "../src/workflows/artifacts.js";
import type { ArtifactRef } from "../src/workflows/types.js";
import { makeTempDir } from "./helpers.js";

const BIG = "y".repeat(ARTIFACT_THRESHOLD_BYTES + 1);

async function makeWriter(): Promise<{ runDir: string; writer: ArtifactWriter }> {
  const runDir = await makeTempDir("pi-workflows-artifacts");
  return { runDir, writer: new ArtifactWriter(runDir) };
}

describe("encodeValue", () => {
  it("keeps small values inline and untouched", async () => {
    const { writer } = await makeWriter();
    const value = { text: "short", n: 5, list: [1, "two"], nested: { ok: true } };
    expect(await encodeValue(value, writer)).toBe(value);
    expect(writer.hasArtifacts).toBe(false);
  });

  it("externalizes large string leaves into content-addressed files", async () => {
    const { runDir, writer } = await makeWriter();
    const encoded = (await encodeValue({ text: BIG }, writer)) as {
      text: { $artifact: ArtifactRef };
    };
    const ref = encoded.text.$artifact;
    const sha256 = createHash("sha256").update(BIG, "utf8").digest("hex");
    expect(ref).toEqual({
      path: `artifacts/sha256-${sha256}.txt`,
      mediaType: "text/plain",
      bytes: BIG.length,
      sha256,
    });
    expect(await fs.readFile(path.join(runDir, ref.path), "utf8")).toBe(BIG);
    expect(isArtifactValue(encoded.text)).toBe(true);
  });

  it("deduplicates identical content", async () => {
    const { runDir, writer } = await makeWriter();
    await encodeValue({ a: BIG, b: BIG, deep: [{ c: BIG }] }, writer);
    expect(await fs.readdir(path.join(runDir, "artifacts"))).toHaveLength(1);
  });

  it("escapes user objects that collide with the sentinel shape", async () => {
    const { runDir, writer } = await makeWriter();
    const collision = { $artifact: "user data" };
    const encoded = await encodeValue({ value: collision }, writer);
    expect(encoded).toEqual({ value: { $escaped: { $artifact: "user data" } } });
    // Decoding restores the original object without misreading the sentinel.
    expect(await resolveArtifacts(encoded, runDir)).toEqual({ value: collision });
  });

  it("uses UTF-8 byte length, not character count, for the threshold", async () => {
    const { writer } = await makeWriter();
    // 3 bytes per character: exceeds the threshold with fewer characters.
    const multibyte = "€".repeat(Math.ceil(ARTIFACT_THRESHOLD_BYTES / 3) + 1);
    const encoded = await encodeValue(multibyte, writer);
    expect(isArtifactValue(encoded)).toBe(true);
  });
});

describe("decodeValueWith / resolveArtifacts", () => {
  it("round-trips values through encode and resolve", async () => {
    const { runDir, writer } = await makeWriter();
    const value = { text: BIG, keep: "small", list: [BIG, 2] };
    const encoded = await encodeValue(value, writer);
    expect(await resolveArtifacts(encoded, runDir)).toEqual(value);
  });

  it("supports placeholder substitution", async () => {
    const { writer } = await makeWriter();
    const encoded = await encodeValue({ text: BIG }, writer);
    const decoded = decodeValueWith(encoded, (ref) => `«${ref.bytes} bytes»`);
    expect(decoded).toEqual({ text: `«${BIG.length} bytes»` });
  });

  it("rejects references that escape the bundle", async () => {
    const runDir = await makeTempDir("pi-workflows-artifacts");
    const hostile = {
      $artifact: { path: "../../etc/passwd", mediaType: "text/plain", bytes: 1, sha256: "0" },
    };
    await expect(resolveArtifacts(hostile, runDir)).rejects.toThrow(/escapes the bundle/);
  });
});
