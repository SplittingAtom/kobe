import { defineConfig } from "vitest/config";

// Memory eval harness (KOBE-387, `e2e/memory-eval.sh`): measurements, not tests, so neither
// `pnpm test` nor `test:db` runs them. `relevance` needs KOBE_TEST_DATABASE_URL (a throwaway
// database is created and dropped); `cache` talks to a running deployment (KOBE_EVAL_URL).
export default defineConfig({
  test: {
    include: ["src/testing/memory-eval/**/*.eval.ts"],
    globalSetup: ["src/testing/db-global-setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
