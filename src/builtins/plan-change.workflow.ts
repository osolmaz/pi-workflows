import {
  compute,
  defineWorkflow,
  includeWorkflow,
  includedResult,
} from "../workflows/definition.js";
import type { WorkflowNodeContext } from "../workflows/types.js";
import autodocWorkflow, { type AutodocInput, type DocumentedPlan } from "./autodoc.workflow.js";
import autoplanWorkflow, { type AutoplanInput, type AutoplanReady } from "./autoplan.workflow.js";
import type { VerificationCheck } from "./change-verification.workflow.js";
import planApprovalWorkflow, {
  parsePlanApprovalPolicy,
  type PlanApprovalContinue,
  type NormalizedPlanApprovalInput,
  type PlanApprovalPolicy,
  type PlanApprovalResolution,
  type ResolvedPlanApprovalPolicy,
} from "./plan-approval.workflow.js";
import {
  parsePreparedWorkspace,
  type PreparedWorkspace,
} from "./workspace-preparation.workflow.js";

export type PlanChangeInput = {
  task: string;
  scope?: string;
  constraints?: string[];
  repository?: string;
  documents?: string[];
  previousPlan?: unknown;
  newEvidence?: unknown;
  approval?: PlanApprovalPolicy;
  preparedWorkspace?: PreparedWorkspace;
  verificationChecks?: VerificationCheck[];
};

export type NormalizedPlanChangeInput = Omit<PlanChangeInput, "approval"> & {
  approval: ResolvedPlanApprovalPolicy;
};

export type PlanChangeReady = {
  status: "ready";
  plan: unknown;
  planDigest: string;
  documents: string[];
  revision: number;
  approval: PlanApprovalResolution;
  documentation: DocumentedPlan["documentation"];
};

export type PlanChangeBlocked = {
  status: "blocked";
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

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} has unknown field ${unexpected[0]}`);
}

function parseStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function parseInput(value: unknown): NormalizedPlanChangeInput {
  const input = requireRecord(value, "plan change input");
  requireExactKeys(
    input,
    [
      "task",
      "scope",
      "constraints",
      "repository",
      "documents",
      "previousPlan",
      "newEvidence",
      "approval",
      "preparedWorkspace",
      "verificationChecks",
    ],
    "plan change input",
  );
  const constraints = parseStringArray(input.constraints, "plan change constraints");
  const documents = parseStringArray(input.documents, "plan change documents");
  return {
    task: requireString(input.task, "plan change task"),
    ...(input.scope !== undefined
      ? { scope: requireString(input.scope, "plan change scope") }
      : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(input.repository !== undefined
      ? { repository: requireString(input.repository, "plan change repository") }
      : {}),
    ...(documents !== undefined ? { documents } : {}),
    ...(input.previousPlan !== undefined ? { previousPlan: input.previousPlan } : {}),
    ...(input.newEvidence !== undefined ? { newEvidence: input.newEvidence } : {}),
    ...(input.preparedWorkspace === undefined
      ? {}
      : { preparedWorkspace: parsePreparedWorkspace(input.preparedWorkspace) }),
    ...(input.verificationChecks === undefined
      ? {}
      : { verificationChecks: input.verificationChecks as VerificationCheck[] }),
    approval: parsePlanApprovalPolicy(input.approval),
  };
}

function currentDesign(context: Pick<WorkflowNodeContext, "outputs">): AutoplanReady {
  const result = includedResult(autoplanWorkflow, context.outputs.design);
  if (result.exit !== "ready") throw new Error("plan change design did not return a ready plan");
  return result.output;
}

function currentDocumentation(context: Pick<WorkflowNodeContext, "outputs">): DocumentedPlan {
  const result = includedResult(autodocWorkflow, context.outputs.documentation);
  if (result.exit !== "ready") {
    throw new Error("plan change documentation did not return a ready plan");
  }
  return result.output;
}

function currentApproval(context: Pick<WorkflowNodeContext, "outputs">): PlanApprovalContinue {
  const result = includedResult(planApprovalWorkflow, context.outputs.approval);
  if (result.exit !== "continue") {
    throw new Error("plan change approval did not return continue");
  }
  return result.output;
}

function latestReplanInstructions(outputs: Record<string, unknown>): string | undefined {
  if (outputs.approval === undefined) return undefined;
  const result = includedResult(planApprovalWorkflow, outputs.approval);
  return result.exit === "replan" ? result.output.instructions : undefined;
}

function blockedResult(context: WorkflowNodeContext): PlanChangeBlocked {
  if (context.outputs.approval !== undefined) {
    const approval = includedResult(planApprovalWorkflow, context.outputs.approval);
    if (approval.exit === "stop") {
      return {
        status: "blocked",
        reason: "The operator stopped the proposed plan change.",
        evidence: approval.output,
      };
    }
  }
  const candidates = ["replanGuard", "assessPlan", "approval", "documentation", "design"];
  for (let index = context.state.steps.length - 1; index >= 0; index -= 1) {
    const step = context.state.steps[index];
    if (step === undefined || !candidates.some((candidate) => step.nodeId.startsWith(candidate))) {
      continue;
    }
    const output = step.output as Record<string, unknown> | null;
    if (output !== null && typeof output === "object") {
      const reason = output.reason;
      if (typeof reason === "string" && reason.length > 0) {
        return { status: "blocked", reason, evidence: step.output };
      }
    }
  }
  return {
    status: "blocked",
    reason: "The plan change could not continue within its configured policy.",
    evidence: null,
  };
}

export const planChangeWorkflow = defineWorkflow({
  source: import.meta.url,
  name: "plan-change",
  input: parseInput,
  startAt: "start",
  maxSteps: 400,
  includes: {
    design: includeWorkflow(autoplanWorkflow, {
      input: ({ input, outputs }): AutoplanInput => {
        const request = input as NormalizedPlanChangeInput;
        const prior =
          outputs.design === undefined
            ? request.previousPlan
            : (() => {
                const result = includedResult(autoplanWorkflow, outputs.design);
                return result.exit === "ready" ? result.output.plan : request.previousPlan;
              })();
        const instructions = latestReplanInstructions(outputs);
        return {
          problem: request.task,
          ...(request.scope !== undefined ? { scope: request.scope } : {}),
          ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
          ...(prior !== undefined ? { previousPlan: prior } : {}),
          ...(instructions === undefined
            ? request.newEvidence !== undefined
              ? { newEvidence: request.newEvidence }
              : {}
            : {
                newEvidence: {
                  priorEvidence: request.newEvidence,
                  operatorInstructions: instructions,
                },
              }),
        };
      },
    }),
    documentation: includeWorkflow(autodocWorkflow, {
      input: (context): AutodocInput => {
        const request = context.input as NormalizedPlanChangeInput;
        const design = currentDesign(context);
        return {
          task: request.task,
          plan: design.plan,
          ...(request.repository !== undefined ? { repository: request.repository } : {}),
          ...(request.preparedWorkspace === undefined
            ? {}
            : { preparedWorkspace: request.preparedWorkspace }),
          ...(request.verificationChecks === undefined
            ? {}
            : { verificationChecks: request.verificationChecks }),
          ...(request.documents !== undefined ? { documents: request.documents } : {}),
          evidence: request.newEvidence,
        };
      },
    }),
    approval: includeWorkflow(planApprovalWorkflow, {
      input: (context): NormalizedPlanApprovalInput => {
        const request = context.input as NormalizedPlanChangeInput;
        const documented = currentDocumentation(context);
        const revision =
          context.state.steps.filter((step) => step.nodeId === "approval/routePolicy").length + 1;
        return {
          task: request.task,
          plan: documented.plan,
          planDigest: documented.planDigest,
          approval: request.approval,
          revision,
        };
      },
    }),
  },
  exits: {
    ready: {
      from: "finalize",
      validate: (value: unknown): PlanChangeReady => value as PlanChangeReady,
    },
    blocked: {
      from: "blocked",
      validate: (value: unknown): PlanChangeBlocked => value as PlanChangeBlocked,
    },
  },
  nodes: {
    start: compute({ run: () => ({ route: "design" }) }),
    assessPlan: compute({
      run: (context) => {
        const request = context.input as NormalizedPlanChangeInput;
        const design = currentDesign(context);
        return request.previousPlan !== undefined && design.changed !== true
          ? {
              route: "blocked",
              reason: "Planning returned the same plan for the unresolved evidence.",
              evidence: design,
            }
          : { route: "document", planDigest: design.planDigest };
      },
    }),
    replanGuard: compute({
      run: (context) => {
        const request = context.input as NormalizedPlanChangeInput;
        const replans = context.state.steps.filter(
          (step) => step.nodeId === "approval/replan",
        ).length;
        return replans > request.approval.maxReplans
          ? {
              route: "blocked",
              reason: `Plan approval reached the ${request.approval.maxReplans}-replan safety limit.`,
              replans,
              limit: request.approval.maxReplans,
            }
          : { route: "design", replans, limit: request.approval.maxReplans };
      },
    }),
    finalize: compute({
      run: (context) => {
        const documented = currentDocumentation(context);
        const approval = currentApproval(context);
        const revision = context.state.steps.filter(
          (step) => step.nodeId === "approval/routePolicy",
        ).length;
        return {
          status: "ready",
          plan: documented.plan,
          planDigest: documented.planDigest,
          documents: documented.documentation.files,
          revision,
          approval: approval.resolution,
          documentation: documented.documentation,
        } satisfies PlanChangeReady;
      },
    }),
    blocked: compute({ run: blockedResult }),
  },
  edges: [
    { from: "start", to: "design" },
    { from: "design.ready", to: "assessPlan" },
    { from: "design.blocked", to: "blocked" },
    {
      from: "assessPlan",
      switch: { on: "$.route", cases: { document: "documentation", blocked: "blocked" } },
    },
    { from: "documentation.ready", to: "approval" },
    { from: "documentation.blocked", to: "blocked" },
    { from: "approval.continue", to: "finalize" },
    { from: "approval.stop", to: "blocked" },
    { from: "approval.replan", to: "replanGuard" },
    {
      from: "replanGuard",
      switch: { on: "$.route", cases: { design: "design", blocked: "blocked" } },
    },
  ],
});

export default planChangeWorkflow;
