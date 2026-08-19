import { compute, defineWorkflow, includeWorkflow, includedResult } from "@osolmaz/pi-workflows";
import autodoc from "../../src/builtins/autodoc.workflow.js";
import autoplan from "../../src/builtins/autoplan.workflow.js";
import planApproval from "../../src/builtins/plan-approval.workflow.js";

export default defineWorkflow({
  name: "approved-plan-example",
  startAt: "design",
  maxSteps: 80,
  includes: {
    design: includeWorkflow(autoplan, {
      input: ({ input, outputs }) => {
        const prior = outputs.design as { exit?: string; output?: { plan?: unknown } } | undefined;
        const answer = outputs.approval as
          | { exit?: string; output?: { instructions?: string } }
          | undefined;
        return {
          problem: (input as { task: string }).task,
          ...(prior?.exit === "ready" ? { previousPlan: prior.output?.plan } : {}),
          ...(answer?.exit === "replan" ? { newEvidence: answer.output?.instructions } : {}),
        };
      },
    }),
    documentation: includeWorkflow(autodoc, {
      input: ({ input, outputs }) => {
        const result = includedResult(autoplan, outputs.design);
        if (result.exit !== "ready") throw new Error("design is not ready");
        return { task: (input as { task: string }).task, plan: result.output.plan };
      },
    }),
    approval: includeWorkflow(planApproval, {
      input: ({ input, outputs }) => {
        const result = includedResult(autodoc, outputs.documentation);
        if (result.exit !== "ready") throw new Error("documentation is not ready");
        return {
          task: (input as { task: string }).task,
          plan: result.output.plan,
          planDigest: result.output.planDigest,
          audience: "operator",
        };
      },
    }),
  },
  nodes: {
    done: compute({ run: ({ outputs }) => ({ status: "approved", approval: outputs.approval }) }),
    stopped: compute({ run: ({ outputs }) => ({ status: "stopped", approval: outputs.approval }) }),
    blocked: compute({ run: ({ outputs }) => ({ status: "blocked", outputs }) }),
  },
  edges: [
    { from: "design.ready", to: "documentation" },
    { from: "design.blocked", to: "blocked" },
    { from: "documentation.ready", to: "approval" },
    { from: "documentation.blocked", to: "blocked" },
    { from: "approval.continue", to: "done" },
    { from: "approval.stop", to: "stopped" },
    { from: "approval.replan", to: "design" },
  ],
});
