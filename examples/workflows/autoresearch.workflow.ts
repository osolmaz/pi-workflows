import { agent, compute, decision, decisionEdge, defineWorkflow } from "pi-workflows";

type AutoresearchInput = {
  /** What to search for, e.g. "a feature separating group A from group B". */
  goal?: string;
  /** Loop directory for the three artifacts; created if missing. */
  dir?: string;
};

const assessChoices = ["continue", "plateau", "dead_end"] as const;

/**
 * An iterative feature-search loop in the style of karpathy/autoresearch.
 * The discipline lives in three artifacts kept in one directory: a harness
 * that never changes during the search, a single feature file that changes
 * every experiment, and a journal that records every run whether it worked
 * or not. Each loop iteration is one generation of candidates; the assess
 * decision keeps looping until a kept result plateaus or a diverse
 * generation all fails.
 */
export default defineWorkflow({
  name: "autoresearch",
  title: ({ input }) => {
    const goal = (input as AutoresearchInput).goal;
    return goal ? `autoresearch: ${goal.slice(0, 60)}` : undefined;
  },
  presentationPrompt:
    "Report the research conclusion in plain language: the winner and its numbers, or the strongest negative result, plus the journal path.",
  maxSteps: 40,
  startAt: "setup",
  nodes: {
    setup: agent({
      timeoutMs: 20 * 60_000,
      statusDetail: "setting up harness",
      prompt: ({ input }) => {
        const { goal, dir } = input as AutoresearchInput;
        return [
          `Set up an autoresearch loop for: ${goal ?? "the research goal discussed so far in this conversation"}.`,
          `Create the loop directory (${dir ?? "pick a sensible project-local directory"}) with three artifacts:`,
          "",
          "1. A harness that is FROZEN after the first run. It loads the dataset",
          "   once, calls the candidate feature on every item, and prints the",
          "   metrics that decide keep-or-discard (for a two-group separation:",
          "   AUC, edge margin, and leave-one-out accuracy with a refit",
          "   threshold). Held-out items are printed but never used for selection.",
          "2. A feature file with one function of a fixed signature. This is the",
          "   ONLY file that changes between experiments; state the input",
          "   contract in its docstring.",
          "3. A program.md recording the goal, the input contract, what is in",
          "   and out of bounds, the keep criterion, and the rule that every run",
          "   is journaled. Start an empty journal file next to it.",
          "",
          "Run the harness once on a trivial baseline feature to prove the",
          "plumbing works, then journal that baseline as experiment 0.",
        ].join("\n");
      },
      expectedOutput: `{ "dir": "loop directory", "keepCriterion": "what counts as a keeper", "baseline": "baseline numbers" }`,
    }),
    experiment: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "running experiments",
      prompt: ({ outputs }) =>
        [
          "Run the next generation of experiments in the loop directory.",
          "",
          "One experiment is one edit to the feature file followed by one",
          "harness run. Batch cheap candidates: when testing many ideas in one",
          "generation, evaluate them all in one sweep process. The harness",
          "stays frozen; if a bug forces a change, rerun every kept result and",
          "journal the change.",
          "",
          "Decide the next edit from what the numbers said, not the original",
          "plan. Chase the failure case closest to the boundary. Vary the",
          "current winner before trusting it: a result that survives only one",
          "parameterization is a tuned cliff, a plateau across neighboring",
          "parameters is a finding. Never select on held-out items.",
          "",
          "Journal every candidate — negatives with the same care as",
          "positives — as: idea in one line, the numbers, keep or discard,",
          "and what to try next.",
          "",
          `Setup: ${JSON.stringify(outputs.setup)}`,
        ].join("\n"),
      expectedOutput: `{ "generation": "what was tried", "best": "best numbers so far", "kept": true | false, "next": "most informative next experiment, if any" }`,
    }),
    assess: decision({
      choices: assessChoices,
      statusDetail: "assessing progress",
      question: ({ outputs }) =>
        [
          "Assess the search after this generation.",
          "",
          "- `continue`: there is an informative next experiment to run.",
          "- `plateau`: a kept result is stable across neighboring parameter",
          "  choices and further edits only trade margin sideways.",
          "- `dead_end`: a generation of diverse candidates all failed, so the",
          "  signal is not where the program said it would be.",
          "",
          `Latest generation: ${JSON.stringify(outputs.experiment)}`,
        ].join("\n"),
    }),
    conclude: agent({
      timeoutMs: 15 * 60_000,
      statusDetail: "writing conclusions",
      prompt: ({ outputs }) =>
        [
          "Finish the journal with a conclusions section: the winning feature",
          "and its numbers (or the strongest negative result), the plateau",
          "evidence, and the negative results that stop future re-litigation.",
          "Only after the journal is complete, promote the winner out of the",
          "loop directory into the real analysis code, if there is one.",
          "",
          `Assessment: ${JSON.stringify(outputs.assess)}`,
          `Latest generation: ${JSON.stringify(outputs.experiment)}`,
        ].join("\n"),
      expectedOutput: `{ "outcome": "plateau" | "dead_end", "winner": "winning feature and numbers, or null", "journal": "path to the finished journal" }`,
    }),
    finalize: compute({
      run: ({ outputs }) => ({
        setup: outputs.setup,
        conclusions: outputs.conclude,
      }),
    }),
  },
  edges: [
    { from: "setup", to: "experiment" },
    { from: "experiment", to: "assess" },
    decisionEdge({
      from: "assess",
      choices: assessChoices,
      cases: {
        continue: "experiment",
        plateau: "conclude",
        dead_end: "conclude",
      },
    }),
    { from: "conclude", to: "finalize" },
  ],
});
