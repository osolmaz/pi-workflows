import { describe, expect, it } from "vitest";
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
import { makeTempDir } from "./helpers.js";

function decisionUi(
  choice: string | undefined,
  input: string | undefined = undefined,
): PiDecisionUi {
  return {
    async custom() {
      return choice;
    },
    async input() {
      return input;
    },
  } as PiDecisionUi;
}

function request() {
  return humanDecisionChannelRequest(
    createHumanDecisionRequest({
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
    }),
  );
}

function longRequest() {
  return humanDecisionChannelRequest(
    createHumanDecisionRequest({
      runId: "run-long",
      workflowName: "workflow-long",
      nodeId: "approve",
      attemptId: "attempt-long",
      contract: {
        audience: "operator",
        choices: defineHumanChoices({ continue: choice({ label: "Continue" }) }),
      },
      prompt: {
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
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  );
}

describe("PiDecisionChannel", () => {
  it("scrolls long presentations without omitting later content", async () => {
    let before: string[] = [];
    let after: string[] = [];
    let renderRequests = 0;
    const ui = {
      async custom(factory: Parameters<PiDecisionUi["custom"]>[0]) {
        return await new Promise<string | undefined>((resolve, reject) => {
          void Promise.resolve(
            factory(
              {
                requestRender() {
                  renderRequests += 1;
                },
              } as never,
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              } as never,
              {} as never,
              (value) => resolve(value as string | undefined),
            ),
          )
            .then((component) => {
              before = component.render(80);
              component.handleInput?.("\u001b[6~");
              after = component.render(80);
              component.handleInput?.("\r");
            })
            .catch(reject);
        });
      },
      async input() {
        return undefined;
      },
    } as PiDecisionUi;
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui,
      store: new HumanDecisionStore(await makeTempDir("pi-decision-scroll")),
      onAnswer: async () => {},
    });
    await channel.deliver(longRequest());
    expect(before.join("\n")).toContain("Readable line 1");
    expect(after.join("\n")).not.toBe(before.join("\n"));
    expect(after.join("\n")).toContain("Readable line 9");
    expect(renderRequests).toBeGreaterThan(0);
  });

  it("shows the complete readable presentation through the custom Pi UI", async () => {
    let lines: string[] = [];
    const ui = {
      async custom(factory: Parameters<PiDecisionUi["custom"]>[0]) {
        return await new Promise<string | undefined>((resolve, reject) => {
          void Promise.resolve(
            factory(
              { requestRender() {} } as never,
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              } as never,
              {} as never,
              (value) => resolve(value as string | undefined),
            ),
          )
            .then((component) => {
              lines = component.render(80);
              component.handleInput?.("\r");
            })
            .catch(reject);
        });
      },
      async input() {
        return undefined;
      },
    } as PiDecisionUi;
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui,
      store: new HumanDecisionStore(await makeTempDir("pi-decision-readable")),
      onAnswer: async (answer) => {
        answers.push(answer);
      },
    });
    await channel.deliver(request());
    const rendered = lines.join("\n");
    expect(rendered).toContain("Approve");
    expect(rendered).toContain("Review the decision details below.");
    expect(rendered).toContain("Decision");
    expect(rendered).toContain("Continue");
    expect(answers[0]?.response).toEqual({ choice: "continue" });
  });

  it("marks an interactive Pi choice as a verified Pi answer", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: decisionUi("continue"),
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
      ui: decisionUi("unknown"),
      store: new HumanDecisionStore(await makeTempDir("pi-decision-unknown")),
      onAnswer: async () => {},
    });
    await expect(channel.deliver(request())).rejects.toThrow(/not in the request/);
  });

  it("records a cancelled Pi selection without submitting an answer", async () => {
    const answers: HumanDecisionChannelAnswer[] = [];
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui: decisionUi(undefined),
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
      ui: decisionUi("replan"),
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
      ui: decisionUi("replan", exact),
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
    let markPromptReady: (() => void) | undefined;
    const promptReady = new Promise<void>((resolve) => {
      markPromptReady = resolve;
    });
    const ui = {
      async custom(factory: Parameters<PiDecisionUi["custom"]>[0]) {
        return await new Promise<string | undefined>((resolve) => {
          factory(
            { requestRender() {} } as never,
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            } as never,
            {} as never,
            (value) => resolve(value as string | undefined),
          );
          markPromptReady?.();
        });
      },
      async input() {
        return undefined;
      },
    } as PiDecisionUi;
    const channel = new PiDecisionChannel({
      actorId: "session-a",
      ui,
      store,
      onAnswer: async () => {},
    });
    const decision = request();
    const delivery = channel.deliver(decision);
    await promptReady;
    const accepted = {
      schema: "pi-workflows.human-decision-accepted.v1" as const,
      provenance: "human" as const,
      decisionId: decision.decisionId,
      requestDigest: decision.requestDigest,
      response: { choice: "continue" },
      source: { channel: "telegram:approval", actorId: "person", eventId: "event" },
      idempotencyKey: "event",
      acceptedAt: "2026-08-19T00:01:00.000Z",
      answerDigest: `sha256:${"a".repeat(64)}`,
    };
    await Promise.all([channel.settle(accepted), channel.settle(accepted)]);
    await expect(delivery).resolves.toMatchObject({
      status: "failed",
      errorCode: "pi_selection_settled_elsewhere",
    });
    await channel.settle(accepted);
    expect(await store.listSettlements(decision.decisionId, "pi")).toHaveLength(1);
  });
});
