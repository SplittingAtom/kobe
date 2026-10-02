import { defineConfig } from "vitest/config";

// Integration tests against a real Postgres 17: migrations, RLS catalog checks, cross-team probe.
// Requires KOBE_TEST_DATABASE_URL (a superuser URL used only to create a throwaway database + roles).
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["src/testing/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
