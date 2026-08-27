import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@osolmaz/pi-workflows": new URL("./src/workflows/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    // These files launch real Pi subprocesses. Serialize them so several Pi
    // sessions do not compete for limited CPU on small CI runners.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
