import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audienceChannels,
  createTelegramChannels,
  decisionConfigDir,
  loadDecisionChannelConfig,
  verifyTelegramTokenFile,
  writeDecisionChannelProfile,
  type DecisionChannelConfig,
  type TelegramFetch,
} from "../src/extension/decision-channels.js";
import { HumanDecisionStore } from "../src/workflows/human-decision.js";
import { makeStateDatabasePath, makeTempDir } from "./helpers.js";

async function privateJson(filePath: string, value: unknown, mode = 0o600) {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, { mode });
}

function piOnly(): DecisionChannelConfig {
  return {
    schema: "pi-workflows.channels.v1",
    audiences: { operator: { channels: ["pi"], accept: "first-valid-answer" } },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decision channel configuration", () => {
  it("uses the configured directory or the private home default", () => {
    expect(decisionConfigDir({ PI_WORKFLOWS_CONFIG_DIR: "/configured" })).toBe("/configured");
    expect(decisionConfigDir({})).toBe(path.join(os.homedir(), ".config", "pi-workflows"));
  });

  it("resolves default and configured named audiences", () => {
    expect(audienceChannels(null, "operator")).toEqual(["pi"]);
    expect(audienceChannels(piOnly(), "operator")).toEqual(["pi"]);
    expect(audienceChannels(piOnly(), "missing")).toEqual(["pi"]);
  });

  it("returns null without configuration and loads Pi-only configuration", async () => {
    const configDir = await makeTempDir("decision-config-empty");
    expect(await loadDecisionChannelConfig(configDir)).toBeNull();
    await privateJson(path.join(configDir, "channels.json"), piOnly());
    expect(await loadDecisionChannelConfig(configDir)).toEqual({
      channels: piOnly(),
      credentials: {},
      configDir,
    });
  });

  it("rejects public, malformed, and inconsistent private profiles", async () => {
    const configDir = await makeTempDir("decision-config-invalid");
    const channelPath = path.join(configDir, "channels.json");
    await privateJson(channelPath, piOnly(), 0o644);
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/0600/);
    await fs.chmod(channelPath, 0o600);
    await privateJson(channelPath, { ...piOnly(), schema: "wrong" });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/schema/);
    await privateJson(channelPath, {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: { channels: ["telegram:missing"], accept: "first-valid-answer" },
      },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/unknown channel/);
  });

  it("rejects malformed audience and profile fields", async () => {
    const configDir = await makeTempDir("decision-config-malformed");
    const channelPath = path.join(configDir, "channels.json");
    await fs.writeFile(channelPath, "{", { mode: 0o600 });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow();
    const invalid = [
      null,
      { schema: "pi-workflows.channels.v1", audiences: [] },
      { schema: "pi-workflows.channels.v1", audiences: {}, telegramProfiles: [] },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: { "bad/name": {} },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: { approval: null },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "approval", allowedUserIds: "100", allowedChatIds: ["-200"] },
        },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "approval", allowedUserIds: [], allowedChatIds: ["-200"] },
        },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "approval", allowedUserIds: ["100"], allowedChatIds: ["bad"] },
        },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: {},
        telegramProfiles: {
          approval: { credential: "bad/name", allowedUserIds: ["100"], allowedChatIds: ["-200"] },
        },
      },
      { schema: "pi-workflows.channels.v1", audiences: { "bad/name": {} } },
      { schema: "pi-workflows.channels.v1", audiences: { operator: null } },
      {
        schema: "pi-workflows.channels.v1",
        audiences: { operator: { channels: ["pi"], accept: "last-answer" } },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: { operator: { channels: "pi", accept: "first-valid-answer" } },
      },
      {
        schema: "pi-workflows.channels.v1",
        audiences: { operator: { channels: [], accept: "first-valid-answer" } },
      },
    ];
    for (const value of invalid) {
      await privateJson(channelPath, value);
      await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow();
    }
  });

  it("rejects malformed credential profile fields", async () => {
    const configDir = await makeTempDir("decision-credentials-malformed");
    await privateJson(path.join(configDir, "channels.json"), {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: { channels: ["telegram:approval"], accept: "first-valid-answer" },
      },
      telegramProfiles: {
        approval: {
          credential: "approval",
          allowedUserIds: ["100"],
          allowedChatIds: ["-200"],
        },
      },
    });
    const credentialPath = path.join(configDir, "credentials.json");
    const invalid = [
      { schema: "wrong", telegram: {} },
      { schema: "pi-workflows.credentials.v1", telegram: [] },
      { schema: "pi-workflows.credentials.v1", telegram: { "bad/name": {} } },
      { schema: "pi-workflows.credentials.v1", telegram: { approval: null } },
      { schema: "pi-workflows.credentials.v1", telegram: { approval: {} } },
    ];
    for (const value of invalid) {
      await privateJson(credentialPath, value);
      await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow();
    }
  });

  it("rejects invalid credential references and token files", async () => {
    const configDir = await makeTempDir("decision-credential-invalid");
    const channelPath = path.join(configDir, "channels.json");
    const credentialPath = path.join(configDir, "credentials.json");
    await privateJson(channelPath, {
      schema: "pi-workflows.channels.v1",
      audiences: {
        operator: { channels: ["telegram:approval"], accept: "first-valid-answer" },
      },
      telegramProfiles: {
        approval: {
          credential: "approval",
          allowedUserIds: ["100"],
          allowedChatIds: ["-200"],
        },
      },
    });
    await privateJson(credentialPath, {
      schema: "pi-workflows.credentials.v1",
      telegram: { approval: { tokenFile: "relative" } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/absolute/);
    await privateJson(credentialPath, {
      schema: "pi-workflows.credentials.v1",
      telegram: { approval: { tokenFile: configDir } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/must be a file/);
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "", { mode: 0o600 });
    await privateJson(credentialPath, {
      schema: "pi-workflows.credentials.v1",
      telegram: { approval: { tokenFile } },
    });
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/empty/);
    await fs.writeFile(tokenFile, "fixture");
    await fs.chmod(tokenFile, 0o644);
    await expect(loadDecisionChannelConfig(configDir)).rejects.toThrow(/0600/);
  });

  it("reports every bounded Telegram verification failure", async () => {
    const configDir = await makeTempDir("decision-verify-invalid");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await expect(verifyTelegramTokenFile("relative", async () => neverResponse())).rejects.toThrow(
      /absolute/,
    );
    await fs.writeFile(tokenFile, "");
    await expect(verifyTelegramTokenFile(tokenFile, async () => neverResponse())).rejects.toThrow(
      /empty/,
    );
    await fs.writeFile(tokenFile, "fixture");
    const throwing: TelegramFetch = async () => {
      throw new Error("offline");
    };
    await expect(verifyTelegramTokenFile(tokenFile, throwing)).rejects.toThrow(/did not return/);
    await expect(
      verifyTelegramTokenFile(tokenFile, async () => ({
        ok: false,
        status: 401,
        async json() {
          return {};
        },
      })),
    ).rejects.toThrow(/401/);
    await expect(
      verifyTelegramTokenFile(tokenFile, async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: false };
        },
      })),
    ).rejects.toThrow(/rejected/);
  });

  it("constructs configured Telegram channels through the shared interface", async () => {
    const configDir = await makeTempDir("decision-create-channels");
    vi.stubEnv("PI_WORKFLOWS_CONFIG_DIR", configDir);
    const channels = createTelegramChannels({
      config: {
        schema: "pi-workflows.channels.v1",
        audiences: {
          operator: {
            channels: ["pi", "telegram:approval"],
            accept: "first-valid-answer",
          },
        },
        telegramProfiles: {
          approval: {
            credential: "approval",
            allowedUserIds: ["100"],
            allowedChatIds: ["-200"],
          },
        },
      },
      credentials: { approval: "fixture" },
      store: new HumanDecisionStore(await makeStateDatabasePath("decision-create-channel-runs")),
      onAnswer: async () => {},
    });
    expect([...channels.keys()]).toEqual(["telegram:approval"]);
    await Promise.all([...channels.values()].map(async (channel) => channel.stop()));
  });

  it("writes a first private channel and credential profile", async () => {
    const configDir = await makeTempDir("decision-setup-first");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await writeDecisionChannelProfile({
      configDir,
      audience: "operator",
      profile: "approval",
      credential: "approval",
      tokenFile,
      allowedUserIds: ["100"],
      allowedChatIds: ["-200"],
    });
    const loaded = await loadDecisionChannelConfig(configDir);
    expect(loaded?.channels.audiences.operator?.channels).toEqual(["pi", "telegram:approval"]);
    expect(loaded?.credentials.approval).toBe("fixture");
  });

  it("rejects invalid setup values and missing resolved credentials", async () => {
    const configDir = await makeTempDir("decision-setup-invalid");
    const tokenFile = path.join(configDir, "token");
    await fs.writeFile(tokenFile, "fixture", { mode: 0o600 });
    await expect(
      writeDecisionChannelProfile({
        configDir,
        audience: "operator",
        profile: "approval",
        credential: "approval",
        tokenFile,
        allowedUserIds: ["not-numeric"],
        allowedChatIds: ["-200"],
      }),
    ).rejects.toThrow(/numeric/);
    await expect(
      writeDecisionChannelProfile({
        configDir,
        audience: "operator",
        profile: "approval",
        credential: "approval",
        tokenFile: "relative-token-file",
        allowedUserIds: ["100"],
        allowedChatIds: ["-200"],
      }),
    ).rejects.toThrow(/absolute/);
    expect(() =>
      createTelegramChannels({
        config: {
          schema: "pi-workflows.channels.v1",
          audiences: {},
          telegramProfiles: {
            approval: {
              credential: "missing",
              allowedUserIds: ["100"],
              allowedChatIds: ["-200"],
            },
          },
        },
        credentials: {},
        store: new HumanDecisionStore(path.join(configDir, "state.sqlite")),
        onAnswer: async () => {},
      }),
    ).toThrow(/missing credential/);
  });
});

function neverResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, result: {} };
    },
  };
}
