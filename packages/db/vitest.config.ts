import { defineConfig } from "vitest/config";

// Unit tests only; Postgres-backed tests (*.db.test.ts) run via vitest.db.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["src/**/*.db.test.ts"],
  },
});
