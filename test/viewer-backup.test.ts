import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateDatabase } from "../src/state/database.js";
import { verifyInactiveBackup } from "../src/viewer/backup.js";
import { makeTempDir } from "./helpers.js";

describe("inactive backup verification", () => {
  it("rejects another path to the active database", async () => {
    const directory = await makeTempDir("backup-active-alias");
    const active = path.join(directory, "state.sqlite");
    const alias = path.join(directory, "state-alias.sqlite");
    const state = new StateDatabase({ filePath: active });
    state.close();
    fs.symlinkSync(active, alias);

    expect(() => verifyInactiveBackup(alias, active)).toThrow(/Active workflow state/);
  });

  it("accepts a valid inactive backup", async () => {
    const directory = await makeTempDir("backup-inactive");
    const active = path.join(directory, "state.sqlite");
    const backup = path.join(directory, "backup.sqlite");
    const state = new StateDatabase({ filePath: active });
    await state.backup(backup);
    state.close();

    expect(() => verifyInactiveBackup(backup, active)).not.toThrow();
  });
});
