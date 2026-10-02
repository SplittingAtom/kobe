import { defineConfig } from "vitest/config";

// Egress proxy integration tests against a real Postgres 17 (allowlists, hints, audit).
// Requires KOBE_TEST_DATABASE_URL (superuser URL used only for a throwaway database).
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["src/testing/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
