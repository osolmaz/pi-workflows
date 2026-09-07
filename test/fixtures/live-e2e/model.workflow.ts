import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "live-model-e2e",
  startAt: "submit",
  nodes: {
    submit: agent({
      prompt: () =>
        'Call the workflow tool exactly once. Use the exact requestId from the appended workflow step contract. Submit this object: { "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }.',
      expectedOutput: '{ "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }',
    }),
    finish: compute({ run: ({ outputs }) => outputs.submit }),
  },
  edges: [{ from: "submit", to: "finish" }],
});
