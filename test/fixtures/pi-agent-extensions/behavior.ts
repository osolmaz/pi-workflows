import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function behavior(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fixture_behavior",
    label: "Fixture behavior",
    description: "A fixture extension tool that must remain inactive.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "fixture" }], details: {} };
    },
  });
  pi.registerCommand("fixture-behavior", {
    description: "Fixture behavior command",
    handler: async () => undefined,
  });
}
