import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_LOCK_KEY } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "./backup.js";
import { DATABASE_FILE, MANIFEST_FILE, type Manifest } from "./manifest.js";
import type { ObjectLister, StoredObject } from "./objects.js";
import { pgBinary, runTool } from "./pg-tools.js";
import { runRestore } from "./restore.js";

const pgBinDir = process.env.KOBE_PG_BIN_DIR || undefined;
const SESSION_TOKEN = "SESSION-TOKEN-PLAINTEXT-1f2e3d";
const RESET_TOKEN = "RESET-TOKEN-PLAINTEXT-4a5b6c";
const JWKS_PRIVATE = "JWKS-PRIVATE-KEY-7d8e9f";

const T1 = "00000000-0000-4000-8000-0000000000a1";
const T2 = "00000000-0000-4000-8000-0000000000a2";
const U1 = "00000000-0000-4000-8000-0000000000b1";
const U2 = "00000000-0000-4000-8000-0000000000b2";
const U3 = "00000000-0000-4000-8000-0000000000b3";

const OBJECTS: StoredObject[] = [
  { key: "teams/a1/uploads/report.csv", size: 1234, etag: '"e1"' },
  { key: "teams/a2/artifacts/chart.html", size: 99, etag: '"e2"' },
];

function memoryLister(objects: readonly StoredObject[]): ObjectLister {
  return {
    location: { endpoint: "memory://test", bucket: "kobe", prefix: "" },
    async *list() {
      yield* objects;
    },
  };
}

async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/**
 * A table "added by a later ticket": team-scoped with FORCE RLS, a self-referencing foreign key
 * (children stored before parents) and a serial. Its absence from any backup code proves new
 * tables are covered automatically.
 */
const WIDGETS = `
  CREATE TABLE widgets (
    team_id uuid NOT NULL REFERENCES teams(id),
    id serial PRIMARY KEY,
    parent_id int REFERENCES widgets(id),
    name text NOT NULL
  );
  ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
  CREATE POLICY team_isolation ON widgets
    USING (team_id = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
    WITH CHECK (team_id = NULLIF(current_setting('kobe.team_id', true), '')::uuid);`;

/** A business trigger that must not fire while restoring (and must be back afterwards). */
const GUARD_TRIGGER = `
  CREATE FUNCTION widgets_guard() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'business trigger fired'; END $$;
  CREATE TRIGGER widgets_guard BEFORE INSERT ON widgets FOR EACH ROW EXECUTE FUNCTION widgets_guard();`;

async function seed(db: TestDatabase): Promise<void> {
  await sql(db.ownerUrl, WIDGETS);
  // The superuser bypasses RLS, standing in for an app that wrote through withTeam().
  await sql(
    db.adminUrl,
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'alpha', 'Alpha'), ($2, 'beta', 'Beta');
     INSERT INTO users (id, name, email) VALUES ($3, 'Ann', 'ann@example.com'),
       ($4, 'Bob', 'bob@example.com'), ($5, 'Cy', 'cy@example.com');
     INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $3, 'team_admin'),
       ($1, $4, 'member'), ($2, $5, 'team_admin');
     INSERT INTO accounts (user_id, account_id, provider_id, password)
       VALUES ($3, $3, 'credential', 'scrypt:salt:hash');
     INSERT INTO install_roles (user_id, role) VALUES ($3, 'owner');
     INSERT INTO install_settings (key, value) VALUES ('require_2fa', 'false');
     INSERT INTO two_factors (user_id, secret, backup_codes) VALUES ($3, 'enc:totp', 'enc:codes');
     INSERT INTO sessions (user_id, token, expires_at) VALUES ($3, '${SESSION_TOKEN}', now() + interval '1 day');
     INSERT INTO verifications (identifier, value, expires_at) VALUES ('reset', '${RESET_TOKEN}', now() + interval '1 hour');
     INSERT INTO jwks (public_key, private_key) VALUES ('pub', '${JWKS_PRIVATE}');
     INSERT INTO rate_limits (key, count, last_request) VALUES ('ip', 3, 1);
     INSERT INTO widgets (team_id, id, parent_id, name) VALUES ($1, 1, 2, 'child'), ($1, 2, NULL, 'parent'),
       ($2, 3, NULL, 'beta-only');
     SELECT setval('widgets_id_seq', 3);`.replaceAll(
      /\$(\d)/g,
      (_, n: string) => `'${[T1, T2, U1, U2, U3][Number(n) - 1]}'`,
    ),
  );
}

/** A freshly installed target: migrated by Kobe, same schema, no data. */
async function freshTarget(server: string): Promise<TestDatabase> {
  const db = await createTestDatabase(server);
  await sql(db.ownerUrl, WIDGETS + GUARD_TRIGGER);
  // The new install's server already generated its own signing key; it must survive the restore.
  await sql(
    db.adminUrl,
    `INSERT INTO jwks (public_key, private_key) VALUES ('new-pub', 'new-enc')`,
  );
  return db;
}

async function rowsOf(url: string, table: string): Promise<string[]> {
  const rows = await sql<{ r: string }>(
    url,
    `SELECT to_jsonb(t)::text AS r FROM public."${table}" t ORDER BY 1`,
  );
  return rows.map((r) => r.r);
}

async function forcedTables(url: string): Promise<string[]> {
  const rows = await sql<{ name: string }>(
    url,
    `SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity ORDER BY 1`,
  );
  return rows.map((r) => r.name);
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
  let manifest: Manifest;

  const target = async (): Promise<TestDatabase> => {
    const db = await freshTarget(server);
    created.push(db);
    return db;
  };
  const restore = (
    db: TestDatabase,
    from = backupDir,
    extra: Partial<Parameters<typeof runRestore>[0]> = {},
  ) =>
    runRestore({
      databaseUrl: db.ownerUrl,
      from,
      objects: memoryLister(OBJECTS),
      allowMissingObjects: false,
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

  it("refuses a role bound by row-level security (team rows would be missing)", async () => {
    const out = join(work, "refused");
    await expect(
      runBackup({ databaseUrl: src.ownerUrl, out, objects: null, pgBinDir }),
    ).rejects.toThrow(/row-level security/);
    expect(await readdir(work)).toEqual([]);
  });

  it("backs up every table from one snapshot, leaving out tokens and signing keys", async () => {
    manifest = await runBackup({
      databaseUrl: backupUrl,
      out: backupDir,
      objects: memoryLister(OBJECTS),
      pgBinDir,
    });

    const counts = Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows]));
    expect(counts).toMatchObject({
      teams: 2,
      users: 3,
      team_members: 3,
      widgets: 3,
      two_factors: 1,
    });
    expect(manifest.excludedTables.map((t) => t.name).sort()).toEqual([
      "jwks",
      "rate_limits",
      "sessions",
      "verifications",
    ]);
    const journal = await sql<{ hash: string }>(
      src.adminUrl,
      "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
    );
    expect(manifest.migrations.map((m) => m.hash)).toEqual(journal.map((j) => j.hash));
    expect(manifest.objectStorage).toMatchObject({ bucket: "kobe", objects: 2, bytes: 1333 });

    // Private files in a private directory; the manifest carries no credentials.
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700);
    for (const f of await readdir(backupDir))
      expect((await stat(join(backupDir, f))).mode & 0o777).toBe(0o600);
    const manifestText = await readFile(join(backupDir, MANIFEST_FILE), "utf8");
    expect(manifestText).not.toContain(password);

    const script = await runTool(pgBinary("pg_restore", pgBinDir), [
      "--data-only",
      "--file=-",
      join(backupDir, DATABASE_FILE),
    ]);
    expect(script).toContain("ann@example.com");
    expect(script).toContain("beta-only");
    for (const secret of [SESSION_TOKEN, RESET_TOKEN, JWKS_PRIVATE])
      expect(script).not.toContain(secret);
    expect(script).not.toContain("__drizzle_migrations");
  });

  it("never overwrites an existing backup", async () => {
    await expect(
      runBackup({ databaseUrl: backupUrl, out: backupDir, objects: null, pgBinDir }),
    ).rejects.toThrow(/already exists/);
  });

  it("restores into a fresh install: same rows, RLS still forced, triggers back, teams still walls", async () => {
    const dst = await target();
    const forcedBefore = await forcedTables(dst.adminUrl);
    const report = await restore(dst);
    expect(report).toMatchObject({
      tables: manifest.tables.length,
      objects: { checked: 2, missing: 0 },
    });

    for (const t of manifest.tables)
      expect(await rowsOf(dst.adminUrl, t.name), t.name).toEqual(
        await rowsOf(src.adminUrl, t.name),
      );
    expect(await rowsOf(dst.adminUrl, "sessions")).toEqual([]);
    expect(await rowsOf(dst.adminUrl, "verifications")).toEqual([]);
    expect((await rowsOf(dst.adminUrl, "jwks")).map((r) => JSON.parse(r).private_key)).toEqual([
      "new-enc",
    ]);

    expect(await forcedTables(dst.adminUrl)).toEqual(forcedBefore);
    expect(forcedBefore).toEqual(expect.arrayContaining(["team_members", "widgets"]));
    // The sequence moved with the data.
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

  it("rolls everything back when a check fails inside the transaction", async () => {
    const dst = await target();
    const tampered = join(work, "tampered-count");
    await cp(backupDir, tampered, { recursive: true });
    const m = JSON.parse(await readFile(join(tampered, MANIFEST_FILE), "utf8")) as Manifest;
    const edited = {
      ...m,
      tables: m.tables.map((t) => (t.name === "widgets" ? { ...t, rows: t.rows + 1 } : t)),
    };
    await writeFile(join(tampered, MANIFEST_FILE), JSON.stringify(edited));

    await expect(restore(dst, tampered)).rejects.toThrow(
      /rolled back[\s\S]*widgets has 3 rows, the backup has 4/,
    );
    for (const t of manifest.tables) expect(await rowsOf(dst.adminUrl, t.name), t.name).toEqual([]);
    expect(await forcedTables(dst.adminUrl)).toEqual(
      expect.arrayContaining(["team_members", "widgets"]),
    );
    const trigger = await sql<{ tgenabled: string }>(
      dst.adminUrl,
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'widgets_guard'",
    );
    expect(trigger).toEqual([{ tgenabled: "O" }]);
  });

  it("refuses a modified dump before touching the database", async () => {
    const dst = await target();
    const corrupt = join(work, "corrupt");
    await cp(backupDir, corrupt, { recursive: true });
    const dump = await readFile(join(corrupt, DATABASE_FILE));
    dump[dump.length - 10] = (dump[dump.length - 10] ?? 0) ^ 0xff;
    await writeFile(join(corrupt, DATABASE_FILE), dump);
    await expect(restore(dst, corrupt)).rejects.toThrow(/checksum/);
  });

  it("does not run alongside a migration (migration lock held): backup and restore refuse", async () => {
    const dst = await target();
    const holder = new pg.Client({ connectionString: dst.adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await expect(restore(dst)).rejects.toThrow(/a migration, backup or restore is running/);
      const url = new URL(backupUrl);
      url.pathname = new URL(dst.adminUrl).pathname;
      await expect(
        runBackup({
          databaseUrl: url.toString(),
          out: join(work, "locked"),
          objects: null,
          pgBinDir,
        }),
      ).rejects.toThrow(/migration or restore is running/);
    } finally {
      await holder.end();
    }
    expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
  });

  it("refuses when S3 objects are missing, unless explicitly allowed", async () => {
    const dst = await target();
    const partialBucket = memoryLister([OBJECTS[0] as StoredObject]);
    await expect(restore(dst, backupDir, { objects: partialBucket })).rejects.toThrow(
      /1 objects are missing/,
    );
    expect(await rowsOf(dst.adminUrl, "users")).toEqual([]);
    await expect(restore(dst, backupDir, { objects: null })).rejects.toThrow(
      /object storage is not configured/,
    );

    const report = await restore(dst, backupDir, {
      objects: partialBucket,
      allowMissingObjects: true,
    });
    expect(report.objects).toEqual({ checked: 2, missing: 1 });
    expect(await rowsOf(dst.adminUrl, "users")).toEqual(await rowsOf(src.adminUrl, "users"));
  });
});
