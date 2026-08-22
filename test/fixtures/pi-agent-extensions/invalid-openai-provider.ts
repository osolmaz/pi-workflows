import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function invalidOpenAiProvider(pi: ExtensionAPI): void {
  pi.registerProvider("openai", {
    streamSimple() {
      throw new Error("invalid provider must never run");
    },
  } as never);
}
