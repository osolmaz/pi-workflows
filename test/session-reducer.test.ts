import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  reduceSessionEvents,
  SessionReplayIndex,
  type TemporalSessionState,
} from "../src/viewer/session-reducer.js";
import type {
  WorkflowSessionEntryRecord,
  WorkflowSessionEventRecord,
} from "../src/workflows/types.js";

type Fixture = {
  schema: string;
  entries: WorkflowSessionEntryRecord[];
  events: WorkflowSessionEventRecord[];
  positions: Array<{ throughSeq: number; expected: TemporalSessionState }>;
};

async function fixtures(): Promise<Fixture[]> {
  const dir = path.resolve("fixtures/session-events");
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).toSorted();
  return await Promise.all(
    names.map(
      async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Fixture,
    ),
  );
}

describe("session event reducer fixtures", () => {
  it("matches every recorded temporal position", async () => {
    for (const fixture of await fixtures()) {
      expect(fixture.schema).toBe("pi-workflows.session-event-fixture.v1");
      for (const position of fixture.positions) {
        expect(reduceSessionEvents(fixture.entries, fixture.events, position.throughSeq)).toEqual(
          position.expected,
        );
      }
    }
  });

  it("seeks through viewer-only checkpoints and timestamps", async () => {
    const fixture = (await fixtures()).find(({ events }) => events.length > 5)!;
    const index = new SessionReplayIndex(fixture.entries, fixture.events, 2);
    for (const position of fixture.positions) {
      expect(index.stateAtSeq(position.throughSeq)).toEqual(position.expected);
    }
    const event = fixture.events[4]!;
    expect(index.seqAtOrBefore(Date.parse(event.at))).toBe(event.seq);
    expect(index.seqAtOrBefore(Date.parse(fixture.events[0]!.at) - 1)).toBe(0);
  });

  it("reports sequence and reconciliation errors without discarding final content", () => {
    const entries: WorkflowSessionEntryRecord[] = [
      { seq: 1, at: "now", entry: { id: "e1", type: "message" } },
    ];
    const events: WorkflowSessionEventRecord[] = [
      {
        seq: 2,
        at: "now",
        nodeId: "n",
        attemptId: "a",
        turnId: "t",
        messageId: "m",
        type: "message_started",
        payload: { role: "assistant" },
      },
      {
        seq: 3,
        at: "now",
        nodeId: "n",
        attemptId: "a",
        turnId: "t",
        messageId: "m",
        type: "assistant_event",
        payload: { type: "text_start", contentIndex: 0 },
      },
      {
        seq: 4,
        at: "now",
        nodeId: "n",
        attemptId: "a",
        turnId: "t",
        messageId: "m",
        type: "assistant_event",
        payload: { type: "text_end", contentIndex: 0, content: "b" },
      },
      {
        seq: 5,
        at: "now",
        nodeId: "n",
        attemptId: "a",
        turnId: "t",
        messageId: "m",
        type: "message_finished",
        payload: { role: "assistant", settled: true, entryId: "e1" },
      },
    ];
    const state = reduceSessionEvents(entries, events);
    expect(state.messages[0]?.blocks[0]?.text).toBe("b");
    expect(state.settledEntryIds).toEqual(["e1"]);
    expect(state.diagnostics).toEqual(["session event sequence gap at 1"]);
  });
});
