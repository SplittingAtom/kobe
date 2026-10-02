import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MIGRATION_LOCK_KEY, quoteIdent } from "@kobe/db";
import pg from "pg";
import { listTables, readJournal, serverInfo } from "./catalog.js";
import { EXCLUDED_TABLES, isExcluded } from "./excluded.js";
import {
  DATABASE_FILE,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  OBJECTS_FILE,
  sha256File,
  type Manifest,
} from "./manifest.js";
import { collect, serializeObjectList, type ObjectLister } from "./objects.js";
import { checkToolVersion, libpqConnection, pgBinary, runTool } from "./pg-tools.js";

export interface BackupOptions {
  /** A role with BYPASSRLS (or superuser) that can read every table. */
  readonly databaseUrl: string;
  /** Directory to create; must not exist. Written as `<out>.partial`, renamed when complete. */
  readonly out: string;
  /** null: Postgres only (operator passed --no-objects). */
  readonly objects: ObjectLister | null;
  readonly pgBinDir?: string | undefined;
  readonly log?: (message: string) => void;
}

const PRIVATE_FILE = 0o600;

async function assertAbsent(path: string, what: string): Promise<void> {
  try {
    await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  throw new Error(
    `${what} ${path} already exists; choose a new directory (backups are never overwritten)`,
  );
}

interface Snapshot {
  readonly serverVersion: string;
  readonly migrations: Manifest["migrations"];
  readonly tables: Manifest["tables"];
  readonly excludedTables: Manifest["excludedTables"];
  readonly pgDumpVersion: string;
}

/**
 * Dumps table data from one exported snapshot, so row counts, the migration journal and the dump
 * all describe the same instant. Holds the migration lock (shared) so no migration runs meanwhile.
 */
async function dumpDatabase(options: BackupOptions, dumpPath: string): Promise<Snapshot> {
  const client = new pg.Client({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const info = await serverInfo(client);
    if (!info.superuser && !info.bypassRls) {
      throw new Error(
        `Refusing to back up as "${info.user}": the role is bound by row-level security, so team rows would be missing. Use a role with BYPASSRLS (see docs/backup-restore.md)`,
      );
    }
    const pgDump = pgBinary("pg_dump", options.pgBinDir);
    const pgDumpVersion = await checkToolVersion(pgDump, info.major);

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    try {
      const lock = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_xact_lock_shared($1) AS ok",
        [MIGRATION_LOCK_KEY],
      );
      if (!lock.rows[0]?.ok)
        throw new Error("A migration or restore is running; try again when it finishes");
      // Errors instead of silently filtering rows if RLS would apply after all.
      await client.query("SET LOCAL row_security = off");
      const snapshot = await client.query<{ id: string }>("SELECT pg_export_snapshot() AS id");
      const migrations = await readJournal(client);
      if (migrations.length === 0)
        throw new Error("This database has no Kobe migrations applied; nothing to back up");
      const all = await listTables(client);
      const tables: Manifest["tables"] = [];
      for (const t of all.filter((t) => !isExcluded(t.name))) {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public.${quoteIdent(t.name)}`,
        );
        tables.push({ name: t.name, rows: Number(rows[0]?.n ?? 0) });
      }
      const excludedTables = all
        .filter((t) => isExcluded(t.name))
        .map((t) => ({ name: t.name, reason: EXCLUDED_TABLES[t.name] ?? "" }));

      const conn = libpqConnection(options.databaseUrl);
      await runTool(
        pgDump,
        [
          "--format=custom",
          "--data-only",
          "--schema=public",
          "--no-large-objects",
          "--no-password",
          `--snapshot=${snapshot.rows[0]?.id ?? ""}`,
          ...excludedTables.map((t) => `--exclude-table-data-and-children=public.${t.name}`),
          `--file=${dumpPath}`,
          `--dbname=${conn.dbname}`,
        ],
        { env: conn.env },
      );
      await chmod(dumpPath, PRIVATE_FILE);
      return { serverVersion: info.version, migrations, tables, excludedTables, pgDumpVersion };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** `kobe backup`: data dump + S3 object manifest + manifest.json in a new private directory. */
export async function runBackup(options: BackupOptions): Promise<Manifest> {
  const log = options.log ?? (() => undefined);
  const out = resolve(options.out);
  const partial = `${out}.partial`;
  await assertAbsent(out, "Backup directory");
  await assertAbsent(partial, "Unfinished backup");
  await mkdir(partial, { mode: 0o700 });
  try {
    log("dumping Postgres (one consistent snapshot)…");
    const snap = await dumpDatabase(options, join(partial, DATABASE_FILE));
    const database = {
      path: DATABASE_FILE,
      ...(await sha256File(join(partial, DATABASE_FILE))),
    } as const;

    let objectFile: Manifest["files"]["objects"] = null;
    let objectStorage: Manifest["objectStorage"] = null;
    if (options.objects) {
      log(`listing s3://${options.objects.location.bucket}/${options.objects.location.prefix}…`);
      const objects = await collect(options.objects);
      await writeFile(join(partial, OBJECTS_FILE), serializeObjectList(objects), {
        mode: PRIVATE_FILE,
      });
      objectFile = { path: OBJECTS_FILE, ...(await sha256File(join(partial, OBJECTS_FILE))) };
      objectStorage = {
        ...options.objects.location,
        objects: objects.length,
        bytes: objects.reduce((sum, o) => sum + o.size, 0),
      };
    }

    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      createdAt: new Date().toISOString(),
      postgres: { serverVersion: snap.serverVersion, pgDumpVersion: snap.pgDumpVersion },
      migrations: snap.migrations,
      tables: snap.tables,
      excludedTables: snap.excludedTables,
      files: { database, objects: objectFile },
      objectStorage,
    };
    await writeFile(join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: PRIVATE_FILE,
    });
    await rename(partial, out);
    return manifest;
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
}
