import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { StateDatabase } from "../src/state/database.js";
import { StateMutationStore } from "../src/state/mutation.js";
import { makeStateDatabasePath } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("SQLite multi-process ownership", () => {
  it("admits one owner across concurrent Node processes", async () => {
    const databasePath = await makeStateDatabasePath("state-process-race");
    const state = new StateDatabase({ filePath: databasePath });
    const resourceId = new StateMutationStore(state).ensureResource("run", "process-race");
    state.close();
    const script = `
      import { StateDatabase } from ${JSON.stringify(new URL("../src/state/database.ts", import.meta.url).pathname)};
      import { StateMutationStore } from ${JSON.stringify(new URL("../src/state/mutation.ts", import.meta.url).pathname)};
      const state = new StateDatabase({ filePath: process.argv[1] });
      try {
        const claim = new StateMutationStore(state).claim({
          resourceId: process.argv[2], ownerType: "host", ownerId: process.argv[3],
          expectedRevision: 0, leaseMs: 60000,
        });
        process.stdout.write(claim === undefined ? "busy" : "won");
      } catch (error) {
        process.stdout.write(error instanceof Error && error.name === "StaleResourceError" ? "stale" : "error");
      } finally {
        state.close();
      }
    `;
    const results = await Promise.all(
      ["host-a", "host-b"].map(
        async (owner) =>
          await execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "--eval",
              script,
              databasePath,
              resourceId,
              owner,
            ],
            { cwd: process.cwd() },
          ),
      ),
    );
    expect(results.map((result) => result.stdout).sort()).toEqual(["stale", "won"]);
    const verified = new StateDatabase({ filePath: databasePath, mode: "read-only" });
    expect(
      verified.connection
        .prepare("SELECT generation, owner_id AS ownerId FROM leases WHERE resource_id = ?")
        .get(resourceId),
    ).toMatchObject({ generation: 1, ownerId: expect.stringMatching(/^host-/) });
    verified.close();
  });
});
