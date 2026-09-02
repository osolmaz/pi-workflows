import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeTempRoot, parseArgs, withTemporaryRoot } from "../scripts/live-e2e.mjs";

describe("installed live E2E script", () => {
  it("keeps provider and model as separate exact values", () => {
    expect(parseArgs(["--provider", "openai-codex", "--model", "gpt-5.6-luna"])).toMatchObject({
      model: "gpt-5.6-luna",
      provider: "openai-codex",
      runtimeOnly: false,
    });
    expect(parseArgs([])).toMatchObject({ runtimeOnly: true });
    expect(() => parseArgs(["--provider", "openai"])).toThrow(
      "requires both --provider and --model",
    );
  });

  it("refuses cleanup outside one direct guarded temporary root", () => {
    expect(() => assertSafeTempRoot("/", "/tmp")).toThrow("Refusing unsafe");
    expect(() => assertSafeTempRoot(os.homedir(), "/tmp")).toThrow("Refusing unsafe");
    expect(() => assertSafeTempRoot("/tmp/parent/pi-workflows-live-e2e-child", "/tmp")).toThrow(
      "Refusing unsafe",
    );
    expect(assertSafeTempRoot("/tmp/pi-workflows-live-e2e-example", "/tmp")).toBe(
      "/tmp/pi-workflows-live-e2e-example",
    );
  });

  it("cleans the guarded root when the operation fails", async () => {
    let root = "";
    await expect(
      withTemporaryRoot(async (temporaryRoot) => {
        root = temporaryRoot;
        await fs.writeFile(path.join(temporaryRoot, "proof.txt"), "temporary\n");
        throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");
    await expect(fs.access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
