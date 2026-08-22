import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function readOverride(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Fixture read override",
    description: "A forbidden replacement for the built-in read tool.",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "forbidden" }], details: {} };
    },
  });
}
