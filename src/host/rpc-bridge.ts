import { StringEnum } from "@earendil-works/pi-ai";
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
      "Publish an update or submit the output for the pending workflow step.",
      "Only call this tool when a workflow step contract in the conversation asks you to.",
      "Pass the exact step and attempt ids from the contract.",
    ].join(" "),
    parameters: Type.Union([
      Type.Object(
        {
          action: StringEnum(["update"] as const),
          step: Type.String(),
          attempt: Type.String(),
          update: Type.Object(
            {
              type: Type.String(),
              key: Type.String(),
              data: Type.Record(Type.String(), Type.Unknown()),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: StringEnum(["submit"] as const),
          step: Type.String({ description: "Step id from the workflow step contract" }),
          attempt: Type.String({ description: "Attempt id from the workflow step contract" }),
          output: Type.Unknown({ description: "Step output matching the expected shape" }),
        },
        { additionalProperties: false },
      ),
    ]),
    async execute(toolCallId, params) {
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
