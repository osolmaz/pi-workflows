import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_API_BASE = "https://api.telegram.org";
const NUMERIC_ID = /^-?[0-9]+$/;
const SIMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type DecisionChannelConfig = {
  schema: "pi-workflows.channels.v1";
  audiences: Record<string, { channels: string[]; accept: "first-valid-answer" }>;
  telegramProfiles?: Record<
    string,
    {
      credential: string;
      allowedUserIds: string[];
      allowedChatIds: string[];
    }
  >;
};

export type DecisionCredentialConfig = {
  schema: "pi-workflows.credentials.v1";
  telegram: Record<string, { tokenFile: string }>;
};

export type LoadedDecisionChannelConfig = {
  channels: DecisionChannelConfig;
  credentials: Record<string, string>;
  configDir: string;
};

export type TelegramFetch = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function decisionConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_WORKFLOWS_CONFIG_DIR ?? path.join(os.homedir(), ".config", "pi-workflows");
}

export function audienceChannels(config: DecisionChannelConfig | null, audience: string): string[] {
  return [...(config?.audiences[audience]?.channels ?? ["pi"])];
}

export async function loadDecisionChannelConfig(
  configDir = decisionConfigDir(),
): Promise<LoadedDecisionChannelConfig | null> {
  const channelPath = path.join(configDir, "channels.json");
  let channelsRaw: unknown;
  try {
    channelsRaw = JSON.parse(await fs.readFile(channelPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await requirePrivateFile(channelPath, "pi-workflows channel profile");
  const channels = parseChannelConfig(channelsRaw);
  const profiles = Object.values(channels.telegramProfiles ?? {});
  if (profiles.length === 0) return { channels, credentials: {}, configDir };

  const credentialPath = path.join(configDir, "credentials.json");
  await requirePrivateFile(credentialPath, "pi-workflows credential profile");
  const credentialsConfig = parseCredentialConfig(
    JSON.parse(await fs.readFile(credentialPath, "utf8")) as unknown,
  );
  const credentials: Record<string, string> = {};
  for (const profile of profiles) {
    const credential = credentialsConfig.telegram[profile.credential];
    if (credential === undefined) {
      throw new Error(`Telegram credential ${profile.credential} is not configured`);
    }
    if (!path.isAbsolute(credential.tokenFile)) {
      throw new Error(`Telegram credential ${profile.credential} tokenFile must be absolute`);
    }
    await requirePrivateFile(
      credential.tokenFile,
      `Telegram credential ${profile.credential} token file`,
    );
    const token = (await fs.readFile(credential.tokenFile, "utf8")).trim();
    if (token.length === 0) {
      throw new Error(`Telegram credential ${profile.credential} token file is empty`);
    }
    credentials[profile.credential] = token;
  }
  return { channels, credentials, configDir };
}

export async function verifyTelegramTokenFile(
  tokenFile: string,
  fetchFn?: TelegramFetch,
  apiBase = DEFAULT_API_BASE,
): Promise<void> {
  const request = fetchFn ?? (fetch as TelegramFetch);
  if (!path.isAbsolute(tokenFile)) throw new Error("Telegram token file path must be absolute");
  await requirePrivateFile(tokenFile, "Telegram token file");
  const token = (await fs.readFile(tokenFile, "utf8")).trim();
  if (token.length === 0) throw new Error("Telegram token file is empty");
  let response: Awaited<ReturnType<TelegramFetch>>;
  try {
    response = await request(`${apiBase}/bot${encodeURIComponent(token)}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new Error("Telegram credential verification did not return a response");
  }
  if (!response.ok) {
    throw new Error(`Telegram credential verification failed with HTTP ${response.status}`);
  }
  const body = requireRecord(await response.json(), "Telegram credential verification response");
  if (body.ok !== true) throw new Error("Telegram credential verification was rejected");
}

export async function writeDecisionChannelProfile(options: {
  configDir?: string;
  audience: string;
  profile: string;
  credential: string;
  tokenFile: string;
  allowedUserIds: string[];
  allowedChatIds: string[];
}): Promise<void> {
  const configDir = options.configDir ?? decisionConfigDir();
  requireSimpleId(options.audience, "Decision audience");
  requireSimpleId(options.profile, "Telegram profile");
  requireSimpleId(options.credential, "Telegram credential");
  validateNumericIds(options.allowedUserIds, "Telegram allowed user IDs");
  validateNumericIds(options.allowedChatIds, "Telegram allowed chat IDs");
  if (!path.isAbsolute(options.tokenFile)) {
    throw new Error("Telegram token file path must be absolute");
  }
  await requirePrivateFile(options.tokenFile, "Telegram token file");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

  const channelPath = path.join(configDir, "channels.json");
  const credentialPath = path.join(configDir, "credentials.json");
  const existingChannels = await readOptionalJson(channelPath);
  const existingCredentials = await readOptionalJson(credentialPath);
  const channels =
    existingChannels === null
      ? ({ schema: "pi-workflows.channels.v1", audiences: {} } satisfies DecisionChannelConfig)
      : parseChannelConfig(existingChannels);
  const credentials =
    existingCredentials === null
      ? ({ schema: "pi-workflows.credentials.v1", telegram: {} } satisfies DecisionCredentialConfig)
      : parseCredentialConfig(existingCredentials);

  channels.telegramProfiles = {
    ...channels.telegramProfiles,
    [options.profile]: {
      credential: options.credential,
      allowedUserIds: [...options.allowedUserIds],
      allowedChatIds: [...options.allowedChatIds],
    },
  };
  const priorAudience = channels.audiences[options.audience];
  const channelId = `telegram:${options.profile}`;
  channels.audiences[options.audience] = {
    channels: [...new Set([...(priorAudience?.channels ?? ["pi"]), channelId])],
    accept: "first-valid-answer",
  };
  credentials.telegram[options.credential] = { tokenFile: options.tokenFile };
  await writePrivateJson(channelPath, channels);
  await writePrivateJson(credentialPath, credentials);
}

export function parseChannelConfig(value: unknown): DecisionChannelConfig {
  const input = requireRecord(value, "Decision channel configuration");
  if (input.schema !== "pi-workflows.channels.v1") {
    throw new Error("Decision channel configuration schema is invalid");
  }
  const audiencesInput = requireRecord(input.audiences, "Decision channel audiences");
  const audiences: DecisionChannelConfig["audiences"] = {};
  for (const [audience, raw] of Object.entries(audiencesInput)) {
    requireSimpleId(audience, "Decision audience");
    const record = requireRecord(raw, `Decision audience ${audience}`);
    const channels = stringArray(record.channels, `Decision audience ${audience} channels`);
    if (channels.length === 0) throw new Error(`Decision audience ${audience} has no channels`);
    if (record.accept !== "first-valid-answer") {
      throw new Error(`Decision audience ${audience} accept policy is invalid`);
    }
    audiences[audience] = { channels, accept: "first-valid-answer" };
  }
  const telegramProfiles: NonNullable<DecisionChannelConfig["telegramProfiles"]> = {};
  if (input.telegramProfiles !== undefined) {
    const profiles = requireRecord(input.telegramProfiles, "Telegram profiles");
    for (const [name, raw] of Object.entries(profiles)) {
      requireSimpleId(name, "Telegram profile");
      const profile = requireRecord(raw, `Telegram profile ${name}`);
      const credential = requireSimpleId(profile.credential, `Telegram profile ${name} credential`);
      const allowedUserIds = stringArray(
        profile.allowedUserIds,
        `Telegram profile ${name} allowedUserIds`,
      );
      const allowedChatIds = stringArray(
        profile.allowedChatIds,
        `Telegram profile ${name} allowedChatIds`,
      );
      validateNumericIds(allowedUserIds, `Telegram profile ${name} allowedUserIds`);
      validateNumericIds(allowedChatIds, `Telegram profile ${name} allowedChatIds`);
      if (allowedUserIds.length === 0 || allowedChatIds.length === 0) {
        throw new Error(`Telegram profile ${name} must allow at least one user and chat`);
      }
      telegramProfiles[name] = { credential, allowedUserIds, allowedChatIds };
    }
  }
  for (const [audience, rule] of Object.entries(audiences)) {
    for (const channel of rule.channels) {
      if (channel === "pi") continue;
      if (
        !channel.startsWith("telegram:") ||
        telegramProfiles[channel.slice("telegram:".length)] === undefined
      ) {
        throw new Error(`Decision audience ${audience} references unknown channel ${channel}`);
      }
    }
  }
  return {
    schema: "pi-workflows.channels.v1",
    audiences,
    ...(Object.keys(telegramProfiles).length === 0 ? {} : { telegramProfiles }),
  };
}

export function parseCredentialConfig(value: unknown): DecisionCredentialConfig {
  const input = requireRecord(value, "Decision credential configuration");
  if (input.schema !== "pi-workflows.credentials.v1") {
    throw new Error("Decision credential configuration schema is invalid");
  }
  const telegramInput = requireRecord(input.telegram, "Telegram credentials");
  const telegram: DecisionCredentialConfig["telegram"] = {};
  for (const [name, raw] of Object.entries(telegramInput)) {
    requireSimpleId(name, "Telegram credential");
    const credential = requireRecord(raw, `Telegram credential ${name}`);
    telegram[name] = { tokenFile: requireString(credential.tokenFile, "Telegram tokenFile") };
  }
  return { schema: "pi-workflows.credentials.v1", telegram };
}

async function requirePrivateFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`${label} must be a file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600`);
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function validateNumericIds(values: readonly string[], label: string): void {
  if (values.some((value) => !NUMERIC_ID.test(value))) {
    throw new Error(`${label} must contain only numeric IDs`);
  }
}

function requireSimpleId(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!SIMPLE_ID.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
