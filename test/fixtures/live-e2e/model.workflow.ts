import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "live-model-e2e",
  startAt: "submit",
  nodes: {
    submit: agent({
      prompt: () =>
        'Call the workflow tool exactly once. Submit this object: { "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }.',
      expectedOutput: '{ "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }',
    }),
  },
  edges: [],
});
