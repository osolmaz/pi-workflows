// npm lifecycle "prepare" hook. Production installs (npm install --omit=dev,
// which is what `pi install` runs) have no TypeScript toolchain; that is fine
// because pi loads the extension from src via jiti. Only build when tsc is
// actually available (dev installs, npm link, publishing).
import { spawnSync } from "node:child_process";

try {
  const { createRequire } = await import("node:module");
  createRequire(import.meta.url).resolve("typescript");
} catch {
  console.warn("pi-workflows: skipping build (typescript not installed; pi loads src directly)");
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
