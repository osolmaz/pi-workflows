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
  /** Resolves when this step stops being the pending step. */
  cleared: Promise<void>;
  markCleared: () => void;
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
  private heldByUser = false;

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

  /**
   * Hold the pending step for the user: no nudges are sent while held, so an
   * escape-interrupted conversation stays quiet until the user resumes.
   */
  hold(): void {
    this.heldByUser = true;
  }

  get held(): boolean {
    return this.heldByUser;
  }

  /**
   * Release a user hold. When a step is still pending, its prompt is
   * re-delivered so the model picks the step back up.
   */
  release(): void {
    if (!this.heldByUser) {
      return;
    }
    this.heldByUser = false;
    const pending = this.pending;
    if (!pending) {
      return;
    }
    try {
      this.sendPrompt({ prompt: pending.request.prompt, streaming: this.streaming });
    } catch (error) {
      this.clearPending();
      pending.reject(error);
    }
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
      let markCleared!: () => void;
      const cleared = new Promise<void>((resolveCleared) => {
        markCleared = resolveCleared;
      });
      this.pending = {
        request,
        resolve,
        reject,
        nudgesSent: 0,
        cleanup: () => signal.removeEventListener("abort", onAbort),
        cleared,
        markCleared,
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        this.sendPrompt({ prompt: request.prompt, streaming: this.streaming });
      } catch (error) {
        // A failed delivery must not leave the step installed, or every
        // subsequent agent node would fail with "already awaiting output".
        this.clearPending();
        reject(error);
      }
    });
  }

  /** Called by the `workflow` tool when the model submits a step output. */
  async submit(stepId: string, attemptId: string, output: unknown): Promise<SubmissionResult> {
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
    // Loops revisit the same node id, so a delayed duplicate submission from
    // an earlier attempt would otherwise be accepted as this attempt's output.
    const expectedAttempt = pending.request.contract.attemptId;
    if (attemptId !== expectedAttempt) {
      return {
        accepted: false,
        message: `Stale attempt id ${JSON.stringify(attemptId)} for step ${JSON.stringify(
          stepId,
        )}; the pending attempt is ${JSON.stringify(expectedAttempt)}. Use the attempt id from the latest step contract.`,
      };
    }
    // Race validation against the step being cleared: a hung `validate`
    // callback must not leave this tool call (and therefore pi) blocked after
    // a timeout or cancel already resolved the run.
    const result = await Promise.race([
      pending.request.accept(output),
      pending.cleared.then(() => null),
    ]);
    // The step may have timed out or been cancelled (and a newer step
    // installed) while validation was awaited; a stale submission must not
    // clear or resolve the newer pending step.
    if (result === null || this.pending !== pending) {
      return {
        accepted: false,
        message: `Step ${JSON.stringify(stepId)} is no longer awaiting output.`,
      };
    }
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
    if (this.heldByUser) {
      // The user interrupted deliberately; reminding the model now would
      // steal the conversation back. The step waits for an explicit resume.
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
    const { nodeId, attemptId } = pending.request.contract;
    try {
      this.sendPrompt({
        prompt: [
          `Reminder: workflow step ${JSON.stringify(nodeId)} is still awaiting your output.`,
          "Complete it by calling the `workflow` tool with:",
          `{"step": ${JSON.stringify(nodeId)}, "attempt": ${JSON.stringify(attemptId)}, "output": <your result>}`,
          `Expected output: ${pending.request.contract.expectedOutput ?? "a JSON object with your result"}`,
        ].join("\n"),
        streaming: this.streaming,
      });
    } catch (error) {
      // No reminder turn was started, so nothing would settle the step; fail
      // it promptly instead of waiting out the node timeout.
      this.clearPending();
      pending.reject(error);
      return false;
    }
    return true;
  }

  private clearPending(): void {
    this.pending?.cleanup();
    this.pending?.markCleared();
    this.pending = null;
  }
}
