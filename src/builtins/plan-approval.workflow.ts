import { compute, defineWorkflow } from "../workflows/definition.js";
import {
  choice,
  defineHumanChoices,
  humanDecision,
  humanDecisionEdge,
  textInput,
} from "../workflows/human-decision.js";
import type { HumanDecisionReceipt, HumanDecisionResponse } from "../workflows/types.js";
import { presentPlan } from "./plan-presentation.js";

const DEFAULT_APPROVAL_AUDIENCE = "operator";
const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 10;
const DEFAULT_MAX_REPLANS = 3;
const MAX_APPROVAL_TIMEOUT_MINUTES = 24 * 60;
const MAX_REPLANS = 20;

export type PlanApprovalMode = "auto" | "required" | "skip";

export type PlanApprovalPolicy = {
  mode?: PlanApprovalMode;
  audience?: string;
  timeoutMinutes?: number;
  maxReplans?: number;
};

export type ResolvedPlanApprovalPolicy = {
  mode: PlanApprovalMode;
  audience: string;
  timeoutMinutes?: number;
  maxReplans: number;
};

export type PlanApprovalInput = {
  task: string;
  plan: unknown;
  planDigest: string;
  approval?: PlanApprovalPolicy;
  revision?: number;
};

export type NormalizedPlanApprovalInput = Omit<PlanApprovalInput, "approval"> & {
  approval: ResolvedPlanApprovalPolicy;
};

export type PlanApprovalResolution =
  | { provenance: "skipped"; revision: number }
  | { provenance: "human"; decision: HumanDecisionReceipt }
  | { provenance: "timeout"; decision: HumanDecisionReceipt };

export type PlanApprovalContinue = {
  status: "continue";
  plan: unknown;
  planDigest: string;
  resolution: PlanApprovalResolution;
};

export type PlanApprovalStop = {
  status: "stop";
  planDigest: string;
  resolution: { provenance: "human"; decision: HumanDecisionReceipt };
};

export type PlanApprovalReplan = {
  status: "replan";
  plan: unknown;
  planDigest: string;
  instructions: string;
  resolution: { provenance: "human"; decision: HumanDecisionReceipt };
};

const planChoices = defineHumanChoices({
  continue: choice({ label: "Yes, continue" }),
  stop: choice({ label: "No, stop" }),
  replan: choice({
    label: "Replan",
    input: textInput({
      name: "instructions",
      prompt: "What should change?",
      minLength: 1,
      maxLength: 4_000,
    }),
  }),
});

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
  if (unexpected.length > 0) {
    throw new Error(`${label} has unknown field ${unexpected[0]}`);
  }
}

export function parsePlanApprovalPolicy(value: unknown): ResolvedPlanApprovalPolicy {
  if (value === undefined) {
    return {
      mode: "auto",
      audience: DEFAULT_APPROVAL_AUDIENCE,
      timeoutMinutes: DEFAULT_APPROVAL_TIMEOUT_MINUTES,
      maxReplans: DEFAULT_MAX_REPLANS,
    };
  }
  const policy = requireRecord(value, "plan approval policy");
  requireExactKeys(
    policy,
    ["mode", "audience", "timeoutMinutes", "maxReplans"],
    "plan approval policy",
  );
  const mode = policy.mode ?? "auto";
  if (mode !== "auto" && mode !== "required" && mode !== "skip") {
    throw new Error("plan approval mode must be auto, required, or skip");
  }
  if (mode !== "auto" && policy.timeoutMinutes !== undefined) {
    throw new Error("plan approval timeoutMinutes is available only in auto mode");
  }
  const timeoutMinutes = policy.timeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES;
  if (
    mode === "auto" &&
    (!Number.isInteger(timeoutMinutes) ||
      (timeoutMinutes as number) < 1 ||
      (timeoutMinutes as number) > MAX_APPROVAL_TIMEOUT_MINUTES)
  ) {
    throw new Error(
      `plan approval timeoutMinutes must be from 1 through ${MAX_APPROVAL_TIMEOUT_MINUTES}`,
    );
  }
  const maxReplans = policy.maxReplans ?? DEFAULT_MAX_REPLANS;
  if (
    !Number.isInteger(maxReplans) ||
    (maxReplans as number) < 1 ||
    (maxReplans as number) > MAX_REPLANS
  ) {
    throw new Error(`plan approval maxReplans must be from 1 through ${MAX_REPLANS}`);
  }
  return {
    mode,
    audience:
      mode === "skip"
        ? DEFAULT_APPROVAL_AUDIENCE
        : policy.audience === undefined
          ? DEFAULT_APPROVAL_AUDIENCE
          : requireString(policy.audience, "plan approval audience"),
    ...(mode === "auto" ? { timeoutMinutes: timeoutMinutes as number } : {}),
    maxReplans: maxReplans as number,
  };
}

function parseInput(value: unknown): NormalizedPlanApprovalInput {
  const input = requireRecord(value, "plan approval input");
  requireExactKeys(
    input,
    ["task", "plan", "planDigest", "approval", "revision"],
    "plan approval input",
  );
  const revision = input.revision;
  if (revision !== undefined && (!Number.isInteger(revision) || (revision as number) < 1)) {
    throw new Error("plan approval revision must be a positive integer");
  }
  if (input.plan === undefined) throw new Error("plan approval requires a plan");
  return {
    task: requireString(input.task, "plan approval task"),
    plan: input.plan,
    planDigest: requireString(input.planDigest, "plan approval digest"),
    approval: parsePlanApprovalPolicy(input.approval),
    ...(revision !== undefined ? { revision: revision as number } : {}),
  };
}

function gateResponse(value: unknown): HumanDecisionResponse {
  return value as HumanDecisionResponse;
}

function decisionResolution(
  value: HumanDecisionReceipt | undefined,
):
  | { provenance: "human"; decision: HumanDecisionReceipt }
  | { provenance: "timeout"; decision: HumanDecisionReceipt } {
  if (value === undefined) throw new Error("plan approval decision receipt is missing");
  return { provenance: value.provenance, decision: value };
}

function humanResolution(value: HumanDecisionReceipt | undefined): {
  provenance: "human";
  decision: HumanDecisionReceipt;
} {
  const resolution = decisionResolution(value);
  if (resolution.provenance !== "human") {
    throw new Error("plan approval stop and replan require a human decision");
  }
  return resolution;
}

export const planApprovalWorkflow = defineWorkflow({
  source: import.meta.url,
  name: "plan-approval",
  input: parseInput,
  startAt: "routePolicy",
  exits: {
    continue: {
      from: "continued",
      validate: (value: unknown): PlanApprovalContinue => value as PlanApprovalContinue,
    },
    stop: {
      from: "stopped",
      validate: (value: unknown): PlanApprovalStop => value as PlanApprovalStop,
    },
    replan: {
      from: "replan",
      validate: (value: unknown): PlanApprovalReplan => value as PlanApprovalReplan,
    },
  },
  nodes: {
    routePolicy: compute({
      run: ({ input }) => ({
        route: (input as NormalizedPlanApprovalInput).approval.mode === "skip" ? "skip" : "ask",
      }),
    }),
    approve: humanDecision({
      audience: ({ input }) => (input as NormalizedPlanApprovalInput).approval.audience,
      choices: planChoices,
      onTimeout: ({ input }) => {
        const policy = (input as NormalizedPlanApprovalInput).approval;
        return policy.mode === "auto"
          ? {
              afterMs: (policy.timeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES) * 60_000,
              response: { choice: "continue" },
            }
          : undefined;
      },
      request: ({ input }) => {
        const request = input as NormalizedPlanApprovalInput;
        const revision = request.revision ?? 1;
        return {
          title: "Approve the implementation plan",
          subject: {
            task: request.task,
            plan: request.plan,
            planDigest: request.planDigest,
            revision,
          },
          presentation: presentPlan({
            task: request.task,
            plan: request.plan,
            planDigest: request.planDigest,
            revision,
          }),
          revision,
        };
      },
    }),
    continued: compute({
      run: ({ input, state }) => {
        const request = input as NormalizedPlanApprovalInput;
        return {
          status: "continue",
          plan: request.plan,
          planDigest: request.planDigest,
          resolution:
            request.approval.mode === "skip"
              ? { provenance: "skipped", revision: request.revision ?? 1 }
              : decisionResolution(state.humanDecision),
        } satisfies PlanApprovalContinue;
      },
    }),
    stopped: compute({
      run: ({ input, state }) => {
        const request = input as NormalizedPlanApprovalInput;
        return {
          status: "stop",
          planDigest: request.planDigest,
          resolution: humanResolution(state.humanDecision),
        } satisfies PlanApprovalStop;
      },
    }),
    replan: compute({
      run: ({ input, outputs, state }) => {
        const request = input as NormalizedPlanApprovalInput;
        const response = gateResponse(outputs.approve);
        const instructions = response.input?.instructions;
        if (typeof instructions !== "string" || instructions.length === 0) {
          throw new Error("replan answer is missing exact instructions");
        }
        return {
          status: "replan",
          plan: request.plan,
          planDigest: request.planDigest,
          instructions,
          resolution: humanResolution(state.humanDecision),
        } satisfies PlanApprovalReplan;
      },
    }),
  },
  edges: [
    {
      from: "routePolicy",
      switch: { on: "$.route", cases: { ask: "approve", skip: "continued" } },
    },
    humanDecisionEdge({
      from: "approve",
      choices: planChoices,
      cases: { continue: "continued", stop: "stopped", replan: "replan" },
    }),
  ],
});

export default planApprovalWorkflow;
