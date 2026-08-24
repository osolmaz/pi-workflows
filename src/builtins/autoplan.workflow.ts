import { createHash } from "node:crypto";
import { agent, compute, defineWorkflow, includeWorkflow } from "../workflows/definition.js";
import plainSummaryWorkflow, {
  type PlainSummaryInput,
  type PlainSummaryResult,
} from "./plain-summary.workflow.js";

export type AutoplanInput = {
  problem: string;
  scope?: string;
  constraints?: string[];
  previousPlan?: unknown;
  newEvidence?: unknown;
};

export type AutoplanCandidate = {
  id: string;
  title: string;
  gist: string;
  solution: string;
  rationale: string;
  parts: string[];
  tradeoffs: string[];
};

export type AutoplanProposal = {
  candidates: AutoplanCandidate[];
  previousPlan?:
    | { status: "candidate"; candidateId: string }
    | { status: "rejected"; reason: string };
};

export type AutoplanIdeal = {
  ideal: string;
  outsideDependencies: string[];
  additionalValue: string[];
};

export type AutoplanSelection = {
  status: "ready" | "blocked";
  selectedId: string;
  why: string;
  relationshipToIdeal: string;
  rejected: Array<{ id: string; reason: string }>;
  compromises: string[];
  blocker?: string;
};

export type AutoplanReady = {
  status: "ready";
  frame: unknown;
  proposal: AutoplanProposal;
  ideal: AutoplanIdeal;
  selection: AutoplanSelection;
  plan: unknown;
  plainSummary: PlainSummaryResult;
  planDigest: string;
  previousPlanDigest?: string;
  changed: boolean;
};

export type AutoplanBlocked = {
  status: "blocked";
  frame: unknown;
  proposal: AutoplanProposal;
  ideal: AutoplanIdeal;
  selection: AutoplanSelection;
  plainSummary: PlainSummaryResult;
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

function requireBoundedString(value: unknown, label: string, maxChars: number): string {
  const text = requireString(value, label);
  if (text.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return text;
}

function requireStringArray(
  value: unknown,
  label: string,
  maxItems = 32,
  maxChars = 2_000,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} strings`);
  }
  return value.map((item, index) => requireBoundedString(item, `${label}[${index}]`, maxChars));
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

function parseProposal(value: unknown, previousPlanSupplied: boolean): AutoplanProposal {
  const proposal = requireRecord(value, "autoplan proposal");
  if (
    !Array.isArray(proposal.candidates) ||
    proposal.candidates.length < 2 ||
    proposal.candidates.length > 4
  ) {
    throw new Error("autoplan proposal must contain two through four candidates");
  }
  const ids = new Set<string>();
  const candidates = proposal.candidates.map((value, index): AutoplanCandidate => {
    const candidate = requireRecord(value, `autoplan candidate ${index + 1}`);
    const id = requireString(candidate.id, `autoplan candidate ${index + 1} id`);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`autoplan candidate id ${JSON.stringify(id)} is invalid`);
    }
    if (id === "ideal" || ids.has(id)) {
      throw new Error(`autoplan candidate id ${JSON.stringify(id)} is reserved or duplicated`);
    }
    ids.add(id);
    return {
      id,
      title: requireBoundedString(candidate.title, `autoplan candidate ${id} title`, 200),
      gist: requireBoundedString(candidate.gist, `autoplan candidate ${id} gist`, 1_000),
      solution: requireBoundedString(
        candidate.solution,
        `autoplan candidate ${id} solution`,
        20_000,
      ),
      rationale: requireBoundedString(
        candidate.rationale,
        `autoplan candidate ${id} rationale`,
        5_000,
      ),
      parts: requireStringArray(candidate.parts, `autoplan candidate ${id} parts`),
      tradeoffs: requireStringArray(candidate.tradeoffs, `autoplan candidate ${id} tradeoffs`),
    };
  });

  let previousPlan: AutoplanProposal["previousPlan"];
  if (proposal.previousPlan !== undefined) {
    const account = requireRecord(proposal.previousPlan, "autoplan previousPlan account");
    if (account.status === "candidate") {
      const candidateId = requireString(account.candidateId, "autoplan previousPlan candidateId");
      if (!ids.has(candidateId)) {
        throw new Error("autoplan previousPlan candidateId must name a candidate");
      }
      previousPlan = { status: "candidate", candidateId };
    } else if (account.status === "rejected") {
      previousPlan = {
        status: "rejected",
        reason: requireBoundedString(
          account.reason,
          "autoplan previousPlan rejection reason",
          5_000,
        ),
      };
    } else {
      throw new Error("autoplan previousPlan status must be candidate or rejected");
    }
  }
  if (previousPlanSupplied && previousPlan === undefined) {
    throw new Error("autoplan proposal must account for the supplied previous plan");
  }
  return { candidates, ...(previousPlan !== undefined ? { previousPlan } : {}) };
}

function parseIdeal(value: unknown): AutoplanIdeal {
  const ideal = requireRecord(value, "autoplan ideal");
  return {
    ideal: requireBoundedString(ideal.ideal, "autoplan ideal end state", 20_000),
    outsideDependencies: requireStringArray(
      ideal.outsideDependencies,
      "autoplan ideal outsideDependencies",
    ),
    additionalValue: requireStringArray(ideal.additionalValue, "autoplan ideal additionalValue"),
  };
}

function parseSelection(value: unknown, proposal: AutoplanProposal): AutoplanSelection {
  const selection = requireRecord(value, "autoplan selection");
  if (selection.status !== "ready" && selection.status !== "blocked") {
    throw new Error("autoplan selection status must be ready or blocked");
  }
  const validIds = new Set([...proposal.candidates.map((candidate) => candidate.id), "ideal"]);
  const selectedId = requireString(selection.selectedId, "autoplan selectedId");
  if (!validIds.has(selectedId)) throw new Error("autoplan selectedId must name a candidate");
  if (!Array.isArray(selection.rejected)) {
    throw new Error("autoplan rejected plans must be an array");
  }
  const rejectedIds = new Set<string>();
  const rejected = selection.rejected.map((value, index) => {
    const rejection = requireRecord(value, `autoplan rejection ${index + 1}`);
    const id = requireString(rejection.id, `autoplan rejection ${index + 1} id`);
    if (!validIds.has(id) || id === selectedId || rejectedIds.has(id)) {
      throw new Error(`autoplan rejected id ${JSON.stringify(id)} is invalid or duplicated`);
    }
    rejectedIds.add(id);
    return {
      id,
      reason: requireBoundedString(rejection.reason, `autoplan rejection ${id} reason`, 5_000),
    };
  });
  const expectedRejected = [...validIds].filter((id) => id !== selectedId).sort();
  if (JSON.stringify([...rejectedIds].sort()) !== JSON.stringify(expectedRejected)) {
    throw new Error("autoplan selection must reject every non-selected candidate exactly once");
  }
  const blocker =
    selection.status === "blocked"
      ? requireString(selection.blocker, "autoplan blocker")
      : undefined;
  return {
    status: selection.status,
    selectedId,
    why: requireBoundedString(selection.why, "autoplan selection reason", 5_000),
    relationshipToIdeal: requireBoundedString(
      selection.relationshipToIdeal,
      "autoplan relationshipToIdeal",
      5_000,
    ),
    rejected,
    compromises: requireStringArray(selection.compromises, "autoplan compromises"),
    ...(blocker !== undefined ? { blocker } : {}),
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function plainSummaryResult(value: unknown, label: string): PlainSummaryResult {
  const included = requireRecord(value, label);
  if (included.exit !== "completed") throw new Error(`${label} must use the completed exit`);
  const result = requireRecord(included.output, `${label} output`);
  return { text: requireString(result.text, `${label} text`) };
}

function candidateSummary(
  proposal: AutoplanProposal,
  ideal: AutoplanIdeal,
  id: string,
): { id: string; title: string; gist: string } {
  if (id === "ideal") return { id, title: "Ideal end state", gist: ideal.ideal };
  const candidate = proposal.candidates.find((item) => item.id === id);
  if (candidate === undefined)
    throw new Error(`autoplan candidate ${JSON.stringify(id)} is missing`);
  return { id, title: candidate.title, gist: candidate.gist };
}

function summaryInput(
  outputs: Record<string, unknown>,
  blocked: boolean,
  input: AutoplanInput,
): PlainSummaryInput {
  const proposal = outputs.propose as AutoplanProposal;
  const selection = outputs.choose as AutoplanSelection;
  const ideal = outputs.ideal as AutoplanIdeal;
  const selected = candidateSummary(proposal, ideal, selection.selectedId);
  return {
    source: {
      status: selection.status,
      selected,
      why: selection.why,
      implementationPlan: blocked ? null : outputs.plan,
      rejected: selection.rejected.map((rejection) => ({
        ...candidateSummary(proposal, ideal, rejection.id),
        reason: rejection.reason,
      })),
      relationshipToIdeal: selection.relationshipToIdeal,
      compromises: selection.compromises,
      ...(proposal.previousPlan !== undefined && input.previousPlan !== undefined
        ? { previousPlan: { plan: input.previousPlan, account: proposal.previousPlan } }
        : {}),
      ...(selection.blocker !== undefined ? { blocker: selection.blocker } : {}),
    },
    purpose: blocked
      ? "Explain plainly why planning is blocked and summarize every considered plan."
      : "Explain the recommended plan plainly, summarize its main implementation steps, and give one-line reasons for rejecting every other plan.",
    mustInclude: [
      selected.title,
      ...selection.rejected.map(
        (rejection) => candidateSummary(proposal, ideal, rejection.id).title,
      ),
      ...(proposal.previousPlan !== undefined && input.previousPlan !== undefined
        ? ["Previous plan"]
        : []),
      ...(blocked ? [selection.blocker as string] : ["The plan is selected for approval"]),
    ],
    format: "mixed",
  };
}

export const autoplanWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.autoplan.v1",
  name: "autoplan",
  input: parseInput,
  title: ({ input }) => `autoplan: ${input.problem.slice(0, 60)}`,
  startAt: "frame",
  maxSteps: 16,
  includes: {
    readySummary: includeWorkflow(plainSummaryWorkflow, {
      input: ({ outputs, input }) => summaryInput(outputs, false, input as AutoplanInput),
    }),
    blockedSummary: includeWorkflow(plainSummaryWorkflow, {
      input: ({ outputs, input }) => summaryInput(outputs, true, input as AutoplanInput),
    }),
  },
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
          `Planning problem: ${request.problem}`,
          `Allowed scope: ${request.scope ?? "infer it conservatively from the request and current project"}.`,
          `Constraints: ${JSON.stringify(request.constraints ?? [])}.`,
          `Previous plan: ${JSON.stringify(request.previousPlan ?? null)}.`,
          `New evidence: ${JSON.stringify(request.newEvidence ?? null)}.`,
          "State the goal and describe what success looks like.",
          "List the systems we may change and the systems we must leave alone. Name the interfaces we control.",
          "Do not assume permission to change an upstream project, an external service, or an unrelated repository.",
        ].join("\n");
      },
      expectedOutput: `{ "problem": "concise statement", "success": ["criterion"], "inScope": ["change"], "outOfScope": ["change"], "constraints": ["constraint"], "controlBoundary": "what can change" }`,
      validate: (value) => requireRecord(value, "autoplan frame"),
    }),
    propose: agent({
      statusDetail: "devising candidate solutions",
      prompt: ({ outputs, input }) =>
        [
          "Give two to four practical options that fit the allowed scope.",
          "For each option return a stable lowercase id and a short title. Add a plain gist and full solution, explain the reason and trade-offs, and list the parts.",
          "Favor a few reusable parts with clear owners and use interfaces that already exist.",
          "Reject one-off machinery and infrastructure that the task does not need.",
          "If the input includes an earlier plan, keep it as an option or explain why the new evidence rules it out.",
          "Do not change files.",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
          `Previous plan: ${JSON.stringify((input as AutoplanInput).previousPlan ?? null)}`,
        ].join("\n"),
      expectedOutput: `{ "candidates": [{ "id": "stable-id", "title": "short title", "gist": "plain gist", "solution": "full proposal", "rationale": "why", "parts": ["part"], "tradeoffs": ["trade-off"] }], "previousPlan": { "status": "candidate", "candidateId": "id" } | { "status": "rejected", "reason": "reason" } }`,
      validate: (value, { input }) =>
        parseProposal(value, (input as AutoplanInput).previousPlan !== undefined),
    }),
    ideal: agent({
      statusDetail: "describing the ideal end state",
      prompt: ({ outputs, input }) =>
        [
          "Describe the best possible end state separately from the practical options.",
          "It may match one option or go beyond the current scope.",
          "List each dependency we do not control. Do not assume that it can change.",
          "State what this end state would improve beyond the practical options.",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
          `Candidates: ${JSON.stringify(outputs.propose)}`,
          `New evidence: ${JSON.stringify((input as AutoplanInput).newEvidence ?? null)}`,
        ].join("\n"),
      expectedOutput: `{ "ideal": "ideal end state", "outsideDependencies": ["dependency"], "additionalValue": ["benefit"] }`,
      validate: parseIdeal,
    }),
    choose: agent({
      statusDetail: "choosing the practical solution",
      prompt: ({ outputs }) =>
        [
          "Select one option. Do not ask the user to choose.",
          "Select the ideal only when it fits the allowed scope and is ready for production. Its value must justify the added complexity.",
          "Otherwise select the best option we can build now that still moves toward the ideal.",
          "Work outside our control does not by itself make the plan blocked.",
          "Do not require changes to an upstream project or an unrelated repository. Do not require a new service or resource without approval.",
          "When two options solve the problem equally well, choose the simpler one.",
          "Give one specific rejection reason for every option you do not select, including the ideal.",
          "Return blocked only if no option inside the allowed scope can meet the success criteria.",
          `Frame: ${JSON.stringify(outputs.frame)}`,
          `Candidates: ${JSON.stringify(outputs.propose)}`,
          `Ideal candidate id: ideal`,
          `Ideal: ${JSON.stringify(outputs.ideal)}`,
        ].join("\n"),
      expectedOutput: `{ "status": "ready" | "blocked", "selectedId": "candidate-id-or-ideal", "why": "reason", "relationshipToIdeal": "relationship", "rejected": [{ "id": "other-id", "reason": "why it lost" }], "compromises": ["compromise"], "blocker": "required only when blocked" }`,
      validate: (value, { outputs }) => parseSelection(value, outputs.propose as AutoplanProposal),
    }),
    plan: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "writing the implementation plan",
      prompt: ({ outputs, input }) =>
        [
          "Turn the selected option into a plan that another engineer can implement.",
          "Keep every step inside the allowed scope and authority.",
          "For each step name the location and exact change before stating the check that proves it works.",
          "Describe contract changes and compatibility boundaries before listing tests. Include rollout, migration, and failure handling only where they apply.",
          "Correct the earlier plan when the new evidence proves it wrong.",
          "Do not change files.",
          `Frame: ${JSON.stringify(outputs.frame)}`,
          `Selection: ${JSON.stringify(outputs.choose)}`,
          `Candidates: ${JSON.stringify(outputs.propose)}`,
          `Previous plan: ${JSON.stringify((input as AutoplanInput).previousPlan ?? null)}`,
          `New evidence: ${JSON.stringify((input as AutoplanInput).newEvidence ?? null)}`,
        ].join("\n"),
      expectedOutput: `{ "summary": "approach", "steps": [{ "change": "change", "where": "location", "verification": "evidence" }], "contracts": ["impact"], "tests": ["test"], "risks": [{ "risk": "risk", "mitigation": "mitigation" }], "boundaries": ["excluded work"] }`,
      validate: (value) => requireRecord(value, "autoplan plan"),
    }),
    blocked: compute({
      run: ({ outputs }) => {
        const selection = outputs.choose as AutoplanSelection;
        return {
          status: "blocked",
          frame: outputs.frame,
          proposal: outputs.propose as AutoplanProposal,
          ideal: outputs.ideal as AutoplanIdeal,
          selection,
          plainSummary: plainSummaryResult(outputs.blockedSummary, "autoplan blocked summary"),
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
          proposal: outputs.propose as AutoplanProposal,
          ideal: outputs.ideal as AutoplanIdeal,
          selection: outputs.choose as AutoplanSelection,
          plan: outputs.plan,
          plainSummary: plainSummaryResult(outputs.readySummary, "autoplan ready summary"),
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
      switch: { on: "$.status", cases: { ready: "plan", blocked: "blockedSummary" } },
    },
    { from: "plan", to: "readySummary" },
    { from: "readySummary.completed", to: "finalize" },
    { from: "blockedSummary.completed", to: "blocked" },
  ],
});

export default autoplanWorkflow;
