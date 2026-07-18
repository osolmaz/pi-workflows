import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "pi-workflows": new URL("./src/workflows/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
