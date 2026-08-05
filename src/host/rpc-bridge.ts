import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const RPC_SUBMISSION_PREFIX = "PI_WORKFLOWS_STEP_SUBMISSION ";

/**
 * Loaded into headless `pi --mode rpc` children spawned by the standalone
 * host. The child has no workflow engine, so this bridge only registers the
 * `workflow` tool and reports every submission to the host over stderr; the
 * host validates against the engine and re-prompts on rejection.
 */
export default function piWorkflowsRpcBridge(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Submit the output for the pending workflow step.",
      "Only call this tool when a workflow step contract in the conversation asks you to.",
      "Pass the exact step id from the contract and your result as the output.",
    ].join(" "),
    parameters: Type.Object({
      step: Type.String({ description: "The step id from the workflow step contract" }),
      attempt: Type.String({ description: "The attempt id from the workflow step contract" }),
      output: Type.Unknown({ description: "The step output, matching the expected output shape" }),
    }),
    async execute(_toolCallId, params) {
      process.stderr.write(`${RPC_SUBMISSION_PREFIX}${JSON.stringify(params)}\n`);
      return {
        content: [
          {
            type: "text",
            text: "Submission recorded. Continue only when the workflow sends the next step.",
          },
        ],
        details: {},
      };
    },
  });
}
