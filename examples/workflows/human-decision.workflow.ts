import {
  choice,
  compute,
  defineHumanChoices,
  defineWorkflow,
  humanDecision,
  humanDecisionEdge,
  textInput,
} from "@osolmaz/pi-workflows";

const choices = defineHumanChoices({
  continue: choice({ label: "Yes, continue" }),
  stop: choice({ label: "No, stop" }),
  replan: choice({
    label: "Replan",
    input: textInput({ name: "instructions", prompt: "What should change?" }),
  }),
});

export default defineWorkflow({
  name: "human-decision-example",
  startAt: "proposal",
  nodes: {
    proposal: compute({ run: ({ input }) => ({ plan: input }) }),
    approve: humanDecision({
      audience: "operator",
      choices,
      request: ({ outputs }) => ({
        title: "Approve the proposal",
        body: outputs.proposal,
      }),
    }),
    continued: compute({ run: ({ outputs }) => ({ status: "continue", answer: outputs.approve }) }),
    stopped: compute({ run: ({ outputs }) => ({ status: "stop", answer: outputs.approve }) }),
    replan: compute({ run: ({ outputs }) => ({ status: "replan", answer: outputs.approve }) }),
  },
  edges: [
    { from: "proposal", to: "approve" },
    humanDecisionEdge({
      from: "approve",
      choices,
      cases: { continue: "continued", stop: "stopped", replan: "replan" },
    }),
  ],
});
