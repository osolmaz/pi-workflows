import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseWorkflowSubmissionInput,
  WorkflowSubmissionToolParameters,
} from "../workflows/tool-input.js";

export const RPC_SUBMISSION_PREFIX = "PI_WORKFLOWS_STEP_SUBMISSION ";

/**
 * Loaded into headless `pi --mode rpc` children spawned by the standalone
 * server. The child has no workflow engine, so this bridge only registers the
 * `workflow` tool and reports every submission to the server over stderr; the
 * server validates against the engine and re-prompts on rejection.
 */
export default function piWorkflowsRpcBridge(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Publish an update or submit the output for the pending workflow step.",
      "Only call this tool when a workflow step contract in the conversation asks you to.",
      "Pass the exact step and attempt ids from the contract.",
    ].join(" "),
    parameters: WorkflowSubmissionToolParameters,
    async execute(toolCallId, rawParams) {
      const params = parseWorkflowSubmissionInput(rawParams);
      process.stderr.write(
        `${RPC_SUBMISSION_PREFIX}${JSON.stringify({ ...params, idempotencyKey: toolCallId })}\n`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              params.action === "update"
                ? "Workflow update recorded; continue the current step."
                : "Submission recorded. Continue only when the workflow sends the next step.",
          },
        ],
        details: {},
      };
    },
  });
}
