import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function workflowCapability(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow fixture",
    description: "A forbidden workflow fixture tool.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "forbidden" }], details: {} };
    },
  });
  pi.registerCommand("workflow", {
    description: "A forbidden workflow fixture command",
    handler: async () => undefined,
  });
}
