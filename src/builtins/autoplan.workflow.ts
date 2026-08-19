import { createHash } from "node:crypto";
import { agent, compute, defineWorkflow } from "../workflows/definition.js";

export type AutoplanInput = {
  problem: string;
  scope?: string;
  constraints?: string[];
  previousPlan?: unknown;
  newEvidence?: unknown;
};

export type AutoplanReady = {
  status: "ready";
  frame: unknown;
  proposal: unknown;
  ideal: unknown;
  selection: unknown;
  plan: unknown;
  planDigest: string;
  previousPlanDigest?: string;
  changed: boolean;
};

export type AutoplanBlocked = {
  status: "blocked";
  frame: unknown;
  proposal: unknown;
  ideal: unknown;
  selection: unknown;
  reason: string;
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

function parseInput(value: unknown): AutoplanInput {
  const input = requireRecord(value, "autoplan input");
  const constraints = input.constraints;
  if (
    constraints !== undefined &&
    (!Array.isArray(constraints) || constraints.some((item) => typeof item !== "string"))
  ) {
    throw new Error("autoplan constraints must be an array of strings");
  }
  return {
    problem: requireString(input.problem, "autoplan problem"),
    ...(input.scope !== undefined ? { scope: requireString(input.scope, "autoplan scope") } : {}),
    ...(constraints !== undefined ? { constraints: [...constraints] as string[] } : {}),
    ...(input.previousPlan !== undefined ? { previousPlan: input.previousPlan } : {}),
    ...(input.newEvidence !== undefined ? { newEvidence: input.newEvidence } : {}),
  };
}

function parseSelection(value: unknown): Record<string, unknown> {
  const selection = requireRecord(value, "autoplan selection");
  if (selection.status !== "ready" && selection.status !== "blocked") {
    throw new Error("autoplan selection status must be ready or blocked");
  }
  requireString(selection.selected, "autoplan selected solution");
  requireString(selection.why, "autoplan selection reason");
  if (selection.status === "blocked") requireString(selection.blocker, "autoplan blocker");
  return selection;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export const autoplanWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.autoplan.v1",
  name: "autoplan",
  input: parseInput,
  title: ({ input }) => `autoplan: ${input.problem.slice(0, 60)}`,
  presentationPrompt: [
    "Present the selected practical solution and its implementation plan.",
    "Briefly state how the ideal informed the choice and what was excluded as outside scope.",
    "Do not ask the user to choose between the options.",
  ].join("\n"),
  startAt: "frame",
  maxSteps: 10,
  exits: {
    ready: {
      from: "finalize",
      validate: (value: unknown): AutoplanReady => value as AutoplanReady,
    },
    blocked: {
      from: "blocked",
      validate: (value: unknown): AutoplanBlocked => value as AutoplanBlocked,
    },
  },
  nodes: {
    frame: agent({
      statusDetail: "framing the problem",
      prompt: ({ input }) => {
        const request = input as AutoplanInput;
        return [
          `Frame this problem: ${request.problem}`,
          `Authorized scope: ${request.scope ?? "infer it conservatively from the request and current project"}.`,
          `Constraints: ${JSON.stringify(request.constraints ?? [])}.`,
          `Previous plan: ${JSON.stringify(request.previousPlan ?? null)}.`,
          `New evidence: ${JSON.stringify(request.newEvidence ?? null)}.`,
          "Identify the goal, observable success criteria, systems in scope, systems outside scope, and interfaces we control.",
          "Do not invent permission to change an upstream project, external service, or unrelated repository.",
        ].join("\n");
      },
      expectedOutput: `{ "problem": "concise statement", "success": ["criterion"], "inScope": ["change"], "outOfScope": ["change"], "constraints": ["constraint"], "controlBoundary": "what can change" }`,
      validate: (value) => requireRecord(value, "autoplan frame"),
    }),
    propose: agent({
      statusDetail: "devising a solution",
      prompt: ({ outputs }) =>
        [
          "Devise the most elegant, long-term production-ready solution within the framed scope.",
          "Prefer a small number of general parts, clear ownership boundaries, and existing public interfaces.",
          "Avoid one-off mechanisms and unnecessary infrastructure.",
          "Do not implement anything.",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
        ].join("\n"),
      expectedOutput: `{ "solution": "proposal", "rationale": "why", "parts": ["part"], "tradeoffs": ["trade-off"] }`,
      validate: (value) => requireRecord(value, "autoplan proposal"),
    }),
    ideal: agent({
      statusDetail: "describing the ideal end state",
      prompt: ({ outputs, input }) =>
        [
          "Set the proposal aside and describe the holy grail for this problem.",
          "The holy grail can match the proposal or exceed the current scope.",
          "Name dependencies outside our authority instead of assuming they can change.",
          "Explain the practical value beyond the proposal.",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
          `Proposal: ${JSON.stringify(outputs.propose)}`,
          `New evidence: ${JSON.stringify((input as AutoplanInput).newEvidence ?? null)}`,
        ].join("\n"),
      expectedOutput: `{ "ideal": "ideal end state", "outsideDependencies": ["dependency"], "additionalValue": ["benefit"] }`,
      validate: (value) => requireRecord(value, "autoplan ideal"),
    }),
    choose: agent({
      statusDetail: "choosing the practical solution",
      prompt: ({ outputs }) =>
        [
          "Choose the right solution without asking the user to decide.",
          "Choose the ideal when it is production-ready, proportionate, in scope, and implementable through interfaces we control.",
          "Otherwise choose the strongest practical in-scope solution with a clear path toward the ideal.",
          "Do not block only because the ideal depends on work outside our authority.",
          "Do not make an upstream change, unrelated repository, new service, or unapproved resource a requirement.",
          "Prefer the simpler choice when options give materially equivalent results.",
          "Return blocked only when no truthful in-scope solution can meet the success criteria.",
          `Frame: ${JSON.stringify(outputs.frame)}`,
          `Proposal: ${JSON.stringify(outputs.propose)}`,
          `Ideal: ${JSON.stringify(outputs.ideal)}`,
        ].join("\n"),
      expectedOutput: `{ "status": "ready" | "blocked", "selected": "solution", "why": "reason", "relationshipToIdeal": "relationship", "excluded": ["excluded work"], "compromises": ["compromise"], "blocker": "required only when blocked" }`,
      validate: parseSelection,
    }),
    plan: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "writing the implementation plan",
      prompt: ({ outputs, input }) =>
        [
          "Write a detailed implementation-ready plan for the selected solution.",
          "Keep every step inside the framed scope and authority.",
          "For each step, state what changes, where it changes, and how to verify it.",
          "Include contract changes, compatibility boundaries, tests, rollout or migration work, and failure handling when they apply.",
          "Use the new evidence to correct the previous plan when one exists.",
          "Do not implement the plan.",
          `Frame: ${JSON.stringify(outputs.frame)}`,
          `Selection: ${JSON.stringify(outputs.choose)}`,
          `Previous plan: ${JSON.stringify((input as AutoplanInput).previousPlan ?? null)}`,
          `New evidence: ${JSON.stringify((input as AutoplanInput).newEvidence ?? null)}`,
        ].join("\n"),
      expectedOutput: `{ "summary": "approach", "steps": [{ "change": "change", "where": "location", "verification": "evidence" }], "contracts": ["impact"], "tests": ["test"], "risks": [{ "risk": "risk", "mitigation": "mitigation" }], "boundaries": ["excluded work"] }`,
      validate: (value) => requireRecord(value, "autoplan plan"),
    }),
    blocked: compute({
      run: ({ outputs }) => {
        const selection = outputs.choose as Record<string, unknown>;
        return {
          status: "blocked",
          frame: outputs.frame,
          proposal: outputs.propose,
          ideal: outputs.ideal,
          selection,
          reason: requireString(selection.blocker, "autoplan blocker"),
        } satisfies AutoplanBlocked;
      },
    }),
    finalize: compute({
      run: ({ outputs, input }) => {
        const request = input as AutoplanInput;
        const planDigest = digest(outputs.plan);
        const previousPlanDigest =
          request.previousPlan === undefined ? undefined : digest(request.previousPlan);
        return {
          status: "ready",
          frame: outputs.frame,
          proposal: outputs.propose,
          ideal: outputs.ideal,
          selection: outputs.choose,
          plan: outputs.plan,
          planDigest,
          ...(previousPlanDigest !== undefined ? { previousPlanDigest } : {}),
          changed: previousPlanDigest === undefined || previousPlanDigest !== planDigest,
        } satisfies AutoplanReady;
      },
    }),
  },
  edges: [
    { from: "frame", to: "propose" },
    { from: "propose", to: "ideal" },
    { from: "ideal", to: "choose" },
    {
      from: "choose",
      switch: { on: "$.status", cases: { ready: "plan", blocked: "blocked" } },
    },
    { from: "plan", to: "finalize" },
  ],
});

export default autoplanWorkflow;
