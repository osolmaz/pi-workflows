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
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    coverage: {
      // istanbul instruments through the vitest transform pipeline only, so
      // jiti-compiled copies of workflow modules don't pollute the report.
      provider: "istanbul",
      include: ["src/**"],
      exclude: [
        "src/viewer/tui.ts",
        // Re-export and type-only modules contain no behavior to test. Keeping
        // them out also makes branch totals stable across coverage runtimes.
        "src/**/index.ts",
        "src/**/types.ts",
        "src/**/errors.ts",
        "src/controllers/conditions.ts",
        "src/controllers/definition.ts",
        "src/controllers/json.ts",
        "src/controllers/results.ts",
        // The standalone host and viewer run in dedicated integration suites;
        // their subprocess and watcher branches are not observable here.
        "src/host/**",
        "src/viewer/**",
        "src/render/format.ts",
        "src/workflows/definition.ts",
        "src/workflows/text.ts",
        // Loaded only by spawned headless pi children; subprocess execution
        // (covered by the e2e suite) never registers in this report.
        "src/host/rpc-bridge.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
