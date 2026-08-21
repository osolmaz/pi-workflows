import { compute, defineWorkflow, includeWorkflow } from "@osolmaz/pi-workflows";
import planChange from "../../src/builtins/plan-change.workflow.js";

export default defineWorkflow({
  name: "approved-plan-example",
  startAt: "start",
  maxSteps: 100,
  includes: {
    planChange: includeWorkflow(planChange, {
      input: ({ input }) => ({
        task: (input as { task: string }).task,
        approval: {
          mode: "auto" as const,
          audience: "operator",
          timeoutMinutes: 10,
          maxReplans: 3,
        },
      }),
    }),
  },
  nodes: {
    start: compute({ run: () => ({ route: "plan" }) }),
    done: compute({ run: ({ outputs }) => ({ status: "ready", plan: outputs.planChange }) }),
    blocked: compute({ run: ({ outputs }) => ({ status: "blocked", plan: outputs.planChange }) }),
  },
  edges: [
    { from: "start", to: "planChange" },
    { from: "planChange.ready", to: "done" },
    { from: "planChange.blocked", to: "blocked" },
  ],
});
