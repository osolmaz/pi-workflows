import { readFileSync } from "node:fs";
import path from "node:path";
import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

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

export default defineWorkflow({
  name: "live-model-e2e",
  input: (value: unknown) => {
    const input = value as { directory?: unknown };
    if (typeof input?.directory !== "string" || !path.isAbsolute(input.directory))
      throw new Error("An absolute temporary test directory is required");
    return { directory: input.directory };
  },
  startAt: "submit",
  nodes: {
    submit: agent({
      prompt: () =>
        'Call the workflow tool exactly once. Use the exact requestId from the appended workflow step contract. Submit this object: { "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }.',
      expectedOutput: '{ "smoke": "model-passed", "nonce": "pi-workflows-live-e2e" }',
    }),
    work: agent({
      timeoutMs: 60_000,
      prompt: ({ input }) => {
        const directory = (input as { directory: string }).directory;
        const source = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(directory, "live-timeout-partial.txt"))}, 'saved repair'); fs.writeFileSync(${JSON.stringify(path.join(directory, "live-timeout-command.pid"))}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 180000);`;
        return [
          "This is an intentional timeout and cancellation test in an isolated temporary directory.",
          "Call bash exactly once with the command below. It saves partial work and waits. Do not submit a workflow result or shorten the wait. The workflow will abort this command and deliver a recovery step.",
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
        ].join("\n");
      },
    }),
    recover: agent({
      prompt: ({ input }) =>
        [
          "The prior test step timed out. Inspect its saved partial file and command PID in this directory:",
          (input as { directory: string }).directory,
          "Confirm that the process recorded in live-timeout-command.pid no longer exists and that live-timeout-partial.txt contains saved repair. Do not restart it or edit either file.",
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
      run: ({ outputs }) => ({ ...(outputs.submit as object), timeoutRecovered: true }),
    }),
  },
  edges: [
    { from: "submit", to: "work" },
    { from: "work", switch: { on: "$result.outcome", cases: { timed_out: "recover" } } },
    { from: "recover", to: "finish" },
  ],
});
