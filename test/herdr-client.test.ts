import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPiwVersion,
  findOnPath,
  inspectPiwClient,
  installHint,
  isExecutableFile,
  parsePiwVersion,
  pathEntries,
  piwBinaryNames,
  piwPackageBinaryPath,
  piwPackageVersion,
  piwPaneEnvironment,
  piwPlatformPackageName,
  readPiwVersion,
} from "../src/herdr/client.js";
import { makeTempDir } from "./helpers.js";

const packageVersion = piwPackageVersion();
if (packageVersion === undefined) {
  throw new Error("the installed pi-workflows package version must be readable");
}

async function writeCommand(directory: string, name: string, source: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await fs.writeFile(file, source);
  await fs.chmod(file, 0o755);
  return file;
}

async function writeFakePiw(directory: string, version: string): Promise<string> {
  return await writeCommand(
    directory,
    "piw",
    `#!/usr/bin/env node\nprocess.stdout.write("piw ${version}\\n");\n`,
  );
}

async function makeClientRoot(prefix: string, version = packageVersion): Promise<string> {
  const root = await makeTempDir(prefix);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

function clientOptions(root: string, env: NodeJS.ProcessEnv) {
  return { env, packageRoot: root, platform: "linux" as const, arch: "x64" };
}

describe("piw client resolution", () => {
  it("prefers an explicit PIW_BIN and reports where it came from", async () => {
    const root = await makeClientRoot("piw-client-explicit");
    const explicit = await writeFakePiw(path.join(root, "explicit"), packageVersion);

    const inspection = inspectPiwClient(clientOptions(root, { PIW_BIN: explicit, PATH: "" }));

    expect(inspection).toEqual({
      ok: true,
      path: explicit,
      source: "PIW_BIN",
      version: packageVersion,
      expectedVersion: packageVersion,
    });
  });

  it("refuses an unusable PIW_BIN instead of falling back to PATH", async () => {
    const root = await makeClientRoot("piw-client-unusable");
    const onPath = await writeFakePiw(path.join(root, "on-path"), packageVersion);
    const absent = path.join(root, "absent", "piw");

    const inspection = inspectPiwClient(
      clientOptions(root, { PIW_BIN: absent, PATH: path.dirname(onPath) }),
    );

    expect(inspection.ok).toBe(false);
    expect(inspection.ok === false && inspection.kind).toBe("missing");
    expect(inspection.ok === false && inspection.message).toContain(
      `PIW_BIN points at ${absent}, which is not an executable file.`,
    );
    expect(inspection.ok === false && inspection.message).toContain(installHint(packageVersion));
  });

  it("uses the package-local binary when a platform package is installed", async () => {
    const root = await makeClientRoot("piw-client-package");
    const local = await writeFakePiw(
      path.join(root, "node_modules", "@osolmaz", "piw-linux-x64", "bin"),
      packageVersion,
    );

    const inspection = inspectPiwClient(clientOptions(root, { PATH: "" }));

    expect(inspection).toEqual({
      ok: true,
      path: local,
      source: "package",
      version: packageVersion,
      expectedVersion: packageVersion,
    });
  });

  it("falls back to the first usable piw on PATH", async () => {
    const root = await makeClientRoot("piw-client-path");
    const first = path.join(root, "first");
    await fs.mkdir(path.join(first, "piw"), { recursive: true });
    const second = await writeFakePiw(path.join(root, "second"), packageVersion);

    const inspection = inspectPiwClient(
      clientOptions(root, { PATH: [first, path.join(root, "second")].join(path.delimiter) }),
    );

    expect(inspection.ok && inspection.source).toBe("PATH");
    expect(inspection.ok && inspection.path).toBe(second);
  });

  it("names every location it tried when no client exists", async () => {
    const root = await makeClientRoot("piw-client-missing");
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);

    const inspection = inspectPiwClient(clientOptions(root, { PATH: empty }));

    expect(inspection.ok).toBe(false);
    expect(inspection.ok === false && inspection.kind).toBe("missing");
    const message = inspection.ok === false ? inspection.message : "";
    expect(message).toContain(path.join(root, "node_modules", "@osolmaz", "piw-linux-x64", "bin"));
    expect(message).toContain(empty);
    expect(message).toContain(installHint(packageVersion));
  });

  it("reports a package whose version cannot be read", async () => {
    const root = await makeTempDir("piw-client-unversioned");

    const inspection = inspectPiwClient(clientOptions(root, { PATH: "" }));

    expect(inspection.ok).toBe(false);
    expect(inspection.ok === false && inspection.message).toContain("no readable version");
  });
});

describe("piw client versions", () => {
  it("parses the versions that clients print", () => {
    expect(parsePiwVersion("piw 0.17.4\n")).toBe("0.17.4");
    expect(parsePiwVersion("piw\t0.17.4")).toBe("0.17.4");
    expect(parsePiwVersion("0.17.4")).toBe("0.17.4");
    expect(parsePiwVersion("v0.17.4\n")).toBe("0.17.4");
    expect(parsePiwVersion("piw 0.17.4-dev.1")).toBe("0.17.4-dev.1");
    expect(parsePiwVersion("piw 0.17.4+build.5")).toBe("0.17.4+build.5");
    expect(parsePiwVersion("piw unknown")).toBeUndefined();
    expect(parsePiwVersion("")).toBeUndefined();
    expect(parsePiwVersion(undefined)).toBeUndefined();
  });

  it("accepts a matching client and rejects a mismatch with both versions", () => {
    expect(checkPiwVersion("0.17.4", "0.17.4", "/bin/piw")).toEqual({
      compatible: true,
      version: "0.17.4",
    });

    const mismatch = checkPiwVersion("0.16.8", "0.17.4", "/bin/piw");
    expect(mismatch.compatible).toBe(false);
    const reason = mismatch.compatible === false ? mismatch.reason : "";
    expect(reason).toContain("0.16.8");
    expect(reason).toContain("0.17.4");
    expect(reason).toContain("/bin/piw");
    expect(reason).toContain(installHint("0.17.4"));

    const unparseable = checkPiwVersion(undefined, "0.17.4", "/bin/piw");
    expect(unparseable.compatible).toBe(false);
    expect(unparseable.compatible === false && unparseable.reason).toContain(
      "did not report a parseable version",
    );
    expect(unparseable.compatible === false && unparseable.reason).toContain(installHint("0.17.4"));
  });

  it("reads the version a client prints and tolerates a client that fails", async () => {
    const root = await makeTempDir("piw-client-version");
    const client = await writeFakePiw(root, packageVersion);
    const broken = await writeCommand(root, "broken-piw", "process.exit(3);\n");
    const silent = await writeCommand(
      root,
      "silent-piw",
      'process.stdout.write("piw unknown\\n");\n',
    );

    expect(readPiwVersion(client)).toBe(packageVersion);
    expect(readPiwVersion(broken)).toBeUndefined();
    expect(readPiwVersion(silent)).toBeUndefined();
    expect(readPiwVersion(path.join(root, "absent"))).toBeUndefined();
  });

  it("reads the version of the installed package", async () => {
    const root = await makeTempDir("piw-client-package-version");
    await fs.writeFile(path.join(root, "package.json"), `{"version":"1.2.3"}`);
    expect(piwPackageVersion(root)).toBe("1.2.3");

    const missing = await makeTempDir("piw-client-package-absent");
    expect(piwPackageVersion(missing)).toBeUndefined();
  });
});

describe("piw client paths", () => {
  it("names platform packages only for supported platforms", () => {
    expect(piwPlatformPackageName("linux", "x64")).toBe("@osolmaz/piw-linux-x64");
    expect(piwPlatformPackageName("darwin", "arm64")).toBe("@osolmaz/piw-macos-arm64");
    expect(piwPlatformPackageName("win32", "x64")).toBe("@osolmaz/piw-windows-x64");
    expect(piwPlatformPackageName("freebsd", "x64")).toBeUndefined();

    expect(piwBinaryNames("win32")).toEqual(["piw.exe", "piw"]);
    expect(piwBinaryNames("linux")).toEqual(["piw"]);
  });

  it("builds the package-local binary path", () => {
    expect(piwPackageBinaryPath("/pkg", "linux", "arm64")).toBe(
      path.join("/pkg", "node_modules", "@osolmaz", "piw-linux-arm64", "bin", "piw"),
    );
    expect(piwPackageBinaryPath("/pkg", "win32", "x64")).toBe(
      path.join("/pkg", "node_modules", "@osolmaz", "piw-windows-x64", "bin", "piw.exe"),
    );
    expect(piwPackageBinaryPath("/pkg", "freebsd", "x64")).toBeUndefined();
  });

  it("finds executables on PATH and ignores empty entries", async () => {
    const root = await makeTempDir("piw-client-search");
    const bin = await writeFakePiw(path.join(root, "bin"), packageVersion);
    const env = { PATH: ["", path.dirname(bin), ""].join(path.delimiter) };

    expect(pathEntries(env)).toEqual([path.dirname(bin)]);
    expect(findOnPath("piw", env)).toBe(bin);
    expect(findOnPath("absent-piw", env)).toBeUndefined();
    expect(pathEntries({})).toEqual([]);
  });

  it("accepts only executable files", async () => {
    const root = await makeTempDir("piw-client-executable");
    const executable = await writeFakePiw(root, packageVersion);
    const plain = path.join(root, "plain");
    await fs.writeFile(plain, "not a program\n");
    const directory = path.join(root, "directory");
    await fs.mkdir(directory);

    expect(isExecutableFile(executable)).toBe(true);
    expect(isExecutableFile(plain)).toBe(false);
    expect(isExecutableFile(directory)).toBe(false);
    expect(isExecutableFile(path.join(root, "absent"))).toBe(false);
  });
});

describe("piw pane environment", () => {
  it("hands the pane an absolute client, no autostart, and the session socket", () => {
    expect(piwPaneEnvironment("/bin/piw")).toEqual(["PIW_BIN=/bin/piw", "PIW_NO_AUTOSTART=1"]);
    expect(piwPaneEnvironment("/bin/piw", "/tmp/session.sock")).toEqual([
      "PIW_BIN=/bin/piw",
      "PIW_NO_AUTOSTART=1",
      "PIW_SOCKET=/tmp/session.sock",
    ]);
    expect(piwPaneEnvironment("/bin/piw", "  ")).toEqual([
      "PIW_BIN=/bin/piw",
      "PIW_NO_AUTOSTART=1",
    ]);
  });
});
