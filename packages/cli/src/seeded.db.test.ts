import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEEDED_TABLES } from "./seeded.js";

/**
 * `kobe restore` refuses a target with rows in any table not listed in SEEDED_TABLES (KOBE-311
 * review B1), so every table a migration seeds must be listed: a freshly migrated database has
 * rows in exactly the listed tables. Needs only Postgres (no pg_dump), so it runs everywhere.
 */
let db: TestDatabase | undefined;

beforeAll(async () => {
  db = await createTestDatabase(testServerUrl());
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe("migration-seeded tables", () => {
  it("are exactly the tables a fresh install has rows in", async () => {
    const client = new pg.Client({ connectionString: db?.adminUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
            AND NOT c.relispartition ORDER BY 1`,
      );
      const seeded: string[] = [];
      for (const { name } of rows) {
        const res = await client.query(`SELECT EXISTS (SELECT 1 FROM "${name}") AS any`);
        if (res.rows[0]?.any) seeded.push(name);
      }
      expect(seeded).toEqual(Object.keys(SEEDED_TABLES).sort());
    } finally {
      await client.end();
    }
  });
});
