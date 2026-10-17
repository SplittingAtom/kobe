import { defineConfig } from "vitest/config";

// Server integration tests against a real Postgres 17 (auth flows, setup, sessions).
// Requires KOBE_TEST_DATABASE_URL (superuser URL used only for throwaway databases).
//
// Every file opens its own throwaway database (openHarness, the fixtures, or createTestDatabase
// directly), so files run in parallel (KOBE-300). Most of a file's time is spent waiting on
// Postgres, locks and timers, not on CPU. A file peaks at about 12 connections (measured), so
// KOBE_DB_TEST_WORKERS × 12 must stay well within the server's max_connections (default 100).
const workers = Number(process.env.KOBE_DB_TEST_WORKERS ?? "4");
if (!Number.isInteger(workers) || workers < 1) {
  throw new Error(`KOBE_DB_TEST_WORKERS must be a positive integer, got "${String(workers)}"`);
}

export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: true,
    maxWorkers: workers,
    // expect.poll waits on a real condition (e.g. a run reaching a terminal state); vitest's 1 s
    // default is too tight on loaded CI runners. A condition that never holds still fails.
    expect: { poll: { timeout: 10_000 } },
  },
});
