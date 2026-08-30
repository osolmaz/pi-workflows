import {
  action,
  compute,
  defineWorkflow,
  manualEffect,
  runCommandBatch,
  type CommandBatchRequest,
} from "@osolmaz/pi-workflows";

type Input = {
  cwd: string;
};

export default defineWorkflow({
  name: "command-batch",
  input: (value): Input => value as Input,
  startAt: "prepare",
  nodes: {
    prepare: compute({
      run: ({ input }) =>
        ({
          maxConcurrency: 2,
          items: [
            {
              id: "first",
              command: "printf",
              args: ["%s", "first"],
              cwd: (input as Input).cwd,
              timeoutMs: 10_000,
              maxOutputChars: 10_000,
            },
            {
              id: "second",
              command: "printf",
              args: ["%s", "second"],
              cwd: (input as Input).cwd,
              timeoutMs: 10_000,
              maxOutputChars: 10_000,
            },
          ],
        }) satisfies CommandBatchRequest,
    }),
    run: action({
      effect: manualEffect("example.command-batch.run"),
      run: async (context) =>
        await runCommandBatch(context.outputs.prepare as CommandBatchRequest, {
          signal: context.signal,
        }),
    }),
  },
  edges: [{ from: "prepare", to: "run" }],
});
