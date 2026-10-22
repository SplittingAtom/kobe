import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestDatabase,
  migrationsBefore,
  testNameSuffix,
  testServerUrl,
  type TestDatabase,
} from "@kobe/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";
import { BLOB_REFS, freshTarget, memoryLister, rowsOf, sql, U1 } from "./testing/fixtures.js";

/**
 * KOBE-256 (R3) renamed the install_* tables to site_*. A backup taken before the rename names the
 * old tables and records the old migrations: a site on the renamed schema refuses it before loading
 * anything. It restores on the release it was taken with (that release's `kobe restore`); the
 * upgrade then renames in place (packages/db site-rename-migration.db.test.ts). docs/backup-restore.md
 * It names the old tables on purpose (site-identifiers: allow-file).
 */
const pgBinDir = process.env.KOBE_PG_BIN_DIR || undefined;
const KEY = randomBytes(32);
const RENAME_MARKER = 'ALTER TABLE "install_settings" RENAME TO "site_settings"';

describe("a backup taken before the site rename (KOBE-256)", () => {
  const server = testServerUrl();
  const suffix = testNameSuffix();
  const backupRole = `kobe_backup_old_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const created: TestDatabase[] = [];
  let oldMigrations = "";
  let work = "";

  beforeAll(async () => {
    oldMigrations = migrationsBefore(RENAME_MARKER);
    const src = await createTestDatabase(server, { migrationsFolder: oldMigrations });
    created.push(src);
    await sql(
      src.adminUrl,
      `INSERT INTO users (id, name, email) VALUES ('${U1}', 'Ann', 'ann@example.com');
       INSERT INTO install_roles (user_id, role) VALUES ('${U1}', 'owner');
       INSERT INTO install_settings (key, value) VALUES ('require_2fa', 'false');`,
    );
    await sql(
      server,
      `CREATE ROLE ${backupRole} LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data`,
    );
    const url = new URL(src.adminUrl);
    url.username = backupRole;
    url.password = password;
    work = await mkdtemp(join(tmpdir(), "kobe-old-backup-"));
    const manifest = await runBackup({
      databaseUrl: url.toString(),
      out: join(work, "old"),
      key: KEY,
      objects: memoryLister([]),
      blobRefColumns: BLOB_REFS.filter((c) => c.table !== "widgets"),
      pgBinDir,
    });
    expect(manifest.tables.map((t) => t.name)).toContain("install_settings");
  });

  afterAll(async () => {
    for (const db of created) await db.drop().catch(() => undefined);
    await sql(server, `DROP ROLE IF EXISTS ${backupRole}`).catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true });
    if (oldMigrations) await rm(oldMigrations, { recursive: true, force: true });
  });

  it("is refused by a site on the renamed schema, before anything is loaded", async () => {
    const dst = await freshTarget(server);
    created.push(dst);
    await expect(
      runRestore({
        databaseUrl: dst.ownerUrl,
        from: join(work, "old"),
        key: KEY,
        objects: memoryLister([]),
        allowObjectMismatch: false,
        skipObjects: false,
        pgBinDir,
      }),
    ).rejects.toThrow(
      /schema does not match the backup[\s\S]*Install the Kobe version the backup was taken with/,
    );
    expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
    expect(await rowsOf(dst.adminUrl, "site_roles")).toEqual([]);
  });
});
