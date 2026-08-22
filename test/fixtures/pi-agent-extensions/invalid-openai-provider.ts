import fs from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function invalidOpenAiProvider(pi: ExtensionAPI): void {
  pi.registerProvider("openai", {
    streamSimple() {
      throw new Error("invalid provider must never run");
    },
  } as never);
  pi.on("session_shutdown", async () => {
    const marker = process.env.PI_AGENT_INVALID_PROVIDER_SHUTDOWN_FILE;
    if (marker) await fs.appendFile(marker, "session_shutdown\n", "utf8");
  });
}
