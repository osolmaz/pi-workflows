import { readFileSync } from "node:fs";
import path from "node:path";
import {
  agent,
  compute,
  controlLoop,
  defineWorkflow,
  type WorkflowNodeContext,
} from "@osolmaz/pi-workflows";

type ControlRoute = "work" | "recover" | "complete";

type Observation = {
  route: ControlRoute;
  reason: string;
};

function commandStopped(directory: string): boolean {
  const pid = Number(readFileSync(path.join(directory, "live-timeout-command.pid"), "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid test command PID");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  return false;
}

function observe(context: WorkflowNodeContext): Observation {
  const recovered = context.state.steps.some(
    (step) => step.nodeId === "recover" && step.outcome === "ok",
  );
  if (recovered) return { route: "complete", reason: "Recovery passed." };
  const timedOut = context.state.steps.some(
    (step) => step.nodeId === "work" && step.outcome === "timed_out",
  );
  return timedOut
    ? { route: "recover", reason: "The bounded work branch timed out." }
    : { route: "work", reason: "The bounded work branch has not run." };
}

function parseDecision(value: unknown, context: WorkflowNodeContext) {
  const decision = value as { route?: unknown; evidence?: unknown };
  const expected = (context.outputs.observe as Observation).route;
  if (decision?.route !== expected) throw new Error(`Expected control route ${expected}`);
  if (typeof decision.evidence !== "string" || decision.evidence.trim().length === 0)
    throw new Error("Control decision evidence is required");
  return { route: expected, evidence: decision.evidence.trim() };
}

const loop = controlLoop({
  decide: "decide",
  returnTo: "observe",
  routes: {
    work: { to: "work", returns: ["workResult"] },
    recover: { to: "recover", returns: ["recover"] },
    complete: { to: "finish", terminal: true },
  },
});

export default defineWorkflow({
  name: "live-model-e2e",
  input: (value: unknown) => {
    const input = value as { directory?: unknown };
    if (typeof input?.directory !== "string" || !path.isAbsolute(input.directory))
      throw new Error("An absolute temporary test directory is required");
    return { directory: input.directory };
  },
  startAt: "prepare",
  nodes: {
    prepare: compute({ run: ({ input }) => input }),
    observe: compute({ run: observe }),
    decide: agent({
      prompt: ({ outputs }) => {
        const observation = outputs.observe as Observation;
        return [
          "This is a control-loop E2E test.",
          `Current observation: ${JSON.stringify(observation)}`,
          `Call workflow submit exactly once with the exact requestId and ${JSON.stringify({ route: observation.route, evidence: observation.reason })}.`,
          "Do not call any other tool.",
        ].join("\n");
      },
      expectedOutput: '{ "route": "work" | "recover" | "complete", "evidence": "fact" }',
      validate: parseDecision,
    }),
    work: agent({
      timeoutMs: 60_000,
      prompt: ({ input }) => {
        const directory = (input as { directory: string }).directory;
        const source = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(directory, "live-timeout-partial.txt"))}, 'saved repair'); fs.writeFileSync(${JSON.stringify(path.join(directory, "live-timeout-command.pid"))}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 180000);`;
        return [
          "This is an intentional timeout and cancellation test in an isolated temporary directory.",
          "Call bash exactly once with the exact JSON arguments below, including timeout: 180 (seconds). Do not use a 10-second or other shorter tool timeout. The command saves partial work and waits. Do not submit a workflow result. The workflow will abort this command after its 60-second active-work deadline and return to the central decision step.",
          JSON.stringify({
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
            timeout: 180,
          }),
        ].join("\n");
      },
    }),
    workResult: compute({ run: () => ({ timedOut: true, savedPartialWork: true }) }),
    recover: agent({
      allowedTools: ["read"],
      prompt: ({ input }) =>
        [
          "The central decision step selected recovery after the prior work branch timed out.",
          "Inspect the saved partial file and command PID in this directory:",
          (input as { directory: string }).directory,
          "Use read to inspect live-timeout-command.pid and live-timeout-partial.txt. Confirm that the partial file contains saved repair. On Linux, a read of /proc/<recorded PID>/stat should report that the file does not exist. Do not restart the process, edit files, or call bash; only read and matching workflow submit/update are allowed.",
          'Then call workflow submit with the exact requestId and { "recovered": true }. The validator independently checks process settlement.',
        ].join("\n"),
      expectedOutput: '{ "recovered": true }',
      validate: (value, { input }) => {
        const directory = (input as { directory: string }).directory;
        if ((value as { recovered?: unknown })?.recovered !== true || !commandStopped(directory))
          throw new Error("The test command has not settled");
        if (
          readFileSync(path.join(directory, "live-timeout-partial.txt"), "utf8") !== "saved repair"
        )
          throw new Error("The partial repair was not preserved");
        return { recovered: true };
      },
    }),
    finish: compute({
      run: ({ state }) => ({
        smoke: "model-passed",
        nonce: "pi-workflows-live-e2e",
        timeoutRecovered: true,
        controlRoutes: state.steps
          .filter((step) => step.nodeId === "decide" && step.outcome === "ok")
          .map((step) => (step.output as { route: ControlRoute }).route),
      }),
    }),
  },
  edges: [
    { from: "prepare", to: "observe" },
    { from: "observe", to: "decide" },
    ...loop.edges,
    { from: "work", switch: { on: "$result.outcome", cases: { timed_out: "workResult" } } },
  ],
});
