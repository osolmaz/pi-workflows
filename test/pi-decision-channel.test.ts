import { describe, expect, it } from "vitest";
import {
  PiDecisionChannel,
  type HumanDecisionChannelAnswer,
} from "../src/extension/decision-channels.js";
import {
  HumanDecisionStore,
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  textInput,
} from "../src/workflows/human-decision.js";
import { makeTempDir } from "./helpers.js";

function request() {
  return createHumanDecisionRequest({
    runId: "run-a",
    workflowName: "workflow-a",
    nodeId: "approve",
    attemptId: "attempt-a",
    contract: {
      audience: "operator",
      choices: defineHumanChoices({
        continue: choice({ label: "Continue" }),
        replan: choice({
          label: "Replan",
          input: textInput({ name: "instructions", prompt: "What should change?" }),
        }),
      }),
    },
    prompt: { title: "Approve", body: {} },
    createdAt: "2026-08-19T00:00:00.000Z",
  });
}

describe("PiDecisionChannel", () => {
  it("marks an interactive Pi choice as a verified Pi answer", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: {
        async select() {
          return "Continue";
        },
        async input() {
          return undefined;
        },
      },
      store: new HumanDecisionStore(await makeTempDir("pi-decision")),
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    expect((await channel.deliver(request())).status).toBe("confirmed");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      response: { choice: "continue" },
      source: { channel: "pi", actorId: "session-a" },
    });
  });

  it("rejects a Pi selection outside the rendered choice labels", async () => {
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: {
        async select() {
          return "Unknown";
        },
        async input() {
          return undefined;
        },
      },
      store: new HumanDecisionStore(await makeTempDir("pi-decision-unknown")),
      onAnswer: async () => {},
    });
    await expect(channel.deliver(request())).rejects.toThrow(/not in the request/);
  });

  it("records a cancelled Pi selection without submitting an answer", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: {
        async select() {
          return undefined;
        },
        async input() {
          return undefined;
        },
      },
      store: new HumanDecisionStore(await makeTempDir("pi-decision-cancel")),
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    expect((await channel.deliver(request())).errorCode).toBe("pi_selection_cancelled");
    expect(answers).toEqual([]);
  });

  it("records a cancelled Pi text input without submitting an answer", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: {
        async select() {
          return "Replan";
        },
        async input() {
          return undefined;
        },
      },
      store: new HumanDecisionStore(await makeTempDir("pi-decision-input-cancel")),
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    expect((await channel.deliver(request())).errorCode).toBe("pi_input_cancelled");
    expect(answers).toEqual([]);
  });

  it("preserves exact interactive replan text", async () => {
    const exact = "  use option B\nkeep this  ";
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: {
        async select() {
          return "Replan";
        },
        async input() {
          return exact;
        },
      },
      store: new HumanDecisionStore(await makeTempDir("pi-decision-text")),
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    await channel.deliver(request());
    expect(answers[0]?.response).toEqual({
      choice: "replan",
      input: { instructions: exact },
    });
  });

  it("dismisses a pending Pi dialog when another channel settles the decision", async () => {
    const store = new HumanDecisionStore(await makeTempDir("pi-decision-external-settlement"));
    let signal: AbortSignal | undefined;
    let markPromptReady: (() => void) | undefined;
    const promptReady = new Promise<void>((resolve) => {
      markPromptReady = resolve;
    });
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: {
        async select(_title, _options, dialogOptions) {
          signal = dialogOptions?.signal;
          markPromptReady?.();
          return await new Promise<string | undefined>((resolve) => {
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          });
        },
        async input() {
          return undefined;
        },
      },
      store,
      onAnswer: async () => {},
    });
    const decision = request();
    const delivery = channel.deliver(decision);
    await promptReady;
    expect(signal?.aborted).toBe(false);
    const accepted = {
      schema: "pi-workflows.human-decision-accepted.v1" as const,
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      response: { choice: "continue" },
      source: { channel: "telegram:approval", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
      acceptedAt: "2026-08-19T00:01:00.000Z",
      answerDigest: `sha256:${"a".repeat(64)}`,
    };
    await Promise.all([channel.settle(accepted), channel.settle(accepted)]);
    expect(signal?.aborted).toBe(true);
    await expect(delivery).resolves.toMatchObject({
      status: "failed",
      errorCode: "pi_selection_settled_elsewhere",
    });
    await channel.settle(accepted);
    expect(await store.listSettlements(decision.decisionId, "pi")).toHaveLength(1);
  });
});
