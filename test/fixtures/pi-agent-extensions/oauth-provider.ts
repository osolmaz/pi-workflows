import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function oauthProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: "fixture-native",
    api: "fixture-api",
    models: [{ id: "fixture-model", reasoning: true }],
  });
  faux.setResponses([fauxAssistantMessage("OK")]);
  pi.registerProvider({
    ...faux.provider,
    auth: {
      oauth: {
        name: "Fixture OAuth",
        async login() {
          throw new Error("Login must not run in the refresh test");
        },
        async refresh(credential) {
          // Rotating tokens must be refreshed once across independent child runtimes.
          if (credential.refresh !== "0") throw new Error("Credential refreshed twice");
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            ...credential,
            refresh: "1",
            access: "refreshed",
            expires: Date.now() + 3_600_000,
          };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  });
}
