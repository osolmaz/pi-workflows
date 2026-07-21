import { agent, checkpoint, decision, decisionEdge, defineWorkflow } from "pi-workflows";

type BranchInput = {
  task?: string;
};

const classifyChoices = ["continue", "checkpoint"] as const;

/**
 * decision() + decisionEdge() constrained-choice classification, then a
 * deterministic branch. Analogous to the acpx branch example.
 */
export default defineWorkflow({
  name: "branch",
  presentationPrompt: ({ state }) =>
    state.status === "waiting"
      ? "Explain briefly why the task needs clarification, then ask the user one concrete clarification question."
      : "Tell the user in one concise sentence how the workflow recommends proceeding.",
  startAt: "classify",
  nodes: {
    classify: decision({
      choices: classifyChoices,
      question: ({ input }) => {
        const task =
          (input as BranchInput).task ??
          "Investigate a flaky test and decide whether the request is clear enough to continue.";
        return [
          "Read the task below.",
          "Pick `continue` if it is concrete and scoped.",
          "Pick `checkpoint` if it is ambiguous or needs clarification.",
          "",
          `Task: ${task}`,
        ].join("\n");
      },
    }),
    continue_lane: agent({
      prompt: ({ outputs }) =>
        [
          "We are on the continue path.",
          `Decision: ${JSON.stringify(outputs.classify)}`,
          "Summarize in one sentence how you would proceed.",
        ].join("\n"),
      expectedOutput: `{ "summary": "short explanation" }`,
    }),
    checkpoint_lane: checkpoint({
      summary: "needs clarification",
      run: ({ outputs }) => ({
        route: "checkpoint",
        summary: (outputs.classify as { reason?: string }).reason ?? "Needs clarification.",
      }),
    }),
  },
  edges: [
    decisionEdge({
      from: "classify",
      choices: classifyChoices,
      cases: {
        continue: "continue_lane",
        checkpoint: "checkpoint_lane",
      },
    }),
  ],
});
