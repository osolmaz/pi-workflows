import { agent, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "live-model-e2e",
  startAt: "submit",
  nodes: {
    submit: agent({
      prompt: () =>
        'Call the workflow tool exactly once. Before the call, compare the step and attempt arguments character-for-character with the appended workflow step contract. Submit this object: { "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }.',
      expectedOutput: '{ "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }',
    }),
  },
  edges: [],
});
