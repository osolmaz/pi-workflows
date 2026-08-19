import { compute, defineWorkflow } from "../workflows/definition.js";
import {
  choice,
  defineHumanChoices,
  humanDecision,
  humanDecisionEdge,
  textInput,
} from "../workflows/human-decision.js";
import type { HumanDecisionReceipt, HumanDecisionResponse } from "../workflows/types.js";

export type PlanApprovalInput = {
  task: string;
  plan: unknown;
  planDigest: string;
  audience: string;
  revision?: number;
};

export type PlanApprovalContinue = {
  status: "continue";
  plan: unknown;
  planDigest: string;
  decision: HumanDecisionReceipt;
};

export type PlanApprovalStop = {
  status: "stop";
  planDigest: string;
  decision: HumanDecisionReceipt;
};

export type PlanApprovalReplan = {
  status: "replan";
  plan: unknown;
  planDigest: string;
  instructions: string;
  decision: HumanDecisionReceipt;
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

function parseInput(value: unknown): PlanApprovalInput {
  const input = requireRecord(value, "plan approval input");
  const revision = input.revision;
  if (revision !== undefined && (!Number.isInteger(revision) || (revision as number) < 1)) {
    throw new Error("plan approval revision must be a positive integer");
  }
  if (input.plan === undefined) throw new Error("plan approval requires a plan");
  return {
    task: requireString(input.task, "plan approval task"),
    plan: input.plan,
    planDigest: requireString(input.planDigest, "plan approval digest"),
    audience: requireString(input.audience, "plan approval audience"),
    ...(revision !== undefined ? { revision: revision as number } : {}),
  };
}

function acceptedDecision(value: HumanDecisionReceipt | undefined): HumanDecisionReceipt {
  if (value === undefined)
    throw new Error("plan approval continuation is missing its accepted decision");
  return value;
}

function gateResponse(value: unknown): HumanDecisionResponse {
  return requireRecord(value, "plan approval response") as HumanDecisionResponse;
}

export const planApprovalWorkflow = defineWorkflow({
  source: import.meta.url,
  contractId: "pi-workflows.plan-approval.v1",
  name: "plan-approval",
  input: parseInput,
  title: ({ input }) => `plan approval: ${input.task.slice(0, 60)}`,
  startAt: "approve",
  maxSteps: 8,
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
    approve: humanDecision({
      audience: ({ input }) => (input as PlanApprovalInput).audience,
      choices: planChoices,
      request: ({ input }) => {
        const request = input as PlanApprovalInput;
        return {
          title: "Approve the implementation plan",
          body: {
            task: request.task,
            plan: request.plan,
            planDigest: request.planDigest,
            revision: request.revision ?? 1,
          },
        };
      },
    }),
    continued: compute({
      run: ({ input, state }) => {
        const request = input as PlanApprovalInput;
        return {
          status: "continue",
          plan: request.plan,
          planDigest: request.planDigest,
          decision: acceptedDecision(state.humanDecision),
        } satisfies PlanApprovalContinue;
      },
    }),
    stopped: compute({
      run: ({ input, state }) => {
        const request = input as PlanApprovalInput;
        return {
          status: "stop",
          planDigest: request.planDigest,
          decision: acceptedDecision(state.humanDecision),
        } satisfies PlanApprovalStop;
      },
    }),
    replan: compute({
      run: ({ input, outputs, state }) => {
        const request = input as PlanApprovalInput;
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
          decision: acceptedDecision(state.humanDecision),
        } satisfies PlanApprovalReplan;
      },
    }),
  },
  edges: [
    humanDecisionEdge({
      from: "approve",
      choices: planChoices,
      cases: { continue: "continued", stop: "stopped", replan: "replan" },
    }),
  ],
});

export default planApprovalWorkflow;
