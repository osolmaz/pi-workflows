import { agent, compute, defineWorkflow } from "../workflows/definition.js";
import { digest } from "../workflows/human-decision.js";
import type { WorkflowNodeContext } from "../workflows/types.js";

export type AutodocInput = {
  task: string;
  plan?: unknown;
  repository?: string;
  documents?: string[];
  evidence?: unknown;
};

export type DocumentedPlan = {
  status: "ready";
  task: string;
  plan: unknown;
  planDigest: string;
  documentation: {
    state: "current" | "updated";
    files: string[];
    digests: Record<string, string>;
    evidence: unknown;
  };
  verification: unknown;
};

export type AutodocBlocked = {
  status: "blocked";
  task: string;
  reason: string;
  evidence: unknown;
};

type LocatedPlan = {
  route: "found" | "blocked";
  plan?: unknown;
  sources?: string[];
  reason: string;
  evidence: unknown;
};

type DocumentationAssessment = {
  route: "current" | "update" | "blocked";
  files: string[];
  digests: Record<string, string>;
  reason: string;
  evidence: unknown;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = requireRecord(value, label);
  if (Object.values(record).some((item) => typeof item !== "string")) {
    throw new Error(`${label} values must be strings`);
  }
  return record as Record<string, string>;
}

function parseInput(value: unknown): AutodocInput {
  const input = requireRecord(value, "autodoc input");
  const documents = input.documents;
  return {
    task: requireString(input.task, "autodoc task"),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.repository !== undefined
      ? { repository: requireString(input.repository, "autodoc repository") }
      : {}),
    ...(documents !== undefined ? { documents: stringArray(documents, "autodoc documents") } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  };
}

function parseLocatedPlan(value: unknown): LocatedPlan {
  const result = requireRecord(value, "located plan");
  if (result.route !== "found" && result.route !== "blocked") {
    throw new Error("located plan route must be found or blocked");
  }
  if (result.route === "found" && result.plan === undefined) {
    throw new Error("located plan must include the selected plan");
  }
  return {
    route: result.route,
    ...(result.plan !== undefined ? { plan: result.plan } : {}),
    ...(result.sources !== undefined
      ? { sources: stringArray(result.sources, "located plan sources") }
      : {}),
    reason: requireString(result.reason, "located plan reason"),
    evidence: result.evidence ?? null,
  };
}

function parseDocumentationAssessment(value: unknown): DocumentationAssessment {
  const result = requireRecord(value, "documentation assessment");
  if (result.route !== "current" && result.route !== "update" && result.route !== "blocked") {
    throw new Error("documentation assessment route must be current, update, or blocked");
  }
  return {
    route: result.route,
    files: stringArray(result.files, "documentation files"),
    digests: stringRecord(result.digests, "documentation digests"),
    reason: requireString(result.reason, "documentation reason"),
    evidence: result.evidence ?? null,
  };
}

function currentPlan(context: WorkflowNodeContext): unknown {
  const explicit = (context.input as AutodocInput).plan;
  if (explicit !== undefined) return explicit;
  const located = context.outputs.locatePlan as LocatedPlan | undefined;
  if (located?.route === "found" && located.plan !== undefined) return located.plan;
  throw new Error("autodoc does not have a selected plan");
}

function blockedReason(context: WorkflowNodeContext): AutodocBlocked {
  const request = context.input as AutodocInput;
  const assessment = context.outputs.inspectDocumentation as DocumentationAssessment | undefined;
  const located = context.outputs.locatePlan as LocatedPlan | undefined;
  return {
    status: "blocked",
    task: request.task,
    reason:
      assessment?.route === "blocked"
        ? assessment.reason
        : located?.route === "blocked"
          ? located.reason
          : "Autodoc could not identify a clear selected plan or canonical document target.",
    evidence: assessment?.evidence ?? located?.evidence ?? null,
  };
}

export const autodocWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.autodoc.v1",
  name: "autodoc",
  input: parseInput,
  title: ({ input }) => `autodoc: ${input.task.slice(0, 60)}`,
  startAt: "prepare",
  maxSteps: 24,
  exits: {
    ready: {
      from: "finalize",
      validate: (value: unknown): DocumentedPlan => value as DocumentedPlan,
    },
    blocked: {
      from: "blocked",
      validate: (value: unknown): AutodocBlocked => value as AutodocBlocked,
    },
  },
  nodes: {
    prepare: compute({
      run: ({ input }) => ({
        route: (input as AutodocInput).plan === undefined ? "locate" : "inspect",
      }),
    }),
    locatePlan: agent({
      statusDetail: "locating selected plan",
      prompt: ({ input }) => {
        const request = input as AutodocInput;
        return [
          "Find the clear plan that has already been selected for this task.",
          "Look in the current conversation context and in the referenced canonical documents.",
          "Do not devise, improve, replace, or implement the plan.",
          "Return blocked when no single clear selected plan exists.",
          `Task: ${request.task}`,
          `Repository: ${request.repository ?? "current repository"}`,
          `Referenced documents: ${JSON.stringify(request.documents ?? [])}`,
          `Evidence: ${JSON.stringify(request.evidence ?? null)}`,
        ].join("\n");
      },
      expectedOutput:
        '{ "route": "found" | "blocked", "plan": {} (required when found), "sources": ["source"], "reason": "reason", "evidence": "evidence" }',
      validate: parseLocatedPlan,
    }),
    inspectDocumentation: agent({
      statusDetail: "checking canonical documentation",
      prompt: (context) => {
        const request = context.input as AutodocInput;
        return [
          "Check whether the selected plan is already recorded completely and accurately in the canonical specification and implementation plan.",
          "Use repository guidance to choose canonical files. Do not redesign or implement anything.",
          "Choose current only when the documents already preserve the whole selected plan and its boundaries.",
          "Choose update when documents are missing or stale and can be corrected in scope.",
          "Choose blocked only when no safe canonical target exists or repository rules prohibit the documentation change.",
          `Task: ${request.task}`,
          `Selected plan: ${JSON.stringify(currentPlan(context))}`,
          `Preferred documents: ${JSON.stringify(request.documents ?? [])}`,
        ].join("\n");
      },
      expectedOutput:
        '{ "route": "current" | "update" | "blocked", "files": ["canonical file"], "digests": { "file": "sha256:digest" }, "reason": "reason", "evidence": "evidence" }',
      validate: parseDocumentationAssessment,
    }),
    updateDocumentation: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "updating canonical documentation",
      prompt: (context) => {
        const request = context.input as AutodocInput;
        const assessment = context.outputs.inspectDocumentation as DocumentationAssessment;
        return [
          "Update the canonical specification and implementation plan to preserve the selected plan exactly.",
          "Use the repository documentation rules and keep the text plain and complete.",
          "Do not redesign the solution and do not implement code.",
          `Task: ${request.task}`,
          `Selected plan: ${JSON.stringify(currentPlan(context))}`,
          `Canonical files: ${JSON.stringify(assessment.files)}`,
          `Assessment: ${JSON.stringify(assessment)}`,
        ].join("\n");
      },
      expectedOutput:
        '{ "updated": true, "files": ["changed file"], "digests": { "file": "sha256:digest" }, "summary": "what was recorded" }',
      validate: (value) => {
        const result = requireRecord(value, "documentation update");
        if (result.updated !== true)
          throw new Error("documentation update must report updated: true");
        stringArray(result.files, "updated documentation files");
        stringRecord(result.digests, "updated documentation digests");
        requireString(result.summary, "documentation update summary");
        return result;
      },
    }),
    verifyDocumentation: agent({
      timeoutMs: 20 * 60_000,
      statusDetail: "verifying documentation",
      prompt: ({ outputs }) =>
        [
          "Verify the changed canonical documentation.",
          "Run the repository documentation, formatting, link, and privacy checks that apply.",
          "Do not implement code.",
          `Documentation update: ${JSON.stringify(outputs.updateDocumentation)}`,
        ].join("\n"),
      expectedOutput:
        '{ "passed": true | false, "commands": [{ "command": "exact command", "outcome": "result" }], "failures": ["failure"] }',
      validate: (value) => {
        const result = requireRecord(value, "documentation verification");
        if (typeof result.passed !== "boolean") {
          throw new Error("documentation verification passed must be boolean");
        }
        return result;
      },
    }),
    finalize: compute({
      run: (context) => {
        const request = context.input as AutodocInput;
        const assessment = context.outputs.inspectDocumentation as DocumentationAssessment;
        const plan = currentPlan(context);
        const updated = context.outputs.updateDocumentation;
        if (updated === undefined) {
          return {
            status: "ready",
            task: request.task,
            plan,
            planDigest: digest(plan),
            documentation: {
              state: "current",
              files: assessment.files,
              digests: assessment.digests,
              evidence: assessment.evidence,
            },
            verification: { passed: true, reason: "Canonical documentation was already current." },
          } satisfies DocumentedPlan;
        }
        const updateRecord = requireRecord(updated, "documentation update");
        return {
          status: "ready",
          task: request.task,
          plan,
          planDigest: digest(plan),
          documentation: {
            state: "updated",
            files: stringArray(updateRecord.files, "updated documentation files"),
            digests: stringRecord(updateRecord.digests, "updated documentation digests"),
            evidence: context.outputs.verifyDocumentation,
          },
          verification: context.outputs.verifyDocumentation,
        } satisfies DocumentedPlan;
      },
    }),
    blocked: compute({ run: blockedReason }),
  },
  edges: [
    {
      from: "prepare",
      switch: { on: "$.route", cases: { locate: "locatePlan", inspect: "inspectDocumentation" } },
    },
    {
      from: "locatePlan",
      switch: { on: "$.route", cases: { found: "inspectDocumentation", blocked: "blocked" } },
    },
    {
      from: "inspectDocumentation",
      switch: {
        on: "$.route",
        cases: { current: "finalize", update: "updateDocumentation", blocked: "blocked" },
      },
    },
    { from: "updateDocumentation", to: "verifyDocumentation" },
    {
      from: "verifyDocumentation",
      switch: { on: "$.passed", cases: { true: "finalize", false: "blocked" } },
    },
  ],
});

export default autodocWorkflow;
