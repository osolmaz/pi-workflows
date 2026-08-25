import { describe, expect, it } from "vitest";
import {
  FollowUpCoordinator,
  findFollowUpEntryId,
  findSettledPresentationEntries,
  followUpMessageText,
} from "../src/extension/follow-up-coordinator.js";
import { agent, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import type { AgentStepRequest, AgentStepSubmission } from "../src/workflows/types.js";
import { ScriptedExecutor, makeStateDatabasePath, waitUntil } from "./helpers.js";

class HeldExecutor extends ScriptedExecutor {
  started = false;
  release: (() => void) | undefined;

  constructor() {
    super();
    this.respond("hold", async (request: AgentStepRequest): Promise<AgentStepSubmission> => {
      this.started = true;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      const accepted = await request.accept({ done: true });
      if (!accepted.ok) throw new Error(accepted.error);
      return { output: accepted.value };
    });
  }
}

const workflow = defineWorkflow({
  name: "follow-up-delivery-test",
  startAt: "hold",
  nodes: { hold: agent({ prompt: () => "Wait." }) },
  edges: [],
});

async function readyFollowUp(databasePath: string, requestId = "follow-1") {
  const executor = new HeldExecutor();
  const running = new WorkflowEngine({ databasePath, executor }).run(workflow, {});
  await waitUntil(() => executor.started);
  const store = new WorkflowRunStore(databasePath);
  const runId = store.listRuns()[0]?.runId as string;
  const queued = store.queueFollowUp({
    runId,
    requestId,
    targetSessionId: "session-1",
    actor: { type: "session", id: "session-1" },
    source: "workflow-tool",
    prompt: "Continue with the next task.",
  });
  executor.release?.();
  await running;
  return { store, runId, followUp: queued.followUp };
}

function fakeContext(branch: Record<string, unknown>[], idle = true) {
  return {
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
  } as never;
}

describe("follow-up delivery", () => {
  it("sends one normal user message and saves branch evidence after settlement", async () => {
    const databasePath = await makeStateDatabasePath("follow-up-coordinator");
    const { store, followUp } = await readyFollowUp(databasePath);
    const branch: Record<string, unknown>[] = [];
    const sent: string[] = [];
    const coordinator = new FollowUpCoordinator(store, "owner-1", (text) => sent.push(text));

    await coordinator.synchronize(fakeContext(branch), false);
    expect(sent).toEqual([followUpMessageText(followUp)]);
    expect(store.readFollowUpQueue(followUp.runId)?.followUps[0]?.state).toBe("ready");
    await coordinator.synchronize(fakeContext(branch), false);
    expect(sent).toHaveLength(1);

    branch.push({
      type: "message",
      id: "user-entry-1",
      message: { role: "user", content: sent[0] },
    });
    await coordinator.synchronize(fakeContext(branch), false);
    expect(store.readFollowUpQueue(followUp.runId)?.followUps[0]).toMatchObject({
      state: "sent",
      sessionEntryId: "user-entry-1",
    });
    store.close();
  });

  it("waits while Pi is busy or another workflow is active", async () => {
    const databasePath = await makeStateDatabasePath("follow-up-wait");
    const { store } = await readyFollowUp(databasePath, "follow-wait");
    const sent: string[] = [];
    const coordinator = new FollowUpCoordinator(store, "owner-wait", (text) => sent.push(text));
    await coordinator.synchronize(fakeContext([], false), false);
    await coordinator.synchronize(fakeContext([], true), true);
    expect(sent).toEqual([]);
    store.close();
  });

  it("releases a claim after a definite send failure", async () => {
    const databasePath = await makeStateDatabasePath("follow-up-send-failure");
    const { store } = await readyFollowUp(databasePath, "follow-failure");
    const failing = new FollowUpCoordinator(store, "owner-fail", () => {
      throw new Error("send failed");
    });
    await expect(failing.synchronize(fakeContext([]), false)).rejects.toThrow(/send failed/);
    const sent: string[] = [];
    const retry = new FollowUpCoordinator(store, "owner-retry", (text) => sent.push(text));
    await retry.synchronize(fakeContext([]), false);
    expect(sent).toHaveLength(1);
    store.close();
  });

  it("finds an already appended message instead of sending it again", async () => {
    const databasePath = await makeStateDatabasePath("follow-up-recovery");
    const { store, followUp } = await readyFollowUp(databasePath, "follow-recovery");
    const branch = [
      {
        type: "message",
        id: "existing-entry",
        message: { role: "user", content: followUpMessageText(followUp) },
      },
    ];
    const sent: string[] = [];
    const coordinator = new FollowUpCoordinator(store, "owner-2", (text) => sent.push(text));
    await coordinator.synchronize(fakeContext(branch), false);
    expect(sent).toEqual([]);
    expect(store.readFollowUpQueue(followUp.runId)?.followUps[0]).toMatchObject({
      state: "sent",
      sessionEntryId: "existing-entry",
    });
    store.close();
  });

  it("ignores unrelated branch entries while finding follow-up IDs", () => {
    const id = `follow-up-${"b".repeat(40)}`;
    expect(
      findFollowUpEntryId(
        [
          null,
          { type: "custom", id: "custom" },
          { type: "message", message: { role: "user", content: "missing id" } },
          { type: "message", id: "tool", message: { role: "toolResult", content: [] } },
          { type: "message", id: "bad-message", message: null },
          { type: "message", id: "image", message: { role: "user", content: 4 } },
          {
            type: "message",
            id: "non-text",
            message: { role: "user", content: [{ type: "image" }] },
          },
        ],
        id,
      ),
    ).toBeUndefined();
  });

  it("finds IDs in string and text-block user messages", () => {
    expect(findFollowUpEntryId([], "missing")).toBeUndefined();
    const id = `follow-up-${"a".repeat(40)}`;
    expect(
      findFollowUpEntryId(
        [
          {
            type: "message",
            id: "entry-1",
            message: {
              role: "user",
              content: [{ type: "text", text: `<!-- pi-workflows-follow-up:${id} -->` }],
            },
          },
        ],
        id,
      ),
    ).toBe("entry-1");
  });

  it("finds a settled presentation from documented session entries", () => {
    expect(findSettledPresentationEntries([], "run-1")).toBeUndefined();
    expect(
      findSettledPresentationEntries(
        [
          {
            type: "custom_message",
            id: "wrong-run",
            customType: "pi-workflows-presentation",
            details: { runId: "other" },
          },
          {
            type: "custom_message",
            id: "no-details",
            customType: "pi-workflows-presentation",
          },
        ],
        "run-1",
      ),
    ).toBeUndefined();
    expect(
      findSettledPresentationEntries(
        [
          {
            type: "message",
            id: "presentation-message",
            message: {
              role: "custom",
              customType: "pi-workflows-presentation",
              details: { runId: "run-2" },
            },
          },
          { type: "message", id: "pending", message: { role: "assistant", stopReason: "pending" } },
          {
            type: "message",
            id: "assistant-2",
            message: { role: "assistant", stopReason: "stop" },
          },
        ],
        "run-2",
      ),
    ).toEqual({ presentationEntryId: "presentation-message", assistantEntryId: "assistant-2" });
    expect(
      findSettledPresentationEntries(
        [
          {
            type: "custom_message",
            id: "presentation-1",
            customType: "pi-workflows-presentation",
            details: { runId: "run-1" },
          },
          {
            type: "message",
            id: "assistant-1",
            message: { role: "assistant", stopReason: "stop", content: [] },
          },
        ],
        "run-1",
      ),
    ).toEqual({ presentationEntryId: "presentation-1", assistantEntryId: "assistant-1" });
  });
});
