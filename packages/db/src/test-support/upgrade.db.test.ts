import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from "../migrate.js";
import { createTestDatabase, testServerUrl, type TestDatabase } from "./database.js";
import { assertAllMigrationsApplied } from "./upgrade.js";

/** ac-2 end to end: Drizzle really skips an out-of-order migration, and the check notices. */
const dbs: TestDatabase[] = [];
afterAll(async () => {
  for (const d of dbs) await d.drop();
});

describe("out-of-order migration on an existing install", () => {
  it("is skipped by Drizzle and caught by assertAllMigrationsApplied", async () => {
    const saved = process.env.KOBE_TEST_BASE_MIGRATIONS;
    delete process.env.KOBE_TEST_BASE_MIGRATIONS;
    const db = await createTestDatabase(testServerUrl());
    dbs.push(db);
    if (saved) process.env.KOBE_TEST_BASE_MIGRATIONS = saved;

    const dir = mkdtempSync(join(tmpdir(), "kobe-ooo-"));
    cpSync(DEFAULT_MIGRATIONS_FOLDER, dir, { recursive: true });
    const path = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const last = journal.entries.at(-1) as { idx: number; when: number; tag: string };
    const tag = `9999_out_of_order_${randomBytes(3).toString("hex")}`;
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when - 1, tag });
    writeFileSync(path, JSON.stringify(journal));
    writeFileSync(join(dir, `${tag}.sql`), "CREATE TABLE kobe_out_of_order (id int);");

    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole, migrationsFolder: dir });
    const admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    try {
      const res = await admin.query("SELECT to_regclass('kobe_out_of_order') AS t");
      expect(res.rows[0].t).toBeNull(); // silently skipped
    } finally {
      await admin.end();
    }
    await expect(assertAllMigrationsApplied(db.ownerUrl, dir)).rejects.toThrow(/skipped/);
  });
});
