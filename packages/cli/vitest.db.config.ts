import { defineConfig } from "vitest/config";

// Backup → restore round trips against a real Postgres 17 and the real pg_dump/pg_restore/psql.
// Requires KOBE_TEST_DATABASE_URL (superuser URL; throwaway databases and roles only) and
// PostgreSQL 17+ client binaries on PATH or in KOBE_PG_BIN_DIR.
export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
