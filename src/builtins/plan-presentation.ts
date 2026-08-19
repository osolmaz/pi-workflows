import {
  legacyDecisionPresentation,
  normalizeDecisionPresentation,
} from "../workflows/decision-presentation.js";
import type { DecisionPresentation } from "../workflows/types.js";

export function presentPlan(input: {
  task: string;
  plan: unknown;
  planDigest: string;
  revision: number;
}): DecisionPresentation {
  const plan = legacyDecisionPresentation(input.plan);
  const summary =
    readableSummary(planSummary(input.plan)) ??
    readableSummary(`Review the implementation plan for ${input.task}.`)!;
  return normalizeDecisionPresentation({
    schema: "pi-workflows.decision-presentation.v1",
    summary,
    blocks: [
      { kind: "section", title: "Task" },
      { kind: "paragraph", text: input.task },
      { kind: "section", title: "Plan" },
      ...plan.blocks.filter(
        (block, index) =>
          !(index === 0 && block.kind === "section" && block.title === "Decision details"),
      ),
      { kind: "section", title: "Plan identity" },
      {
        kind: "fields",
        items: [
          { label: "Revision", value: String(input.revision) },
          { label: "Digest", value: input.planDigest },
        ],
      },
    ],
  });
}

function readableSummary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length === 0 ? undefined : text;
}

function planSummary(plan: unknown): string | undefined {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  const summary = (plan as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.trim().length > 0 ? summary : undefined;
}
