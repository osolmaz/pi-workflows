import { describe, expect, it, vi } from "vitest";
import {
  PiDecisionChannel,
  type HumanDecisionChannelAnswer,
  type PiDecisionUi,
} from "../src/extension/decision-channels.js";
import { humanDecisionChannelRequest } from "../src/workflows/decision-presentation.js";
import {
  HumanDecisionStore,
  choice,
  createHumanDecisionRequest,
  defineHumanChoices,
  textInput,
} from "../src/workflows/human-decision.js";
import { decisionPrompt, makeStateDatabasePath, seedHumanDecisionRequest } from "./helpers.js";

function fullRequest(long = false) {
  return createHumanDecisionRequest({
    runId: long ? "run-long" : "run-a",
    workflowName: long ? "workflow-long" : "workflow-a",
    nodeId: "approve",
    attemptId: long ? "attempt-long" : "attempt-a",
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
    prompt: long
      ? {
          title: "Approve long decision",
          subject: { id: "long" },
          presentation: {
            schema: "pi-workflows.decision-presentation.v1",
            summary: "Read every line.",
            blocks: Array.from({ length: 30 }, (_, index) => ({
              kind: "paragraph" as const,
              text: `Readable line ${index + 1}`,
            })),
          },
        }
      : decisionPrompt(),
    createdAt: "2026-08-19T00:00:00.000Z",
  });
}

function ui(choiceValue: string | undefined, inputValue?: string): PiDecisionUi {
  return {
    async custom() {
      return choiceValue;
    },
    async input() {
      return inputValue;
    },
  } as PiDecisionUi;
}

async function fixture(request = fullRequest()) {
  const store = new HumanDecisionStore(await makeStateDatabasePath("pi-decision"));
  await seedHumanDecisionRequest(store, request);
  return store;
}

describe("PiDecisionChannel", () => {
  it("submits a verified answer and records delivery", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui("continue"),
      store,
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    await channel.deliver(humanDecisionChannelRequest(request));
    expect(answers[0]).toMatchObject({ response: { choice: "continue" } });
    expect(await store.listDeliveries(request.decisionId, "pi")).not.toHaveLength(0);
    store.close();
  });

  it("preserves exact text input", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui("replan", "  exact text  "),
      store,
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    await channel.deliver(humanDecisionChannelRequest(request));
    expect(answers[0]?.response).toEqual({
      choice: "replan",
      input: { instructions: "  exact text  " },
    });
    store.close();
  });

  it("reports cancelled text input", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const onAnswer = vi.fn();
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui("replan", undefined),
      store,
      onAnswer,
    });
    expect(await channel.deliver(humanDecisionChannelRequest(request))).toMatchObject({
      status: "failed",
      errorCode: "pi_input_cancelled",
    });
    expect(onAnswer).not.toHaveBeenCalled();
    store.close();
  });

  it("does not submit when the dialog is cancelled", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const onAnswer = vi.fn();
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui(undefined),
      store,
      onAnswer,
    });
    await channel.deliver(humanDecisionChannelRequest(request));
    expect(onAnswer).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects a selection outside the request", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui("missing"),
      store,
      onAnswer: async () => {},
    });
    await expect(channel.deliver(humanDecisionChannelRequest(request))).rejects.toThrow(
      /not in the request/,
    );
    store.close();
  });

  it("dismisses stale input after another actor resolves the decision", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    await store.accept(request, {
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      choice: "continue",
      source: { channel: "telegram-main", actorId: "100", eventId: "callback-1" },
      idempotencyKey: "callback-1",
    });
    const onAnswer = vi.fn();
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui("continue"),
      store,
      onAnswer,
    });
    await channel.deliver(humanDecisionChannelRequest(request));
    expect(onAnswer).not.toHaveBeenCalled();
    store.close();
  });

  it("settles a presentation idempotently", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: ui(undefined),
      store,
      onAnswer: async () => {},
    });
    const cancellation = {
      schema: "pi-workflows.human-decision-cancellation.v1" as const,
      decisionId: request.decisionId,
      requestDigest: request.requestDigest,
      cancelledAt: new Date().toISOString(),
      reason: "cancelled" as const,
    };
    await Promise.all([channel.settle(cancellation), channel.settle(cancellation)]);
    expect(await store.listSettlements(request.decisionId, "pi")).toHaveLength(1);
    store.close();
  });

  it("dismisses an open selection when the channel settles elsewhere", async () => {
    const request = fullRequest();
    const store = await fixture(request);
    const pendingUi = {
      async custom(factory: Parameters<PiDecisionUi["custom"]>[0]) {
        return await new Promise<string | undefined>((resolve) => {
          void Promise.resolve(
            factory(
              { requestRender() {} } as never,
              { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
              {} as never,
              (value) => resolve(value as string | undefined),
            ),
          );
        });
      },
      async input() {
        return undefined;
      },
    } as PiDecisionUi;
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: pendingUi,
      store,
      onAnswer: async () => {},
    });
    const delivery = channel.deliver(humanDecisionChannelRequest(request));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await channel.stop();
    expect(await delivery).toMatchObject({
      status: "failed",
      errorCode: "pi_selection_settled_elsewhere",
    });
    store.close();
  });

  it("renders and scrolls a long presentation", async () => {
    const request = fullRequest(true);
    const store = await fixture(request);
    let before = "";
    let after = "";
    const customUi = {
      async custom(factory: Parameters<PiDecisionUi["custom"]>[0]) {
        return await new Promise<string | undefined>((resolve) => {
          void Promise.resolve(
            factory(
              { requestRender() {} } as never,
              { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
              {} as never,
              (value) => resolve(value as string | undefined),
            ),
          ).then((component) => {
            before = component.render(80).join("\n");
            component.handleInput?.("\u001b[6~");
            after = component.render(80).join("\n");
            component.handleInput?.("\u001b[5~");
            component.handleInput?.("\u001b[B");
            component.handleInput?.("\u001b[A");
            component.handleInput?.("\u001b");
          });
        });
      },
      async input() {
        return undefined;
      },
    } as PiDecisionUi;
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: customUi,
      store,
      onAnswer: async () => {},
    });
    await channel.deliver(humanDecisionChannelRequest(request));
    expect(before).toContain("Readable line 1");
    expect(after).not.toBe(before);
    store.close();
  });
});
