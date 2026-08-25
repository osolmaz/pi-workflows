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
    ).toEqual({ count: 37 });
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
    raw.pragma("journal_mode = DELETE");
    raw.close();

    const before = fs.readFileSync(filePath);

    expect(() => open(filePath)).toThrow(/state is incompatible/i);
    expect(fs.readFileSync(filePath)).toEqual(before);
    expect(fs.existsSync(`${filePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${filePath}-shm`)).toBe(false);
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

  it("creates and verifies a transaction-safe backup", async () => {
    const dir = await makeTempDir("state-backup");
    const source = open(path.join(dir, "state.sqlite"));
    source.putJson({ saved: true });
    const destination = path.join(dir, "backups", "copy.sqlite");
    await source.backup(destination);
    const copy = open(destination, "read-only");
    copy.integrityCheck();
    expect(copy.connection.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({
      count: 1,
    });
    await expect(source.backup(source.filePath)).rejects.toThrow(/must differ/);
  });

  it("rejects wrong SQLite identities", async () => {
    const filePath = path.join(await makeTempDir("state-identity"), "state.sqlite");
    const state = open(filePath);
    state.close();
    opened.pop();
    const raw = new Database(filePath);
    raw.pragma("application_id = 1");
    raw.close();
    expect(() => open(filePath)).toThrow(/incompatible/);
  });

  it("isolates current state from a frozen prior-path writer", async () => {
    const home = await makeTempDir("state-prior-writer");
    const state = new StateDatabase({ homeDir: home });
    opened.push(state);
    state.putJson({ current: true });
    const priorPath = path.join(home, ".pi", "agent", "workflows", "runs", "old-run");
    fs.mkdirSync(priorPath, { recursive: true });
    fs.writeFileSync(path.join(priorPath, "state.json"), "{}\n", { mode: 0o600 });
    expect(state.connection.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({
      count: 1,
    });
    expect(fs.existsSync(path.join(priorPath, "state.json"))).toBe(true);
  });

  it("fails closed when old live stores exist", async () => {
    const home = await makeTempDir("state-old");
    fs.mkdirSync(path.join(home, ".pi", "agent", "workflows", "runs"), { recursive: true });
    expect(() => new StateDatabase({ homeDir: home })).toThrow(
      /Move or remove the old workflow state/,
    );
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

  it("renews and releases only the current lease", async () => {
    const state = open(path.join(await makeTempDir("state-lease"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const resourceId = mutations.ensureResource("run", "lease-run", 100);
    const claim = mutations.claim({
      resourceId,
      ownerType: "host",
      ownerId: "host-a",
      expectedRevision: 0,
      leaseMs: 100,
      now: 100,
    });
    if (claim === undefined) throw new Error("claim missing");
    expect(
      mutations.claim({
        resourceId,
        ownerType: "host",
        ownerId: "host-b",
        expectedRevision: 1,
        leaseMs: 100,
        now: 101,
      }),
    ).toBeUndefined();
    const renewed = mutations.renew(claim, 1, 200, 110);
    expect(renewed.expiresAt).toBe(310);
    expect(mutations.release(renewed, 2, 120)).toBe(3);
    expect(() => mutations.release(renewed, 3, 121)).toThrow(StaleResourceError);
  });

  it("rejects revision and lease mismatches before mutation", async () => {
    const state = open(path.join(await makeTempDir("state-permit"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const first = mutations.ensureResource("run", "first");
    const second = mutations.ensureResource("run", "second");
    const claim = mutations.claim({
      resourceId: first,
      ownerType: "session",
      ownerId: "session-a",
      expectedRevision: 0,
      leaseMs: 1_000,
    });
    if (claim === undefined) throw new Error("claim missing");
    expect(() =>
      mutations.mutate(
        {
          resourceId: second,
          operation: "run.update",
          actor: { type: "session", id: "session-a" },
          expectedRevision: 0,
          lease: claim,
        },
        "run.updated",
        () => undefined,
      ),
    ).toThrow(/does not belong/);
    expect(() =>
      mutations.mutate(
        {
          resourceId: first,
          operation: "run.update",
          actor: { type: "session", id: "session-a" },
          expectedRevision: 99,
          lease: claim,
        },
        "run.updated",
        () => undefined,
      ),
    ).toThrow(StaleResourceError);
  });

  it("rejects invalid lease durations and stale renewals", async () => {
    const state = open(path.join(await makeTempDir("state-invalid-lease"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const resourceId = mutations.ensureResource("run", "invalid-lease");
    expect(() =>
      mutations.claim({
        resourceId,
        ownerType: "system",
        ownerId: "system",
        expectedRevision: 0,
        leaseMs: 0,
      }),
    ).toThrow(/positive integer/);
    const claim = mutations.claim({
      resourceId,
      ownerType: "system",
      ownerId: "system",
      expectedRevision: 0,
      leaseMs: 60_000,
    });
    if (claim === undefined) throw new Error("claim missing");
    expect(() => mutations.renew(claim, 99, 60_000)).toThrow(StaleResourceError);
    expect(() => mutations.renew({ ...claim, token: "wrong" }, 1, 60_000)).toThrow(
      StaleResourceError,
    );
    expect(() => mutations.release(claim, 99)).toThrow(StaleResourceError);
  });

  it("uses current time defaults for claims and release", async () => {
    const state = open(path.join(await makeTempDir("state-default-time"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const resourceId = mutations.ensureResource("run", "default-time");
    const claim = mutations.claim({
      resourceId,
      ownerType: "system",
      ownerId: "system",
      expectedRevision: 0,
      leaseMs: 60_000,
    });
    if (claim === undefined) throw new Error("claim missing");
    expect(mutations.release(claim, 1)).toBe(2);
  });

  it("accepts an unleased system mutation without payload", async () => {
    const state = open(path.join(await makeTempDir("state-system-mutation"), "state.sqlite"));
    const mutations = new StateMutationStore(state);
    const resourceId = mutations.ensureResource("run", "system-mutation");
    const result = mutations.mutate(
      {
        resourceId,
        operation: "run.observe",
        actor: { type: "system" },
        expectedRevision: 0,
      },
      "run.observed",
      () => "accepted",
    );
    expect(result).toMatchObject({ value: "accepted", revision: 1 });
    expect(() =>
      mutations.claim({
        resourceId,
        ownerType: "system",
        ownerId: "system",
        expectedRevision: 99,
        leaseMs: 60_000,
      }),
    ).toThrow(StaleResourceError);
    expect(() =>
      mutations.mutate(
        {
          resourceId: "missing",
          operation: "run.observe",
          actor: { type: "system" },
          expectedRevision: 0,
        },
        "run.observed",
        () => undefined,
      ),
    ).toThrow(/Unknown resource/);
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

    expect(state.connection.prepare("SELECT revision FROM resources").get()).toEqual({
      revision: 0,
    });
    expect(state.connection.prepare("SELECT count(*) AS count FROM events").get()).toEqual({
      count: 0,
    });
    expect(state.connection.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({
      count: 0,
    });
  });
});
