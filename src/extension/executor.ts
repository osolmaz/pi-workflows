import type {
  AgentStepExecutor,
  AgentStepRequest,
  AgentStepSubmission,
} from "../workflows/types.js";

export type SubmissionResult =
  | { accepted: true; message: string }
  | { accepted: false; message: string };

export type PromptDelivery = {
  prompt: string;
  /** True when the agent is known to be mid-run, so delivery must be queued. */
  streaming: boolean;
};

export type ConversationStepExecutorOptions = {
  /** Deliver a prompt into the pi conversation. */
  sendPrompt: (delivery: PromptDelivery) => void;
  /** Reminders sent when the agent settles without submitting. Default 2. */
  maxNudges?: number;
};

type PendingStep = {
  request: AgentStepRequest;
  resolve: (submission: AgentStepSubmission) => void;
  reject: (error: unknown) => void;
  nudgesSent: number;
  cleanup: () => void;
};

const DEFAULT_MAX_NUDGES = 2;

/**
 * AgentStepExecutor that runs steps inside the current pi conversation. The
 * engine hands it a prompt; it delivers the prompt as a user message and
 * resolves once the model submits an accepted output through the `workflow`
 * tool. If the agent settles without submitting, it nudges the model a
 * bounded number of times before failing the step.
 */
export class ConversationStepExecutor implements AgentStepExecutor {
  private readonly sendPrompt: (delivery: PromptDelivery) => void;
  private readonly maxNudges: number;
  private pending: PendingStep | null = null;
  private streaming = false;

  constructor(options: ConversationStepExecutorOptions) {
    this.sendPrompt = options.sendPrompt;
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES;
  }

  /** Track agent streaming state (wire to agent_start / agent_settled). */
  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
  }

  get pendingStepId(): string | null {
    return this.pending?.request.contract.nodeId ?? null;
  }

  async runAgentStep(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepSubmission> {
    if (this.pending) {
      throw new Error("Another workflow step is already awaiting output");
    }
    return await new Promise<AgentStepSubmission>((resolve, reject) => {
      const onAbort = () => {
        const reason: unknown = signal.reason ?? new Error("Workflow step aborted");
        this.clearPending();
        reject(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        request,
        resolve,
        reject,
        nudgesSent: 0,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      this.sendPrompt({ prompt: request.prompt, streaming: this.streaming });
    });
  }

  /** Called by the `workflow` tool when the model submits a step output. */
  async submit(stepId: string, output: unknown): Promise<SubmissionResult> {
    const pending = this.pending;
    if (!pending) {
      return {
        accepted: false,
        message:
          "No workflow step is awaiting output. Do not call the workflow tool outside an active workflow step.",
      };
    }
    const expected = pending.request.contract.nodeId;
    if (stepId !== expected) {
      return {
        accepted: false,
        message: `Wrong step id ${JSON.stringify(stepId)}; the pending step is ${JSON.stringify(expected)}.`,
      };
    }
    const result = await pending.request.accept(output);
    if (!result.ok) {
      return {
        accepted: false,
        message: `Output rejected for step ${JSON.stringify(stepId)}: ${result.error}`,
      };
    }
    this.clearPending();
    pending.resolve({ output: result.value });
    return {
      accepted: true,
      message: [
        `Output accepted for step ${JSON.stringify(stepId)}.`,
        "If the workflow continues, the next step arrives as a new user message. End your turn now.",
      ].join(" "),
    };
  }

  /**
   * Called when the agent settles. Returns true when a nudge was sent, false
   * when there was nothing to do. Fails the pending step once the nudge
   * budget is exhausted.
   */
  handleAgentSettled(): boolean {
    const pending = this.pending;
    if (!pending) {
      return false;
    }
    if (pending.nudgesSent >= this.maxNudges) {
      this.clearPending();
      pending.reject(
        new Error(
          `Agent settled ${pending.nudgesSent + 1} times without submitting step ${JSON.stringify(
            pending.request.contract.nodeId,
          )} via the workflow tool`,
        ),
      );
      return false;
    }
    pending.nudgesSent += 1;
    this.sendPrompt({
      prompt: [
        `Reminder: workflow step ${JSON.stringify(pending.request.contract.nodeId)} is still awaiting your output.`,
        "Complete it by calling the `workflow` tool with:",
        `{"step": ${JSON.stringify(pending.request.contract.nodeId)}, "output": <your result>}`,
        `Expected output: ${pending.request.contract.expectedOutput ?? "a JSON object with your result"}`,
      ].join("\n"),
      streaming: this.streaming,
    });
    return true;
  }

  private clearPending(): void {
    this.pending?.cleanup();
    this.pending = null;
  }
}
