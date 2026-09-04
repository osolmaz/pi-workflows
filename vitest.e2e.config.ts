import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@osolmaz/pi-workflows/resource-managers",
        replacement: new URL("./src/resource-managers/index.ts", import.meta.url).pathname,
      },
      {
        find: "@osolmaz/pi-workflows",
        replacement: new URL("./src/workflows/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
