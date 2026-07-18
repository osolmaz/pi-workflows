import { compute, defineWorkflow, shell } from "pi-workflows";

type ShellInput = {
  text?: string;
};

/** One runtime-owned shell action returning structured JSON, no agent step. */
export default defineWorkflow({
  name: "shell",
  startAt: "echo_text",
  nodes: {
    echo_text: shell({
      exec: ({ input }) => ({
        command: "printf",
        args: ["%s", (input as ShellInput).text ?? "hello from pi-workflows"],
        timeoutMs: 10_000,
      }),
      parse: (result) => ({
        stdout: result.stdout,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      }),
    }),
    finalize: compute({
      run: ({ outputs }) => ({
        echoed: (outputs.echo_text as { stdout: string }).stdout,
      }),
    }),
  },
  edges: [{ from: "echo_text", to: "finalize" }],
});
