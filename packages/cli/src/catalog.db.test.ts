import { rm } from "node:fs/promises";
import { BLOB_REF_COLUMNS } from "@kobe/db";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "@kobe/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existingColumns, referencedObjectKeys } from "./catalog.js";

/**
 * `kobe backup` reads this release's blob-ref columns in the snapshot. A database one migration
 * level behind (backed up before the upgrade migrates it) lacks the tables added since, such as
 * KOBE-304's workspace_file_hold_history: the backup checks the columns that exist and must not
 * fail on the others. No pg_dump needed, so this runs wherever Postgres does.
 */
const HOLD_HISTORY = 'CREATE TABLE "workspace_file_hold_history"';

describe("blob-ref columns on an older schema", () => {
  const server = testServerUrl();
  let db: TestDatabase | undefined;
  let older = "";
  let client: pg.Client | undefined;

  const conn = (): pg.Client => {
    if (!client) throw new Error("not connected");
    return client;
  };

  beforeAll(async () => {
    older = migrationsBefore(HOLD_HISTORY);
    db = await createTestDatabase(server, { migrationsFolder: older });
    client = new pg.Client({ connectionString: db.adminUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    await db?.drop().catch(() => undefined);
    if (older) await rm(older, { recursive: true, force: true });
  });

  it("keeps the columns the schema has and leaves out a table or column it lacks", async () => {
    const asked = [
      ...BLOB_REF_COLUMNS,
      { table: "workspace_files", column: "no_such_column" },
      { table: "no_such_table", column: "blob_ref" },
    ];
    const present = await existingColumns(conn(), asked);
    const names = present.map((c) => `${c.table}.${c.column}`);
    // Added after that level: the hold history (KOBE-304), personal_skill_versions (the 0128
    // rename), the skill package keys (KOBE-310), catalog bytes (KOBE-317) and eval bundles
    // (KOBE-325).
    const later = (c: { table: string; column: string }) =>
      c.table === "workspace_file_hold_history" ||
      c.table === "skill_eval_runs" ||
      c.table === "personal_skill_versions" ||
      c.table === "registry_versions" ||
      c.column === "package_storage_key";
    expect(names).toEqual(
      BLOB_REF_COLUMNS.filter((c) => !later(c)).map((c) => `${c.table}.${c.column}`),
    );
    await expect(referencedObjectKeys(conn(), present)).resolves.toEqual([]);
  });

  it("would fail reading every column of this release on that schema", async () => {
    await expect(referencedObjectKeys(conn(), BLOB_REF_COLUMNS)).rejects.toThrow(
      /workspace_file_hold_history" does not exist/,
    );
  });
});
