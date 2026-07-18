import { agent, defineWorkflow } from "pi-workflows";

type EchoInput = {
  request?: string;
};

/** Smallest possible workflow: one agent step that submits a JSON reply. */
export default defineWorkflow({
  name: "echo",
  startAt: "reply",
  nodes: {
    reply: agent({
      prompt: ({ input }) => {
        const request =
          (input as EchoInput).request ?? "Summarize this repository in one sentence.";
        return `Answer the following request concisely.\n\nRequest: ${request}`;
      },
      expectedOutput: `{ "reply": "your concise answer" }`,
    }),
  },
  edges: [],
});
