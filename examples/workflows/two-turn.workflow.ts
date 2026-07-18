import { agent, compute, defineWorkflow } from "pi-workflows";

type TwoTurnInput = {
  topic?: string;
};

/**
 * Multi-step agent work in the same pi conversation. Each step builds on the
 * previous step's accepted output, and the model keeps its full session
 * context (files it read, tools it ran) across steps.
 */
export default defineWorkflow({
  name: "two-turn",
  startAt: "inspect",
  nodes: {
    inspect: agent({
      prompt: ({ input }) => {
        const topic =
          (input as TwoTurnInput).topic ??
          "How should we validate a new extension before shipping it?";
        return [
          "Inspect the current workspace before answering.",
          "Read at least two files relevant to the topic (for example the package manifest and a source file).",
          "",
          `Topic: ${topic}`,
        ].join("\n");
      },
      expectedOutput: `{ "findings": ["short finding", "short finding"], "repoSummary": "short paragraph" }`,
    }),
    draft: agent({
      prompt: ({ outputs }) =>
        [
          "Build on your earlier inspection in this same conversation.",
          "Write a short draft answer about the topic.",
          "",
          `Inspection: ${JSON.stringify(outputs.inspect)}`,
        ].join("\n"),
      expectedOutput: `{ "draft": "short paragraph" }`,
    }),
    checklist: agent({
      prompt: ({ outputs }) =>
        [
          "Turn the draft into a concise validation checklist with concrete references.",
          "",
          `Draft: ${JSON.stringify(outputs.draft)}`,
        ].join("\n"),
      expectedOutput: `{ "checklist": ["item", "item"], "references": ["path", "path"] }`,
    }),
    finalize: compute({
      run: ({ outputs }) => ({
        inspection: outputs.inspect,
        draft: outputs.draft,
        checklist: outputs.checklist,
      }),
    }),
  },
  edges: [
    { from: "inspect", to: "draft" },
    { from: "draft", to: "checklist" },
    { from: "checklist", to: "finalize" },
  ],
});
