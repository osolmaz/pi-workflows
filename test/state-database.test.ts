import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateDatabase, workflowStatePath } from "../src/state/database.js";
import { StateMutationStore, StaleResourceError } from "../src/state/mutation.js";
import { STATE_APPLICATION_ID, STATE_SCHEMA_VERSION } from "../src/state/schema.js";
import { makeTempDir } from "./helpers.js";

const opened: StateDatabase[] = [];

afterEach(() => {
  for (const state of opened.splice(0)) {
    state.close();
  }
});

function open(filePath: string, mode: "read-write" | "read-only" = "read-write"): StateDatabase {
  const state = new StateDatabase({ filePath, mode, checkLegacyState: false });
  opened.push(state);
  return state;
}

describe("StateDatabase", () => {
  it("creates the one strict canonical schema with secure permissions", async () => {
    const home = await makeTempDir("state-schema");
    const filePath = workflowStatePath(home);
    const state = new StateDatabase({ homeDir: home });
    opened.push(state);

    expect(filePath).toBe(path.join(home, ".pi", "agent", "workflows", "state.sqlite"));
    expect(state.connection.pragma("application_id", { simple: true })).toBe(STATE_APPLICATION_ID);
    expect(state.connection.pragma("user_version", { simple: true })).toBe(STATE_SCHEMA_VERSION);
    expect(state.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(state.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(
      state.connection
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE sql LIKE '% STRICT'")
        .get(),
    ).toEqual({ count: 32 });
    state.integrityCheck();
  });

  it("stores canonical JSON and text by content hash", async () => {
    const state = open(path.join(await makeTempDir("state-blobs"), "state.sqlite"));
    const first = state.putJson({ z: 1, a: [true, "x"] });
    const second = state.putJson({ a: [true, "x"], z: 1 });
    const text = state.putText("large text");

    expect(second.equals(first)).toBe(true);
    expect(state.readJson(first)).toEqual({ a: [true, "x"], z: 1 });
    expect(state.readBlob(text)?.content.toString("utf8")).toBe("large text");
    expect(state.connection.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({
      count: 2,
    });
  });

  it("rejects incompatible or changed schemas", async () => {
    const filePath = path.join(await makeTempDir("state-incompatible"), "state.sqlite");
    const state = open(filePath);
    state.close();
    opened.pop();

    const raw = new Database(filePath);
    raw.exec("CREATE TABLE unexpected(value TEXT) STRICT");
    raw.close();

    expect(() => open(filePath)).toThrow(/state is incompatible/i);
  });

  it("uses query-only connections for readers", async () => {
    const filePath = path.join(await makeTempDir("state-reader"), "state.sqlite");
    const writer = open(filePath);
    writer.close();
    opened.pop();
    const reader = open(filePath, "read-only");

    expect(reader.connection.pragma("query_only", { simple: true })).toBe(1);
    expect(() => reader.connection.exec("DELETE FROM blobs")).toThrow();
    expect(() => reader.putText("no")).toThrow(/read-only/);
  });

  it("fails closed when old live stores exist", async () => {
    const home = await makeTempDir("state-old");
    fs.mkdirSync(path.join(home, ".pi", "agent", "workflows", "runs"), { recursive: true });
    expect(() => new StateDatabase({ homeDir: home })).toThrow(/Move or remove the old workflow state/);
  });
});

describe("StateMutationStore", () => {
  it("fences stale owners with generation and revision checks", async () => {
    const state = open(path.join(await makeTempDir("state-mutation"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const resourceId = mutations.ensureResource("run", "run-1", 100);
    const first = mutations.claim({
      resourceId,
      ownerType: "session",
      ownerId: "session-a",
      expectedRevision: 0,
      leaseMs: 10,
      now: 100,
    });
    expect(first?.generation).toBe(1);
    if (first === undefined) throw new Error("claim missing");

    const second = mutations.claim({
      resourceId,
      ownerType: "host",
      ownerId: "host-b",
      expectedRevision: 1,
      leaseMs: 100,
      now: 111,
    });
    expect(second?.generation).toBe(2);
    if (second === undefined) throw new Error("second claim missing");

    expect(() =>
      mutations.mutate(
        {
          resourceId,
          operation: "run.update",
          actor: { type: "session", id: "session-a" },
          expectedRevision: 2,
          lease: first,
        },
        "run.updated",
        () => undefined,
        { now: 112 },
      ),
    ).toThrow(StaleResourceError);

    const accepted = mutations.mutate(
      {
        resourceId,
        operation: "run.update",
        actor: { type: "host", id: "host-b" },
        expectedRevision: 2,
        lease: second,
      },
      "run.updated",
      () => "ok",
      { payload: { status: "running" }, now: 112 },
    );
    expect(accepted).toMatchObject({ value: "ok", revision: 3 });
    expect(state.connection.prepare("SELECT count(*) AS count FROM events").get()).toEqual({
      count: 3,
    });
  });

  it("rolls back the domain write, revision, and event together", async () => {
    const state = open(path.join(await makeTempDir("state-rollback"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const resourceId = mutations.ensureResource("run", "run-2");

    expect(() =>
      mutations.mutate(
        {
          resourceId,
          operation: "run.update",
          actor: { type: "system" },
          expectedRevision: 0,
        },
        "run.updated",
        ({ database }) => {
          database.putText("rolled back");
          throw new Error("failure point");
        },
      ),
    ).toThrow("failure point");

    expect(state.connection.prepare("SELECT revision FROM resources").get()).toEqual({ revision: 0 });
    expect(state.connection.prepare("SELECT count(*) AS count FROM events").get()).toEqual({
      count: 0,
    });
    expect(state.connection.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({
      count: 0,
    });
  });
});
