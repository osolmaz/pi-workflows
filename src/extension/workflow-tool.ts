import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";

const noExtraProperties = { additionalProperties: false } as const;

// The tool schema must be a single `type: "object"` root for providers that
// reject union roots. All fields are optional and action-specific; the execute
// handler switches on `action` and guards missing required fields.
export const WorkflowToolParameters: TSchema = Type.Object(
  {
    action: StringEnum([
      "list",
      "start",
      "status",
      "pause",
      "resume",
      "cancel",
      "answer",
      "update",
      "submit",
    ] as const),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Workflow list offset" })),
    workflow: Type.Optional(
      Type.String({ description: "Discovered workflow name or workflow file path" }),
    ),
    input: Type.Optional(Type.Unknown({ description: "Structured workflow input" })),
    runId: Type.Optional(Type.String({ description: "Run id; omit for the active run" })),
    step: Type.Optional(
      Type.String({ description: "Active step id from the workflow step contract" }),
    ),
    attempt: Type.Optional(
      Type.String({ description: "Active attempt id from the workflow step contract" }),
    ),
    update: Type.Optional(
      Type.Object(
        {
          type: Type.String(),
          key: Type.String(),
          data: Type.Record(Type.String(), Type.Unknown()),
        },
        noExtraProperties,
      ),
    ),
    output: Type.Optional(Type.Unknown({ description: "Step output matching the expected shape" })),
  },
  noExtraProperties,
);

export type WorkflowToolInput =
  | { action: "list"; offset?: number }
  | { action: "start"; workflow: string; input?: unknown }
  | { action: "status"; runId?: string }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "cancel" }
  | { action: "answer"; input: unknown; runId?: string }
  | {
      action: "update";
      step: string;
      attempt: string;
      update: { type: string; key: string; data: Record<string, unknown> };
    }
  | { action: "submit"; step: string; attempt: string; output: unknown };
