import { agent, checkpoint, decision, decisionEdge, defineWorkflow } from "pi-workflows";

const sameChoices = ["y", "n"] as const;

/**
 * Trigger this mid-conversation with /workflow elegant-solution once a
 * problem has been discussed. It makes the model commit to the most elegant
 * long-term production-ready solution, articulate the holy grail, and check
 * whether the two match before implementing.
 */
export default defineWorkflow({
  name: "elegant-solution",
  title: "Elegant production-ready solution",
  startAt: "propose",
  nodes: {
    propose: agent({
      prompt: () =>
        [
          "Consider the problem discussed so far in this conversation.",
          "What is the most elegant and long-term production-ready solution?",
          "Think it through and commit to one concrete proposal.",
        ].join("\n"),
      expectedOutput: `{ "solution": "the proposed solution", "rationale": "why it is the most elegant long-term choice" }`,
    }),
    holy_grail: agent({
      prompt: () =>
        [
          "Now set your previous proposal aside for a moment.",
          "What is the holy grail for this problem?",
          "Describe the ideal end state with no constraints on effort.",
        ].join("\n"),
      expectedOutput: `{ "holyGrail": "the ideal end state" }`,
    }),
    compare: decision({
      choices: sameChoices,
      question: ({ outputs }) =>
        [
          "Is the holy grail the same as what you proposed? Answer y or n.",
          "",
          `Proposal: ${JSON.stringify(outputs.propose)}`,
          `Holy grail: ${JSON.stringify(outputs.holy_grail)}`,
        ].join("\n"),
    }),
    implement: agent({
      timeoutMs: 60 * 60_000,
      statusDetail: "implementing",
      prompt: ({ outputs }) =>
        [
          "The proposal matches the holy grail, so implement it now.",
          "Implement the most elegant and long-term production-ready solution end-to-end.",
          "Test as much as possible without destructive actions, and state what could not be verified locally.",
          "",
          `Proposal: ${JSON.stringify(outputs.propose)}`,
        ].join("\n"),
      expectedOutput: `{ "implemented": true, "summary": "what was built", "tested": "what was verified", "untested": "what still needs verification" }`,
    }),
    reconcile: agent({
      prompt: ({ outputs }) =>
        [
          "The proposal and the holy grail differ.",
          "Explain the gap and propose the pragmatic path: what to build now and how it evolves toward the holy grail.",
          "",
          `Proposal: ${JSON.stringify(outputs.propose)}`,
          `Holy grail: ${JSON.stringify(outputs.holy_grail)}`,
        ].join("\n"),
      expectedOutput: `{ "gap": "how they differ", "path": "what to build now and how it evolves" }`,
    }),
    review: checkpoint({
      summary: "human decides between proposal and holy grail path",
      run: ({ outputs }) => outputs.reconcile,
    }),
  },
  edges: [
    { from: "propose", to: "holy_grail" },
    { from: "holy_grail", to: "compare" },
    decisionEdge({
      from: "compare",
      choices: sameChoices,
      cases: {
        y: "implement",
        n: "reconcile",
      },
    }),
    { from: "reconcile", to: "review" },
  ],
});
