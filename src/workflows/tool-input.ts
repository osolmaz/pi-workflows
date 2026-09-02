import { Type, type Static, type TObject, type TProperties, type TSchema } from "typebox";
import { Parse, ParseError } from "typebox/value";

const noExtraProperties = { additionalProperties: false } as const;

const offsetSchema = Type.Integer({ minimum: 0, description: "Workflow list offset" });
const workflowSchema = Type.String({
  description: "Discovered workflow name or workflow file path; required when action is start",
});
const inputSchema = Type.Unknown({
  description:
    "Ordinary checkpoint answer for answer; protected human decisions require a human channel; optional structured workflow input for start",
});
const runIdSchema = Type.String({
  description: "Run id; required for restart and optional for status, cancel, answer, settings, and follow-ups",
});
const stepSchema = Type.String({
  description: "Workflow step id; required when action is update or submit",
});
const attemptSchema = Type.String({
  description: "Workflow attempt id; required when action is update or submit",
});
const updateSchema = Type.Object(
  {
    type: Type.String(),
    key: Type.String(),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  noExtraProperties,
);
const outputSchema = Type.Unknown({
  description: "Step output matching the expected shape; required when action is submit",
});
export const WorkflowActionSchemas = {
  list: Type.Object(
    { action: Type.Literal("list"), offset: Type.Optional(offsetSchema) },
    noExtraProperties,
  ),
  start: Type.Object(
    {
      action: Type.Literal("start"),
      workflow: workflowSchema,
      input: Type.Optional(inputSchema),
    },
    noExtraProperties,
  ),
  restart: Type.Object(
    { action: Type.Literal("restart"), runId: runIdSchema },
    noExtraProperties,
  ),
  "change-settings": Type.Object(
    {
      action: Type.Literal("change-settings"),
      runId: Type.Optional(runIdSchema),
      scopeId: Type.Optional(Type.String()),
      expectedChangeNumber: Type.Optional(Type.Integer({ minimum: 0 })),
      patch: Type.Unknown(),
    },
    noExtraProperties,
  ),
  "queue-follow-up": Type.Object(
    {
      action: Type.Literal("queue-follow-up"),
      runId: Type.Optional(runIdSchema),
      prompt: Type.String({ minLength: 1 }),
    },
    noExtraProperties,
  ),
  "remove-follow-up": Type.Object(
    {
      action: Type.Literal("remove-follow-up"),
      runId: Type.Optional(runIdSchema),
      followUpId: Type.String(),
    },
    noExtraProperties,
  ),
  status: Type.Object(
    { action: Type.Literal("status"), runId: Type.Optional(runIdSchema) },
    noExtraProperties,
  ),
  pause: Type.Object({ action: Type.Literal("pause") }, noExtraProperties),
  resume: Type.Object({ action: Type.Literal("resume") }, noExtraProperties),
  cancel: Type.Object(
    { action: Type.Literal("cancel"), runId: Type.Optional(runIdSchema) },
    noExtraProperties,
  ),
  answer: Type.Object(
    {
      action: Type.Literal("answer"),
      input: inputSchema,
      runId: Type.Optional(runIdSchema),
    },
    noExtraProperties,
  ),
  update: Type.Object(
    {
      action: Type.Literal("update"),
      step: stepSchema,
      attempt: attemptSchema,
      update: updateSchema,
    },
    noExtraProperties,
  ),
  submit: Type.Object(
    {
      action: Type.Literal("submit"),
      step: stepSchema,
      attempt: attemptSchema,
      output: outputSchema,
    },
    noExtraProperties,
  ),
} as const;

const WorkflowSubmissionActionSchemas = {
  update: WorkflowActionSchemas.update,
  submit: WorkflowActionSchemas.submit,
} as const;

type SchemaValue<Schemas extends Record<string, TSchema>> = Schemas[keyof Schemas];

export type WorkflowToolInput = Static<SchemaValue<typeof WorkflowActionSchemas>>;
export type WorkflowSubmissionInput = Static<SchemaValue<typeof WorkflowSubmissionActionSchemas>>;

export const WorkflowToolParameters = providerObjectSchema(Object.values(WorkflowActionSchemas));
export const WorkflowSubmissionToolParameters = providerObjectSchema(
  Object.values(WorkflowSubmissionActionSchemas),
);

type ToolInputParser<Output> = (value: unknown) => Output;

const workflowInputParsers = {
  list: (value) => parseToolInput(WorkflowActionSchemas.list, value, "workflow"),
  start: (value) => parseToolInput(WorkflowActionSchemas.start, value, "workflow"),
  restart: (value) => parseToolInput(WorkflowActionSchemas.restart, value, "workflow"),
  "change-settings": (value) =>
    parseToolInput(WorkflowActionSchemas["change-settings"], value, "workflow"),
  "queue-follow-up": (value) =>
    parseToolInput(WorkflowActionSchemas["queue-follow-up"], value, "workflow"),
  "remove-follow-up": (value) =>
    parseToolInput(WorkflowActionSchemas["remove-follow-up"], value, "workflow"),
  status: (value) => parseToolInput(WorkflowActionSchemas.status, value, "workflow"),
  pause: (value) => parseToolInput(WorkflowActionSchemas.pause, value, "workflow"),
  resume: (value) => parseToolInput(WorkflowActionSchemas.resume, value, "workflow"),
  cancel: (value) => parseToolInput(WorkflowActionSchemas.cancel, value, "workflow"),
  answer: (value) => parseToolInput(WorkflowActionSchemas.answer, value, "workflow"),
  update: (value) => parseToolInput(WorkflowActionSchemas.update, value, "workflow"),
  submit: (value) => parseToolInput(WorkflowActionSchemas.submit, value, "workflow"),
} satisfies Record<keyof typeof WorkflowActionSchemas, ToolInputParser<WorkflowToolInput>>;

const workflowSubmissionInputParsers = {
  update: (value) =>
    parseToolInput(WorkflowSubmissionActionSchemas.update, value, "workflow submission"),
  submit: (value) =>
    parseToolInput(WorkflowSubmissionActionSchemas.submit, value, "workflow submission"),
} satisfies Record<
  keyof typeof WorkflowSubmissionActionSchemas,
  ToolInputParser<WorkflowSubmissionInput>
>;

export function parseWorkflowToolInput(value: unknown): WorkflowToolInput {
  return parseSelectedAction<WorkflowToolInput>(workflowInputParsers, value, "workflow");
}

export function parseWorkflowSubmissionInput(value: unknown): WorkflowSubmissionInput {
  return parseSelectedAction<WorkflowSubmissionInput>(
    workflowSubmissionInputParsers,
    value,
    "workflow submission",
  );
}

function providerObjectSchema(variants: readonly TObject[]): TObject {
  const actions: string[] = [];
  const properties: TProperties = {};

  for (const variant of variants) {
    const action = variant.properties.action;
    if (!isRecord(action) || typeof action.const !== "string") {
      throw new Error("Workflow action schema must have a string action literal.");
    }
    actions.push(action.const);

    for (const [name, schema] of Object.entries(variant.properties)) {
      if (name === "action") continue;
      const optionalSchema = Type.Optional(schema);
      const current = properties[name];
      if (current !== undefined && JSON.stringify(current) !== JSON.stringify(optionalSchema)) {
        throw new Error(`Workflow property ${JSON.stringify(name)} has incompatible schemas.`);
      }
      properties[name] = optionalSchema;
    }
  }

  return Type.Object(
    {
      action: Type.String({ enum: actions }),
      ...properties,
    },
    noExtraProperties,
  );
}

function parseSelectedAction<Output>(
  parsers: Readonly<Record<string, ToolInputParser<Output>>>,
  value: unknown,
  label: string,
): Output {
  if (!isRecord(value) || typeof value.action !== "string") throw unknownAction(label);
  const parser = parsers[value.action];
  if (parser === undefined) throw unknownAction(label);
  return parser(value);
}

function unknownAction(label: string): Error {
  return new Error(`Invalid ${label} tool input: action is missing or unknown.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
): Static<Schema> {
  try {
    return Parse(schema, value);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    const details = error.cause.errors
      .slice(0, 3)
      .map(({ instancePath, message }) => {
        const field = instancePath.replace(/^\//u, "").replaceAll("/", ".");
        const clearMessage = message === "must be integer" ? "must be an integer" : message;
        return `${field ? `${field} ` : ""}${clearMessage}`;
      })
      .join("; ");
    throw new Error(`Invalid ${label} tool input: ${details}`, { cause: error });
  }
}
