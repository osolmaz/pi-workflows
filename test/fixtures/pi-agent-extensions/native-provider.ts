import fs from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "fixture-native";
const modelId = "fixture-model";

export default function nativeProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: providerId,
    api: "fixture-api",
    models: [{ id: modelId, name: "Fixture model", reasoning: true }],
  });
  faux.setResponses([fauxAssistantMessage('{"answer":"ok"}')]);
  pi.registerProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Fixture provider key",
        async login() {
          return { type: "api_key", key: "fixture-login-key" };
        },
        async resolve() {
          if (process.env.PI_AGENT_FIXTURE_DISABLE_AUTH === "1") return undefined;
          return {
            auth: { apiKey: process.env.PI_AGENT_FIXTURE_API_KEY ?? "fixture-provider-key" },
            source: "fixture provider-owned authentication",
          };
        },
      },
    },
  });

  const record = async (event: string) => {
    const marker = process.env.PI_AGENT_FIXTURE_LIFECYCLE_FILE;
    if (marker) await fs.appendFile(marker, `${event}\n`, "utf8");
  };
  pi.on("session_start", async () => await record("session_start"));
  pi.on("session_shutdown", async () => await record("session_shutdown"));
}
