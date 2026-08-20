import type { SpawnSyncReturns } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERDR_PLUGIN_ID } from "../src/herdr/constants.js";
import { setupHerdrPlugin, syncHerdrPlugin } from "../src/herdr/setup.js";
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

type PluginRecord = {
  plugin_id: string;
  plugin_root: string;
  manifest_path: string;
  version: string;
  enabled: boolean;
  warnings?: string[];
};

async function makePackage(label = "pi-workflows-herdr-sync", version = "0.11.0"): Promise<string> {
  const root = await makeTempDir(label);
  await fs.mkdir(path.join(root, "plugins", "herdr"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@osolmaz/pi-workflows", version }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, "herdr-plugin.toml"),
    [
      `id = "${HERDR_PLUGIN_ID}"`,
      'name = "pi-workflows"',
      `version = "${version}"`,
      'min_herdr_version = "0.7.0"',
      'platforms = ["linux", "macos"]',
      "",
      "[[panes]]",
      'id = "piw"',
      'command = ["node", "plugins/herdr/viewer.mjs"]',
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(root, "plugins", "herdr", "viewer.mjs"), "export {};\n");
  return fs.realpath(root);
}

function record(root: string, enabled = true, overrides: Partial<PluginRecord> = {}): PluginRecord {
  const manifest = JSON.parse(fsSync.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  return {
    plugin_id: HERDR_PLUGIN_ID,
    plugin_root: root,
    manifest_path: path.join(root, "herdr-plugin.toml"),
    version: manifest.version,
    enabled,
    ...overrides,
  };
}

class FakeHerdr {
  plugin: PluginRecord | undefined;
  readonly calls: { command: string; args: readonly string[] }[] = [];
  failAction: string | undefined;
  failLinkRoot: string | undefined;
  malformedList: string | undefined;
  listError: Error | undefined;

  constructor(plugin?: PluginRecord) {
    this.plugin = plugin;
  }

  readonly spawn = (command: string, args: readonly string[]): SpawnSyncReturns<string> => {
    this.calls.push({ command, args });
    if (args[1] === "list") {
      if (this.listError !== undefined) return reply("", { error: this.listError });
      if (this.malformedList !== undefined) return reply(this.malformedList);
      return reply(
        JSON.stringify({ result: { plugins: this.plugin === undefined ? [] : [this.plugin] } }),
      );
    }
    const action = args[1];
    if (action === this.failAction) return reply("", { status: 1, stderr: `${action} refused` });
    if (action === "link") {
      const root = args[2];
      if (root === undefined) return reply("", { status: 2, stderr: "missing root" });
      if (root === this.failLinkRoot) return reply("", { status: 1, stderr: "link refused" });
      this.plugin = record(root, !args.includes("--disabled"));
      return reply();
    }
    if (action === "unlink") {
      this.plugin = undefined;
      return reply();
    }
    if (action === "enable") {
      if (this.plugin !== undefined) this.plugin = { ...this.plugin, enabled: true };
      return reply();
    }
    return reply("", { status: 2, stderr: `unexpected action ${String(action)}` });
  };
}

describe("syncHerdrPlugin", () => {
  it("links an absent plugin and verifies it", async () => {
    const root = await makePackage();
    const herdr = new FakeHerdr();

    const result = syncHerdrPlugin(root, herdr.spawn);

    expect(result).toMatchObject({
      schema: "pi-workflows.herdr-sync.v1",
      status: "linked",
      changed: true,
      pluginId: HERDR_PLUGIN_ID,
      expectedVersion: "0.11.0",
      effectiveVersion: "0.11.0",
      enabled: true,
      runningPiProcessesNeedReload: true,
    });
    expect(herdr.calls.map((call) => call.args[1])).toEqual(["list", "link", "list"]);
  });

  it("leaves an exact healthy registration unchanged", async () => {
    const root = await makePackage();
    const herdr = new FakeHerdr(record(root));

    expect(syncHerdrPlugin(root, herdr.spawn)).toMatchObject({
      status: "unchanged",
      changed: false,
    });
    expect(herdr.calls).toHaveLength(1);
  });

  it("enables and verifies a disabled registration", async () => {
    const root = await makePackage();
    const herdr = new FakeHerdr(record(root, false));

    expect(syncHerdrPlugin(root, herdr.spawn)).toMatchObject({ status: "enabled", changed: true });
    expect(herdr.calls.map((call) => call.args[1])).toEqual(["list", "enable", "list"]);
  });

  it("repairs a registration after the package moves or changes version", async () => {
    const oldRoot = await makePackage("pi-workflows-old", "0.10.0");
    const currentRoot = await makePackage("pi-workflows current path with spaces", "0.11.0");
    const herdr = new FakeHerdr(record(oldRoot));

    expect(syncHerdrPlugin(currentRoot, herdr.spawn)).toMatchObject({
      status: "relinked",
      effectiveVersion: "0.11.0",
    });
    expect(herdr.plugin).toEqual(record(currentRoot));
    expect(herdr.calls.map((call) => call.args[1])).toEqual([
      "list",
      "unlink",
      "list",
      "link",
      "list",
    ]);
    expect(herdr.calls.find((call) => call.args[1] === "link")?.args[2]).toBe(currentRoot);
  });

  it("repairs a link whose old root no longer exists", async () => {
    const oldRoot = await makePackage("pi-workflows-stale", "0.10.0");
    const oldRecord = record(oldRoot);
    await fs.rm(oldRoot, { recursive: true, force: true });
    const currentRoot = await makePackage("pi-workflows-current", "0.11.0");
    const herdr = new FakeHerdr(oldRecord);

    expect(syncHerdrPlugin(currentRoot, herdr.spawn).status).toBe("relinked");
    expect(herdr.plugin).toEqual(record(currentRoot));
  });

  it("adopts a concurrent process that reached the target state", async () => {
    const root = await makePackage();
    const herdr = new FakeHerdr();
    herdr.failAction = "link";
    const original = herdr.spawn;
    let linked = false;
    const spawn = (command: string, args: readonly string[]): SpawnSyncReturns<string> => {
      const response = original(command, args);
      if (args[1] === "link" && !linked) {
        linked = true;
        herdr.plugin = record(root);
      }
      return response;
    };

    expect(syncHerdrPlugin(root, spawn)).toMatchObject({ status: "linked", changed: true });
  });

  it("restores one valid previous registration after replacement fails", async () => {
    const oldRoot = await makePackage("pi-workflows-old", "0.10.0");
    const currentRoot = await makePackage("pi-workflows-current", "0.11.0");
    const herdr = new FakeHerdr(record(oldRoot, false));
    herdr.failLinkRoot = currentRoot;

    expect(() => syncHerdrPlugin(currentRoot, herdr.spawn)).toThrow(
      /previous registration was restored/u,
    );
    expect(herdr.plugin).toEqual(record(oldRoot, false));
    const restore = herdr.calls.filter((call) => call.args[1] === "link").at(-1);
    expect(restore?.args).toEqual(["plugin", "link", oldRoot, "--disabled"]);
  });

  it("does not claim rollback when the previous package is invalid", async () => {
    const oldRoot = await makePackage("pi-workflows-old", "0.10.0");
    const oldRecord = record(oldRoot);
    await fs.rm(oldRoot, { recursive: true, force: true });
    const currentRoot = await makePackage("pi-workflows-current", "0.11.0");
    const herdr = new FakeHerdr(oldRecord);
    herdr.failLinkRoot = currentRoot;

    expect(() => syncHerdrPlugin(currentRoot, herdr.spawn)).toThrow(
      /previous registration could not be restored/u,
    );
    expect(herdr.plugin).toBeUndefined();
  });

  it("returns unavailable only when the Herdr executable is absent", async () => {
    const root = await makePackage();
    const missing = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    const result = syncHerdrPlugin(root, () => reply("", { error: missing }));

    expect(result).toMatchObject({
      status: "unavailable",
      changed: false,
      effectiveVersion: null,
      enabled: null,
    });

    const denied = Object.assign(new Error("spawn herdr EACCES"), { code: "EACCES" });
    expect(() => syncHerdrPlugin(root, () => reply("", { error: denied }))).toThrow(
      "Could not run Herdr: spawn herdr EACCES",
    );
  });

  it("reports link and enable failures when the target state was not reached", async () => {
    const root = await makePackage();
    const linkFailure = new FakeHerdr();
    linkFailure.failAction = "link";
    expect(() => syncHerdrPlugin(root, linkFailure.spawn)).toThrow("command failed: link refused");

    const enableFailure = new FakeHerdr(record(root, false));
    enableFailure.failAction = "enable";
    expect(() => syncHerdrPlugin(root, enableFailure.spawn)).toThrow(
      "command failed: enable refused",
    );
  });

  it("rejects malformed or ambiguous Herdr records", async () => {
    const root = await makePackage();
    const malformed = new FakeHerdr();
    malformed.malformedList = "{";
    expect(() => syncHerdrPlugin(root, malformed.spawn)).toThrow("invalid plugin JSON");

    const invalidShape = new FakeHerdr();
    invalidShape.malformedList = "{}";
    expect(() => syncHerdrPlugin(root, invalidShape.spawn)).toThrow("invalid plugin list");

    const incomplete = new FakeHerdr({
      ...record(root),
      manifest_path: undefined,
    } as unknown as PluginRecord);
    expect(() => syncHerdrPlugin(root, incomplete.spawn)).toThrow("incomplete record");

    expect(() =>
      syncHerdrPlugin(root, () =>
        reply(
          JSON.stringify({
            result: { plugins: [record(root), record(root)] },
          }),
        ),
      ),
    ).toThrow("duplicate records");

    const invalidWarnings = new FakeHerdr({
      ...record(root),
      warnings: 1,
    } as unknown as PluginRecord);
    expect(() => syncHerdrPlugin(root, invalidWarnings.spawn)).toThrow("invalid warnings");
  });

  it("rejects warnings and failed final verification", async () => {
    const root = await makePackage();
    const herdr = new FakeHerdr(record(root, true, { warnings: ["manifest unavailable"] }));
    herdr.failAction = "unlink";

    expect(() => syncHerdrPlugin(root, herdr.spawn)).toThrow(/conflicting registration/u);
  });

  it("bounds command failure output", async () => {
    const root = await makePackage();
    expect(() =>
      syncHerdrPlugin(root, () => reply("", { status: 1, stderr: "x".repeat(400) })),
    ).toThrow(/Could not inspect Herdr plugins: x+…/u);
  });

  it("rejects missing and non-directory package roots", async () => {
    const temp = await makeTempDir("pi-workflows-invalid-root");
    expect(() => syncHerdrPlugin(path.join(temp, "missing"), () => reply())).toThrow(
      "package root is missing",
    );
    const file = path.join(temp, "file");
    await fs.writeFile(file, "not a package\n");
    expect(() => syncHerdrPlugin(file, () => reply())).toThrow("package root is not a directory");
  });

  it("rejects malformed package metadata", async () => {
    const invalidJson = await makePackage("pi-workflows-invalid-json");
    await fs.writeFile(path.join(invalidJson, "package.json"), "{\n");
    expect(() => syncHerdrPlugin(invalidJson, () => reply())).toThrow("not valid JSON");

    const invalidShape = await makePackage("pi-workflows-invalid-package-shape");
    await fs.writeFile(path.join(invalidShape, "package.json"), "[]\n");
    expect(() => syncHerdrPlugin(invalidShape, () => reply())).toThrow(
      "must contain a JSON object",
    );
  });

  it("rejects invalid package identity and missing versions", async () => {
    const wrongName = await makePackage("pi-workflows-wrong-name");
    await fs.writeFile(
      path.join(wrongName, "package.json"),
      `${JSON.stringify({ name: "other", version: "0.11.0" })}\n`,
    );
    expect(() => syncHerdrPlugin(wrongName, () => reply())).toThrow("Unexpected pi-workflows");

    const missingVersion = await makePackage("pi-workflows-missing-version");
    await fs.writeFile(
      path.join(missingVersion, "package.json"),
      `${JSON.stringify({ name: "@osolmaz/pi-workflows" })}\n`,
    );
    expect(() => syncHerdrPlugin(missingVersion, () => reply())).toThrow(
      "package version is missing",
    );
  });

  it("rejects invalid manifest identity and arrays", async () => {
    const wrongId = await makePackage("pi-workflows-wrong-plugin-id");
    const wrongIdPath = path.join(wrongId, "herdr-plugin.toml");
    const wrongIdManifest = await fs.readFile(wrongIdPath, "utf8");
    await fs.writeFile(
      wrongIdPath,
      wrongIdManifest.replace(`id = "${HERDR_PLUGIN_ID}"`, 'id = "other.plugin"'),
    );
    expect(() => syncHerdrPlugin(wrongId, () => reply())).toThrow("Unexpected Herdr plugin ID");

    const badPlatforms = await makePackage("pi-workflows-bad-platforms");
    const badPlatformsPath = path.join(badPlatforms, "herdr-plugin.toml");
    const badPlatformsManifest = await fs.readFile(badPlatformsPath, "utf8");
    await fs.writeFile(
      badPlatformsPath,
      badPlatformsManifest.replace('platforms = ["linux", "macos"]', "platforms = []"),
    );
    expect(() => syncHerdrPlugin(badPlatforms, () => reply())).toThrow(
      "invalid platforms string array",
    );
  });

  it("rejects an unexpected viewer command and a missing viewer", async () => {
    const wrongCommand = await makePackage("pi-workflows-wrong-command");
    const manifestPath = path.join(wrongCommand, "herdr-plugin.toml");
    const manifest = await fs.readFile(manifestPath, "utf8");
    await fs.writeFile(
      manifestPath,
      manifest.replace(
        'command = ["node", "plugins/herdr/viewer.mjs"]',
        'command = ["node", "plugins/herdr/other.mjs"]',
      ),
    );
    expect(() => syncHerdrPlugin(wrongCommand, () => reply())).toThrow(
      "Unexpected Herdr plugin viewer command",
    );

    const missingViewer = await makePackage("pi-workflows-missing-viewer");
    await fs.rm(path.join(missingViewer, "plugins", "herdr", "viewer.mjs"));
    expect(() => syncHerdrPlugin(missingViewer, () => reply())).toThrow(
      "Package file plugins/herdr/viewer.mjs is missing",
    );
  });

  it("validates the bundled package before running Herdr", async () => {
    const root = await makePackage();
    let calls = 0;
    await fs.writeFile(
      path.join(root, "herdr-plugin.toml"),
      [
        `id = "${HERDR_PLUGIN_ID}"`,
        'version = "9.9.9"',
        'min_herdr_version = "0.7.0"',
        'platforms = ["linux", "macos"]',
        'command = ["node", "plugins/herdr/viewer.mjs"]',
      ].join("\n"),
    );

    expect(() =>
      syncHerdrPlugin(root, () => {
        calls += 1;
        return reply();
      }),
    ).toThrow("plugin version does not match");
    expect(calls).toBe(0);
  });

  it("rejects duplicate manifest fields and viewer symlinks", async () => {
    const root = await makePackage();
    const manifestPath = path.join(root, "herdr-plugin.toml");
    const manifest = await fs.readFile(manifestPath, "utf8");
    await fs.writeFile(
      manifestPath,
      manifest.replace(
        `id = "${HERDR_PLUGIN_ID}"`,
        `id = "${HERDR_PLUGIN_ID}"\nid = "${HERDR_PLUGIN_ID}"`,
      ),
    );
    expect(() => syncHerdrPlugin(root, () => reply())).toThrow("must contain one id string");

    const linkedRoot = await makePackage("pi-workflows-viewer-link");
    const viewer = path.join(linkedRoot, "plugins", "herdr", "viewer.mjs");
    await fs.rm(viewer);
    await fs.symlink(path.join(linkedRoot, "package.json"), viewer);
    expect(() => syncHerdrPlugin(linkedRoot, () => reply())).toThrow(
      "Package file is not a regular file",
    );
  });

  it("keeps setupHerdrPlugin as the same compatibility behavior", async () => {
    const root = await makePackage();
    const herdr = new FakeHerdr(record(root));
    expect(setupHerdrPlugin(root, herdr.spawn).status).toBe("unchanged");
  });
});
