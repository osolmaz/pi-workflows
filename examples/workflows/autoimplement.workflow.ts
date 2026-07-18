import { agent, compute, decision, decisionEdge, defineWorkflow } from "pi-workflows";

type AutoimplementInput = {
  task?: string;
};

const reviewChoices = ["clean", "issues_found"] as const;

/**
 * Implement, verify, then loop a self-review until it comes back clean. The
 * decision edge routes `issues_found` back to the fix step, and the engine's
 * maxSteps guard bounds the loop.
 */
export default defineWorkflow({
  name: "autoimplement",
  title: ({ input }) => {
    const task = (input as AutoimplementInput).task;
    return task ? `autoimplement: ${task.slice(0, 60)}` : undefined;
  },
  maxSteps: 20,
  startAt: "implement",
  nodes: {
    implement: agent({
      timeoutMs: 60 * 60_000,
      statusDetail: "implementing",
      prompt: ({ input }) => {
        const task =
          (input as AutoimplementInput).task ?? "the plan discussed so far in this conversation";
        return [
          `Implement ${task} end-to-end.`,
          "Aim for the most elegant, long-term production-ready solution without gold-plating.",
        ].join("\n");
      },
      expectedOutput: `{ "summary": "what was implemented", "files": ["changed file", "changed file"] }`,
    }),
    verify: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "verifying",
      prompt: () =>
        [
          "Verify the implementation.",
          "Run the test suite plus any relevant builds, linters, or local smoke tests.",
          "Do not run destructive commands.",
        ].join("\n"),
      expectedOutput: `{ "passed": true | false, "details": "what was run and what happened" }`,
    }),
    review: decision({
      choices: reviewChoices,
      question: ({ outputs }) =>
        [
          "Critically review your implementation as a strict reviewer.",
          "Look for correctness bugs, missed requirements, and failing checks.",
          "Pick `issues_found` if anything must be fixed, otherwise `clean`.",
          "",
          `Verification: ${JSON.stringify(outputs.verify)}`,
        ].join("\n"),
    }),
    fix: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "fixing",
      prompt: ({ outputs }) =>
        [
          "Fix the issues you found in review, then stop.",
          "",
          `Review: ${JSON.stringify(outputs.review)}`,
        ].join("\n"),
      expectedOutput: `{ "fixed": "what was changed" }`,
    }),
    finalize: compute({
      run: ({ outputs }) => ({
        implementation: outputs.implement,
        verification: outputs.verify,
        review: outputs.review,
      }),
    }),
  },
  edges: [
    { from: "implement", to: "verify" },
    { from: "verify", to: "review" },
    decisionEdge({
      from: "review",
      choices: reviewChoices,
      cases: {
        clean: "finalize",
        issues_found: "fix",
      },
    }),
    { from: "fix", to: "verify" },
  ],
});
