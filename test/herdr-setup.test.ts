import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERDR_PLUGIN_ID } from "../src/herdr/constants.js";
import { setupHerdrPlugin } from "../src/herdr/setup.js";
import { makeTempDir } from "./helpers.js";

function reply(
  stdout = "",
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

describe("setupHerdrPlugin", () => {
  it("links the current package root when the plugin is absent", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);
    const calls: { command: string; args: readonly string[] }[] = [];
    const result = setupHerdrPlugin(root, (command, args) => {
      calls.push({ command, args });
      return args.includes("list") ? reply(JSON.stringify({ result: { plugins: [] } })) : reply();
    });

    expect(result).toEqual({
      changed: true,
      message: `Linked Herdr plugin ${HERDR_PLUGIN_ID} from ${root}.`,
    });
    expect(calls).toEqual([
      {
        command: "herdr",
        args: ["plugin", "list", "--plugin", HERDR_PLUGIN_ID, "--json"],
      },
      { command: "herdr", args: ["plugin", "link", root] },
    ]);
  });

  it("is idempotent for the same linked package root", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);
    const result = setupHerdrPlugin(root, () =>
      reply(
        JSON.stringify({
          result: {
            plugins: [{ plugin_id: HERDR_PLUGIN_ID, plugin_root: root, enabled: true }],
          },
        }),
      ),
    );

    expect(result.changed).toBe(false);
    expect(result.message).toContain("already linked");
  });

  it("enables a disabled plugin from the same package root", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);
    const calls: { command: string; args: readonly string[] }[] = [];
    const result = setupHerdrPlugin(root, (command, args) => {
      calls.push({ command, args });
      return args.includes("list")
        ? reply(
            JSON.stringify({
              result: {
                plugins: [{ plugin_id: HERDR_PLUGIN_ID, plugin_root: root, enabled: false }],
              },
            }),
          )
        : reply();
    });

    expect(result).toEqual({
      changed: true,
      message: `Enabled Herdr plugin ${HERDR_PLUGIN_ID}.`,
    });
    expect(calls.at(-1)).toEqual({
      command: "herdr",
      args: ["plugin", "enable", HERDR_PLUGIN_ID],
    });
  });

  it("refuses to replace a plugin registered from another root", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);

    expect(() =>
      setupHerdrPlugin(root, () =>
        reply(
          JSON.stringify({
            result: {
              plugins: [
                {
                  plugin_id: HERDR_PLUGIN_ID,
                  plugin_root: "/other/pi-workflows",
                  enabled: true,
                },
              ],
            },
          }),
        ),
      ),
    ).toThrow("Unlink it before linking");
  });

  it("fails before calling Herdr when the package has no manifest", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    expect(() => setupHerdrPlugin(root, () => reply())).toThrow("manifest not found");
  });
});
