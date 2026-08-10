import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";

const noExtraProperties = { additionalProperties: false } as const;

export const WorkflowToolParameters: TSchema = Type.Union([
  Type.Object(
    {
      action: StringEnum(["list"] as const),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Workflow list offset" })),
    },
    noExtraProperties,
  ),
  Type.Object(
    {
      action: StringEnum(["start"] as const),
      workflow: Type.String({ description: "Discovered workflow name or workflow file path" }),
      input: Type.Optional(Type.Unknown({ description: "Structured workflow input" })),
    },
    noExtraProperties,
  ),
  Type.Object(
    {
      action: StringEnum(["status"] as const),
      runId: Type.Optional(Type.String({ description: "Run id; omit for the active run" })),
    },
    noExtraProperties,
  ),
  Type.Object({ action: StringEnum(["pause"] as const) }, noExtraProperties),
  Type.Object({ action: StringEnum(["resume"] as const) }, noExtraProperties),
  Type.Object({ action: StringEnum(["cancel"] as const) }, noExtraProperties),
  Type.Object(
    {
      action: StringEnum(["answer"] as const),
      input: Type.Unknown({ description: "Checkpoint answer" }),
      runId: Type.Optional(Type.String({ description: "Waiting run id" })),
    },
    noExtraProperties,
  ),
  Type.Object(
    {
      action: StringEnum(["submit"] as const),
      step: Type.String({ description: "Step id from the workflow step contract" }),
      attempt: Type.String({ description: "Attempt id from the workflow step contract" }),
      output: Type.Unknown({ description: "Step output matching the expected shape" }),
    },
    noExtraProperties,
  ),
]);

export type WorkflowToolInput =
  | { action: "list"; offset?: number }
  | { action: "start"; workflow: string; input?: unknown }
  | { action: "status"; runId?: string }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "cancel" }
  | { action: "answer"; input: unknown; runId?: string }
  | { action: "submit"; step: string; attempt: string; output: unknown };
