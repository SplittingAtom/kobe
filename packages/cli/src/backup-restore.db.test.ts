import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_LOCK_KEY, createDb, verifyAuditChain } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup, type BackupOptions } from "./backup.js";
import {
  DATABASE_FILE,
  MANIFEST_FILE,
  MANIFEST_SIGNATURE_FILE,
  type Manifest,
} from "./manifest.js";
import type { StoredObject } from "./objects.js";
import { runRestore, type RestoreOptions } from "./restore.js";
import { RestrictGuard } from "./restrict-guard.js";
import {
  BLOB_REFS,
  OBJECTS,
  PERSONAL_DATA,
  EXCLUDED_MARKERS,
  OAUTH_TOKENS,
  SEARCH_WORD,
  T1,
  allBackupBytes,
  copyWithManifest,
  dumpScript,
  forcedTables,
  freshTarget,
  memoryLister,
  rowsOf,
  seed,
  sql,
  trapBinDir,
} from "./testing/fixtures.js";

const pgBinDir = process.env.KOBE_PG_BIN_DIR || undefined;
const KEY = randomBytes(32);
const UNREACHABLE_DB = "postgres://nobody:nothing@127.0.0.1:1/none";

async function auditHashAt(url: string, seq: number): Promise<string | undefined> {
  const [row] = await sql<{ hash: string }>(url, `SELECT hash FROM audit_log WHERE seq = ${seq}`);
  return row?.hash;
}

describe("kobe backup → kobe restore (real Postgres, pg_dump, pg_restore, psql)", () => {
  const server = testServerUrl();
  const suffix = randomBytes(4).toString("hex");
  const backupRole = `kobe_backup_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const created: TestDatabase[] = [];
  let src: TestDatabase;
  let backupUrl: string;
  let work: string;
  let backupDir: string;
  let manifest: Manifest & { readonly fingerprint: string };

  const target = async (): Promise<TestDatabase> => {
    const db = await freshTarget(server);
    created.push(db);
    return db;
  };
  const backup = (out: string, extra: Partial<BackupOptions> = {}) =>
    runBackup({
      databaseUrl: backupUrl,
      out,
      key: KEY,
      objects: memoryLister(OBJECTS),
      blobRefColumns: BLOB_REFS,
      pgBinDir,
      ...extra,
    });
  const restore = (db: TestDatabase, from = backupDir, extra: Partial<RestoreOptions> = {}) =>
    runRestore({
      databaseUrl: db.ownerUrl,
      from,
      key: KEY,
      objects: memoryLister(OBJECTS),
      allowObjectMismatch: false,
      skipObjects: false,
      pgBinDir,
      ...extra,
    });

  beforeAll(async () => {
    src = await createTestDatabase(server);
    created.push(src);
    await seed(src);
    await sql(
      server,
      `CREATE ROLE ${backupRole} LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data`,
    );
    const url = new URL(src.adminUrl);
    url.username = backupRole;
    url.password = password;
    backupUrl = url.toString();
    work = await mkdtemp(join(tmpdir(), "kobe-backup-test-"));
    backupDir = join(work, "b1");
  });

  afterAll(async () => {
    for (const db of created) await db.drop().catch(() => undefined);
    await sql(server, `DROP ROLE IF EXISTS ${backupRole}`).catch(() => undefined);
  });

  describe("backup", () => {
    it("refuses a role bound by row-level security (team rows would be missing)", async () => {
      await expect(backup(join(work, "refused"), { databaseUrl: src.ownerUrl })).rejects.toThrow(
        /row-level security/,
      );
      expect(await readdir(work)).toEqual([]);
    });

    it("backs up every table from one snapshot, encrypted and signed", async () => {
      manifest = await backup(backupDir);
      expect(manifest.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

      const counts = Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows]));
      expect(counts).toMatchObject({
        teams: 2,
        users: 3,
        team_members: 3,
        widgets: 3,
        accounts: 2,
        threads: 1,
        thread_entries: 2,
      });
      expect(manifest.excludedTables.map((t) => t.name).sort()).toEqual([
        "jwks",
        "rate_limits",
        "session_active_teams",
        "sessions",
        "verifications",
      ]);
      const journal = await sql<{ hash: string }>(
        src.adminUrl,
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );
      expect(manifest.migrations.map((m) => m.hash)).toEqual(journal.map((j) => j.hash));
      expect(manifest.objectStorage).toMatchObject({
        bucket: "kobe",
        objects: 2,
        bytes: 1333,
        referencedObjects: 2,
        blobRefColumns: [
          { table: "thread_entries", column: "blob_ref" },
          { table: "widgets", column: "blob_ref" },
        ],
      });
      expect(manifest.coverage).toEqual({
        schemas: ["public"],
        otherSchemasChecked: true,
        largeObjects: 0,
      });
      expect(manifest.encryption).toMatchObject({ cipher: "aes-256-gcm", kdf: "hkdf-sha256" });

      expect((await stat(backupDir)).mode & 0o777).toBe(0o700);
      for (const f of await readdir(backupDir)) {
        expect((await stat(join(backupDir, f))).mode & 0o777, f).toBe(0o600);
      }
    });

    it("leaves sessions, verifications, jwks and rate_limits out of the decrypted dump", async () => {
      const script = await dumpScript(backupDir, KEY, pgBinDir);
      for (const [name, marker] of Object.entries(EXCLUDED_MARKERS)) {
        expect(script, name).not.toContain(marker);
      }
      for (const table of ["sessions", "verifications", "jwks", "rate_limits"]) {
        expect(script).not.toContain(`COPY public.${table} `);
      }
      expect(script).not.toContain("__drizzle_migrations");
      // Everything else is in it, including any OAuth tokens in `accounts`: those are protected
      // only by the backup encryption (docs/backup-restore.md).
      expect(script).toContain("ann@example.com");
      expect(script).toContain("beta-only");
      for (const token of Object.values(OAUTH_TOKENS)) expect(script).toContain(token);
    });

    it("stores that dump only encrypted (no readable data or credentials in any file)", async () => {
      const raw = (await allBackupBytes(backupDir)).toString("latin1");
      for (const value of [...Object.values(OAUTH_TOKENS), ...PERSONAL_DATA, password]) {
        expect(raw, value).not.toContain(value);
      }
    });

    it("gets a pg_restore script wrapped in \\restrict … \\unrestrict from the real client", async () => {
      const script = await dumpScript(backupDir, KEY, pgBinDir);
      const key = /^\\restrict (\S+)$/m.exec(script)?.[1];
      expect(key).toBeDefined();
      expect(script).toMatch(new RegExp(`^\\\\unrestrict ${key}$`, "m"));
      const guard = new RestrictGuard();
      expect(() => {
        guard.push(Buffer.from(script));
        guard.finish();
      }).not.toThrow();
    });

    it("never overwrites an existing backup", async () => {
      await expect(backup(backupDir)).rejects.toThrow(/already exists/);
    });

    it("refuses when data outside public (tables, large objects) would be skipped", async () => {
      await sql(src.adminUrl, "CREATE SCHEMA side; CREATE TABLE side.notes (body text)");
      await expect(backup(join(work, "side"))).rejects.toThrow(/side\.notes \(table\)/);
      await sql(src.adminUrl, "DROP SCHEMA side CASCADE");

      const [lo] = await sql<{ oid: number }>(src.adminUrl, "SELECT lo_create(0) AS oid");
      await expect(backup(join(work, "lo"))).rejects.toThrow(/1 large objects/);
      await sql(src.adminUrl, "SELECT lo_unlink($1)", [lo?.oid]);
      expect(await readdir(work)).toEqual(["b1"]);
    });

    it("refuses when the database references objects the bucket does not hold", async () => {
      await expect(
        backup(join(work, "unlisted"), { objects: memoryLister([OBJECTS[1] as StoredObject]) }),
      ).rejects.toThrow(/references 1 objects that are not in the bucket.*report\.csv/);
    });

    it("does not run alongside a migration (migration lock held)", async () => {
      const holder = new pg.Client({ connectionString: src.adminUrl });
      await holder.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        await expect(backup(join(work, "locked"))).rejects.toThrow(
          /migration or restore is running/,
        );
      } finally {
        await holder.end();
      }
    });
  });

  describe("restore authenticates the backup before running any tool", () => {
    async function refusedBeforeAnyTool(dir: string, key: Buffer, pattern: RegExp): Promise<void> {
      const trap = await trapBinDir();
      await expect(
        runRestore({
          databaseUrl: UNREACHABLE_DB,
          from: dir,
          key,
          objects: null,
          allowObjectMismatch: false,
          skipObjects: true,
          pgBinDir: trap.dir,
        }),
      ).rejects.toThrow(pattern);
      expect(await trap.ran()).toBe(false);
    }

    it("refuses a modified dump", async () => {
      const dir = join(work, "tampered-dump");
      await cp(backupDir, dir, { recursive: true });
      const dump = await readFile(join(dir, DATABASE_FILE));
      dump[dump.length - 10] = (dump[dump.length - 10] ?? 0) ^ 0xff;
      await writeFile(join(dir, DATABASE_FILE), dump);
      await refusedBeforeAnyTool(dir, KEY, /checksum/);
    });

    it("refuses a modified manifest (even with matching file hashes)", async () => {
      const dir = join(work, "tampered-manifest");
      await cp(backupDir, dir, { recursive: true });
      const text = await readFile(join(dir, MANIFEST_FILE), "utf8");
      await writeFile(join(dir, MANIFEST_FILE), text.replace('"rows": 3', '"rows": 4'));
      await refusedBeforeAnyTool(dir, KEY, /signature does not verify/);
    });

    it("refuses a file whose checksum matches but whose GCM tag does not", async () => {
      const dir = join(work, "bad-tag");
      await copyWithManifest(backupDir, dir, KEY, (m) => ({
        ...m,
        files: {
          ...m.files,
          database: {
            ...m.files.database,
            tag: m.files.database.tag.replace(/^./, (c) => (c === "0" ? "1" : "0")),
          },
        },
      }));
      await refusedBeforeAnyTool(dir, KEY, /could not be decrypted/);
    });

    it("refuses the wrong key", async () => {
      await refusedBeforeAnyTool(backupDir, randomBytes(32), /wrong backup key/);
    });

    it("refuses a missing signature", async () => {
      const dir = join(work, "unsigned");
      await cp(backupDir, dir, { recursive: true });
      await rm(join(dir, MANIFEST_SIGNATURE_FILE));
      await refusedBeforeAnyTool(dir, KEY, /unsigned/);
    });
  });

  describe("restore", () => {
    it("restores into a fresh install: same rows, RLS still forced, triggers back, teams still walls", async () => {
      const dst = await target();
      const forcedBefore = await forcedTables(dst.adminUrl);
      const tmp = await mkdtemp(join(tmpdir(), "kobe-tmpdir-"));
      // The signed manifest carries the snapshot's audit head; an off-box anchor can be checked too.
      expect(manifest.auditHead).toMatchObject({
        seq: 2,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const report = await restore(dst, backupDir, {
        tmpDir: tmp,
        operator: "ops.test",
        expectAuditHead: { seq: 1, hash: (await auditHashAt(src.adminUrl, 1)) ?? "" },
      });
      expect(await readdir(tmp)).toEqual([]); // the decrypted dump is gone
      expect(report).toMatchObject({
        fingerprint: manifest.fingerprint,
        createdAt: manifest.createdAt,
        tables: manifest.tables.length,
        objects: { checked: 2, problems: 0 },
      });

      for (const t of manifest.tables.filter((t) => t.name !== "audit_log")) {
        expect(await rowsOf(dst.adminUrl, t.name), t.name).toEqual(
          await rowsOf(src.adminUrl, t.name),
        );
      }
      // Audit log (KOBE-15): restored verbatim (seq, hashes), then the restore's own event
      // extends the chain; the chain verifies and the append-only triggers are back.
      const audit = (url: string) =>
        sql<{ r: string }>(url, `SELECT to_jsonb(a)::text AS r FROM audit_log a ORDER BY seq`);
      const restoredAudit = await audit(dst.adminUrl);
      expect(restoredAudit.slice(0, -1)).toEqual(await audit(src.adminUrl));
      expect(restoredAudit).toHaveLength(3);
      expect(JSON.parse(restoredAudit.at(-1)?.r ?? "{}")).toMatchObject({
        seq: 3,
        actor_kind: "system",
        action: "platform.restore.completed",
        target: {
          backupCreatedAt: manifest.createdAt,
          tables: manifest.tables.length,
          operator: "ops.test",
          auditHeadSeq: 2,
          auditHeadHash: manifest.auditHead?.hash,
        },
      });
      expect(report.auditHead).toEqual({ seq: 3, hash: await auditHashAt(dst.adminUrl, 3) });
      const dstDb = createDb(dst.appUrl, { max: 1 });
      try {
        expect(await verifyAuditChain(dstDb.db)).toMatchObject({ ok: true, checked: 3 });
      } finally {
        await dstDb.close();
      }
      expect(
        await sql(
          dst.adminUrl,
          `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass
           AND NOT tgisinternal AND tgenabled = 'O'`,
        ),
      ).toHaveLength(3);
      await expect(sql(dst.appUrl, "DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
      expect(await rowsOf(dst.adminUrl, "sessions")).toEqual([]);
      expect(await rowsOf(dst.adminUrl, "verifications")).toEqual([]);

      // Stored generated columns (thread search, KOBE-33) are not in the dump's data; the restore
      // recomputes them, so search works on the restored install (rows above include tsv too).
      const script = await dumpScript(backupDir, KEY, pgBinDir);
      expect(script).toMatch(/COPY public\.thread_entries \(/);
      expect(script).not.toMatch(/COPY public\.(threads|thread_entries) \([^)]*\btsv\b/);
      expect(
        await sql<{ entry: string | null; title: string | null }>(
          dst.adminUrl,
          `SELECT e.tsv::text AS entry, t.tsv::text AS title
           FROM thread_entries e JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id
           WHERE e.entry_id = 'e1'`,
        ),
      ).toEqual([{ entry: `'forecast':2 '${SEARCH_WORD}':1`, title: "'q3':1A 'report':2A" }]);
      expect(
        (await rowsOf(dst.adminUrl, "jwks")).map(
          (r) => (JSON.parse(r) as { private_key: string }).private_key,
        ),
      ).toEqual(["new-enc"]);

      expect(await forcedTables(dst.adminUrl)).toEqual(forcedBefore);
      expect(forcedBefore).toEqual(expect.arrayContaining(["team_members", "widgets"]));
      const [seq] = await sql<{ v: string }>(
        dst.adminUrl,
        "SELECT last_value::text AS v FROM widgets_id_seq",
      );
      expect(seq?.v).toBe("3");
      const trigger = await sql<{ tgenabled: string }>(
        dst.adminUrl,
        "SELECT tgenabled FROM pg_trigger WHERE tgname = 'widgets_guard'",
      );
      expect(trigger).toEqual([{ tgenabled: "O" }]);
      await expect(
        sql(dst.adminUrl, `INSERT INTO widgets (team_id, name) VALUES ('${T1}', 'x')`),
      ).rejects.toThrow(/business trigger fired/);

      // The app role (non-owner) sees one team at a time and nothing without a team.
      const app = new pg.Client({ connectionString: dst.appUrl });
      await app.connect();
      try {
        expect((await app.query("SELECT count(*)::int AS n FROM team_members")).rows[0]).toEqual({
          n: 0,
        });
        await app.query("BEGIN");
        await app.query("SELECT set_config('kobe.team_id', $1, true)", [T1]);
        expect((await app.query("SELECT count(*)::int AS n FROM team_members")).rows[0]).toEqual({
          n: 2,
        });
        await app.query("COMMIT");
      } finally {
        await app.end();
      }

      // A second restore into the now populated database is refused and changes nothing.
      await expect(restore(dst)).rejects.toThrow(/already has data/);
      expect(await rowsOf(dst.adminUrl, "users")).toEqual(await rowsOf(src.adminUrl, "users"));
      expect(await forcedTables(dst.adminUrl)).toEqual(forcedBefore);
    });

    it("refuses a backup whose audit chain was tampered with, and restores nothing (KOBE-15)", async () => {
      const [original] = await sql<{ target: string }>(
        src.adminUrl,
        "SELECT target::text AS target FROM audit_log WHERE seq = 1",
      );
      const tamper = (target: string) =>
        sql(
          src.adminUrl,
          `BEGIN; SET LOCAL session_replication_role = replica;
           UPDATE audit_log SET target = '${target}'::jsonb WHERE seq = 1; COMMIT;`,
        );
      const tampered = join(work, "b-tampered");
      await tamper('{"method":"passkey"}');
      try {
        await backup(tampered);
      } finally {
        await tamper(original?.target ?? "{}");
      }
      const dst = await target();
      await expect(restore(dst, tampered)).rejects.toThrow(
        /audit chain in the backup is broken at seq 1 \(the row does not match its hash\)/,
      );
      expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
      expect(await rowsOf(dst.adminUrl, "audit_log")).toEqual([]);
    });

    it("refuses when the restored chain doesn't contain an expected head", async () => {
      const dst = await target();
      await expect(
        restore(dst, backupDir, { expectAuditHead: { seq: 1, hash: "0".repeat(64) } }),
      ).rejects.toThrow(/does not contain 1:0{64} \(expect-audit-head\)/);
      expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
    });

    it("refuses a target whose applied migrations differ", async () => {
      const dst = await target();
      await sql(
        dst.adminUrl,
        "DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
      );
      await expect(restore(dst)).rejects.toThrow(/schema does not match the backup/);
    });

    it("refuses the app role (it owns nothing and RLS binds it)", async () => {
      const dst = await target();
      await expect(restore(dst, backupDir, { databaseUrl: dst.appUrl })).rejects.toThrow(
        /owner role/,
      );
    });

    it("rolls everything back when a check fails inside the transaction, without leaking row data", async () => {
      const dst = await target();
      const dir = join(work, "wrong-count");
      await copyWithManifest(backupDir, dir, KEY, (m) => ({
        ...m,
        tables: m.tables.map((t) => (t.name === "widgets" ? { ...t, rows: t.rows + 1 } : t)),
      }));
      const error = await restore(dst, dir).then(
        () => null,
        (err: unknown) => err as Error,
      );
      expect(error?.message).toMatch(/rolled back[\s\S]*widgets has 3 rows, the backup has 4/);
      for (const t of manifest.tables)
        expect(await rowsOf(dst.adminUrl, t.name), t.name).toEqual([]);
      expect(await forcedTables(dst.adminUrl)).toEqual(
        expect.arrayContaining(["team_members", "widgets"]),
      );
      const trigger = await sql<{ tgenabled: string }>(
        dst.adminUrl,
        "SELECT tgenabled FROM pg_trigger WHERE tgname = 'widgets_guard'",
      );
      expect(trigger).toEqual([{ tgenabled: "O" }]);
    });

    it("shows only the SQLSTATE for server errors that could quote row data", async () => {
      const dst = await target();
      // A check constraint the data violates: the server's DETAIL would quote the failing row.
      await sql(
        dst.adminUrl,
        `ALTER TABLE widgets ADD CONSTRAINT widgets_name_check CHECK (name <> 'beta-only')`,
      );
      const error = await restore(dst).then(
        () => null,
        (err: unknown) => err as Error,
      );
      expect(error?.message).toMatch(/rolled back[\s\S]*ERROR 23514/);
      expect(error?.message).not.toContain("beta-only");
      expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
    });

    it("does not run alongside a migration (migration lock held)", async () => {
      const dst = await target();
      const holder = new pg.Client({ connectionString: dst.adminUrl });
      await holder.connect();
      try {
        await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
        await expect(restore(dst)).rejects.toThrow(/a migration, backup or restore is running/);
      } finally {
        await holder.end();
      }
      expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
    });

    it("refuses missing or changed S3 objects unless explicitly allowed", async () => {
      const dst = await target();
      const first = OBJECTS[0] as StoredObject;
      const second = OBJECTS[1] as StoredObject;
      await expect(restore(dst, backupDir, { objects: memoryLister([first]) })).rejects.toThrow(
        /1 objects are missing/,
      );
      await expect(
        restore(dst, backupDir, { objects: memoryLister([first, { ...second, etag: '"other"' }]) }),
      ).rejects.toThrow(/1 differ in ETag/);
      await expect(restore(dst, backupDir, { objects: null })).rejects.toThrow(
        /object storage is not configured/,
      );
      expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);

      const report = await restore(dst, backupDir, {
        objects: memoryLister([first]),
        allowObjectMismatch: true,
      });
      expect(report.objects).toEqual({ checked: 2, problems: 1 });
      expect(await rowsOf(dst.adminUrl, "users")).toEqual(await rowsOf(src.adminUrl, "users"));
    });

    it("skips object checks only with --no-objects, loudly", async () => {
      const dst = await target();
      const lines: string[] = [];
      await restore(dst, backupDir, {
        objects: null,
        skipObjects: true,
        log: (m) => lines.push(m),
      });
      expect(lines.join("\n")).toMatch(/WARNING: --no-objects: 2 S3 objects are NOT verified/);
    });
  });
});
