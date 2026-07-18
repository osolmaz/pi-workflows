import { agent } from "./definition.js";
import { extractJsonValue } from "./json.js";
import type { AgentNodeDefinition, WorkflowEdge, WorkflowNodeContext } from "./types.js";

const DEFAULT_FIELD = "route";
const SIMPLE_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// All `agent` node fields except the ones the decision helper owns.
type DecisionAgentOptions = Omit<
  AgentNodeDefinition,
  "nodeType" | "prompt" | "expectedOutput" | "validate"
>;

export type DecisionDefinition<TChoice extends string> = DecisionAgentOptions & {
  question: string | ((context: WorkflowNodeContext) => string | Promise<string>);
  choices: readonly TChoice[];
  field?: string;
};

/**
 * Build an `agent` node that asks the model to pick one of `choices` and
 * submit a JSON object whose chosen field is validated. Pair with
 * `decisionEdge` (or any `switch` edge keyed on `$.<field>`) to route on the
 * result.
 */
export function decision<TChoice extends string>(
  definition: DecisionDefinition<TChoice>,
): AgentNodeDefinition {
  const { question, choices, field: fieldOverride, ...agentOptions } = definition;
  const field = normalizeField(fieldOverride);
  assertValidChoices(choices);
  const allowed = new Set<string>(choices);
  const allowedLabels = choices.map((choice) => JSON.stringify(choice)).join(" | ");

  return agent({
    ...agentOptions,
    async prompt(context) {
      const text = typeof question === "function" ? await question(context) : question;
      return [
        text,
        "",
        `Answer by picking exactly one of: ${allowedLabels}.`,
        `Include a short "reason" alongside your choice.`,
      ].join("\n");
    },
    expectedOutput: `{ ${JSON.stringify(field)}: ${allowedLabels}, "reason": "short justification" }`,
    validate(output) {
      const raw = normalizeDecisionOutput(output);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Decision output must be a JSON object, got ${describeValue(raw)}`);
      }
      const value = (raw as Record<string, unknown>)[field];
      if (typeof value !== "string" || !allowed.has(value)) {
        throw new Error(
          `Decision returned invalid ${field}=${JSON.stringify(value)}; expected one of ${allowedLabels}`,
        );
      }
      return raw;
    },
  });
}

/**
 * Build the matching `switch` edge for a `decision` node. Typing `cases` as
 * `Record<TChoice, string>` makes a missing case a compile error.
 */
export function decisionEdge<TChoice extends string>(args: {
  from: string;
  choices: readonly TChoice[];
  field?: string;
  cases: Record<TChoice, string>;
}): WorkflowEdge {
  const field = normalizeField(args.field);
  assertValidChoices(args.choices);
  for (const choice of args.choices) {
    if (!Object.hasOwn(args.cases, choice)) {
      throw new Error(`Decision edge is missing case for choice ${JSON.stringify(choice)}`);
    }
  }
  return {
    from: args.from,
    switch: {
      on: `$.${field}`,
      cases: args.cases,
    },
  };
}

function normalizeDecisionOutput(output: unknown): unknown {
  if (typeof output === "string") {
    return extractJsonValue(output);
  }
  return output;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function assertValidChoices(choices: readonly string[]): void {
  if (choices.length === 0) {
    throw new Error("Decision choices must include at least one value");
  }
  const seen = new Set<string>();
  for (const choice of choices) {
    if (typeof choice !== "string" || choice.length === 0) {
      throw new Error("Decision choices must be non-empty strings");
    }
    if (seen.has(choice)) {
      throw new Error(`Decision choices must be unique; duplicate ${JSON.stringify(choice)}`);
    }
    seen.add(choice);
  }
}

function normalizeField(fieldOverride: string | undefined): string {
  const field = fieldOverride ?? DEFAULT_FIELD;
  if (!SIMPLE_FIELD_PATTERN.test(field)) {
    throw new Error(
      `Decision field must be a simple JSON key matching ${SIMPLE_FIELD_PATTERN.source}`,
    );
  }
  return field;
}
