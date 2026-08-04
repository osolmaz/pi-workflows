import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@osolmaz/pi-workflows/controllers",
        replacement: new URL("./src/controllers/index.ts", import.meta.url).pathname,
      },
      {
        find: "@osolmaz/pi-workflows",
        replacement: new URL("./src/workflows/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    coverage: {
      // istanbul instruments through the vitest transform pipeline only, so
      // jiti-compiled copies of workflow modules don't pollute the report.
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/viewer/tui.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
