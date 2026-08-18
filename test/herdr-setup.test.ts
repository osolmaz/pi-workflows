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

  it("reports Herdr inspection and registration failures", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);

    expect(() =>
      setupHerdrPlugin(root, () => reply("", { error: new Error("missing Herdr") })),
    ).toThrow("Could not run Herdr: missing Herdr");
    expect(() =>
      setupHerdrPlugin(root, () => reply("", { status: 1, stderr: "socket unavailable" })),
    ).toThrow("Could not inspect Herdr plugins: socket unavailable");
    expect(() => setupHerdrPlugin(root, () => reply("not json"))).toThrow("invalid plugin JSON");
    expect(() => setupHerdrPlugin(root, () => reply(JSON.stringify({ result: {} })))).toThrow(
      "invalid plugin list",
    );

    const listEmpty = JSON.stringify({ result: { plugins: [] } });
    let calls = 0;
    expect(() =>
      setupHerdrPlugin(root, () => {
        calls += 1;
        return calls === 1 ? reply(listEmpty) : reply("", { status: 1, stderr: "link refused" });
      }),
    ).toThrow("Could not link the Herdr plugin: link refused");

    calls = 0;
    expect(() =>
      setupHerdrPlugin(root, () => {
        calls += 1;
        return calls === 1
          ? reply(listEmpty)
          : reply("", { error: new Error("link executable failed") });
      }),
    ).toThrow("Could not run Herdr: link executable failed");

    calls = 0;
    expect(() =>
      setupHerdrPlugin(root, () => {
        calls += 1;
        return calls === 1 ? reply(listEmpty) : reply("", { status: 1, stderr: "x".repeat(400) });
      }),
    ).toThrow(/Could not link the Herdr plugin: x+…/u);
  });

  it("reports failures while enabling a linked plugin", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);
    let calls = 0;

    expect(() =>
      setupHerdrPlugin(root, () => {
        calls += 1;
        return calls === 1
          ? reply(
              JSON.stringify({
                result: {
                  plugins: [{ plugin_id: HERDR_PLUGIN_ID, plugin_root: root, enabled: false }],
                },
              }),
            )
          : reply("", { status: 1, stderr: "enable refused" });
      }),
    ).toThrow("Could not enable the Herdr plugin: enable refused");

    calls = 0;
    expect(() =>
      setupHerdrPlugin(root, () => {
        calls += 1;
        return calls === 1
          ? reply(
              JSON.stringify({
                result: {
                  plugins: [{ plugin_id: HERDR_PLUGIN_ID, plugin_root: root, enabled: false }],
                },
              }),
            )
          : reply("", { error: new Error("enable executable failed") });
      }),
    ).toThrow("Could not run Herdr: enable executable failed");
  });

  it("ignores incomplete plugin records and links the complete package", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    await fs.writeFile(path.join(root, "herdr-plugin.toml"), `id = "${HERDR_PLUGIN_ID}"\n`);
    let calls = 0;
    const result = setupHerdrPlugin(root, () => {
      calls += 1;
      return calls === 1
        ? reply(
            JSON.stringify({
              result: {
                plugins: [
                  null,
                  { plugin_id: HERDR_PLUGIN_ID, plugin_root: root },
                  { plugin_id: "other.plugin", plugin_root: root, enabled: true },
                ],
              },
            }),
          )
        : reply();
    });

    expect(result.changed).toBe(true);
  });

  it("fails before calling Herdr when the package has no manifest", async () => {
    const root = await makeTempDir("pi-workflows-herdr-setup");
    expect(() => setupHerdrPlugin(root, () => reply())).toThrow("manifest not found");
  });
});
