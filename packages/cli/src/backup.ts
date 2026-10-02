import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BLOB_REF_COLUMNS, MIGRATION_LOCK_KEY, quoteIdent, type BlobRefColumn } from "@kobe/db";
import pg from "pg";
import {
  assertCoverage,
  listTables,
  readJournal,
  referencedObjectKeys,
  serverInfo,
} from "./catalog.js";
import { deriveKeys, encryptBuffer, encryptStream, newSalt, type BackupKeys } from "./crypto.js";
import { EXCLUDED_TABLES, isExcluded } from "./excluded.js";
import {
  DATABASE_FILE,
  MANIFEST_FORMAT,
  OBJECTS_FILE,
  sha256File,
  writeSignedManifest,
  type Manifest,
} from "./manifest.js";
import {
  collect,
  serializeObjectList,
  unlistedReferences,
  type ObjectLister,
  type StoredObject,
} from "./objects.js";
import {
  checkToolVersion,
  libpqConnection,
  pgBinary,
  safeToolErrors,
  spawnTool,
  waitForExit,
} from "./pg-tools.js";

export interface BackupOptions {
  /** A role with BYPASSRLS (or superuser) that can read every table. */
  readonly databaseUrl: string;
  /** Directory to create; must not exist. Written as `<out>.partial`, renamed when complete. */
  readonly out: string;
  /** null: Postgres only (operator passed --no-objects; warned loudly). */
  readonly objects: ObjectLister | null;
  /** Operator-held key material; per-backup keys are derived from it. */
  readonly key: Buffer;
  /** Columns holding object keys (default: the @kobe/db registry). */
  readonly blobRefColumns?: readonly BlobRefColumn[];
  readonly pgBinDir?: string | undefined;
  readonly log?: (message: string) => void;
}

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
  readonly pgDumpVersion: string;
  readonly migrations: Manifest["migrations"];
  readonly tables: Manifest["tables"];
  readonly excludedTables: Manifest["excludedTables"];
  readonly auditHead: { readonly seq: number; readonly hash: string } | null;
  readonly objects: readonly StoredObject[] | null;
  readonly referencedObjects: number;
  readonly database: Manifest["files"]["database"];
}

/** pg_dump's custom-format output, encrypted on the fly: no plaintext dump ever touches disk. */
async function dumpEncrypted(
  options: BackupOptions,
  snapshotId: string,
  excluded: readonly string[],
  keys: BackupKeys,
  dest: string,
): Promise<Manifest["files"]["database"]> {
  const pgDump = pgBinary("pg_dump", options.pgBinDir);
  const conn = libpqConnection(options.databaseUrl);
  const child = spawnTool(
    pgDump,
    [
      "--format=custom",
      "--data-only",
      "--schema=public",
      "--no-large-objects",
      "--no-password",
      `--snapshot=${snapshotId}`,
      ...excluded.map((t) => `--exclude-table-data-and-children=public.${t}`),
      `--dbname=${conn.dbname}`,
    ],
    { env: conn.env },
  );
  child.stdin?.end();
  const exit = waitForExit(child, pgDump);
  exit.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
  if (!child.stdout) throw new Error("pg_dump has no output stream");
  const header = await encryptStream(keys.enc, DATABASE_FILE, child.stdout, dest);
  const { code, stderr } = await exit;
  if (code !== 0) throw new Error(`pg_dump failed (exit ${code}): ${safeToolErrors(stderr)}`);
  return { path: DATABASE_FILE, ...(await sha256File(dest)), ...header };
}

/**
 * Everything inside one exported snapshot: row counts, the migration journal, blob references and
 * the dump describe the same instant, and the bucket is listed right after the snapshot was taken.
 * Holds the migration lock (shared) so no migration runs meanwhile.
 */
async function snapshotAndDump(
  options: BackupOptions,
  keys: BackupKeys,
  dir: string,
): Promise<Snapshot> {
  const log = options.log ?? (() => undefined);
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
    const pgDumpVersion = await checkToolVersion(pgBinary("pg_dump", options.pgBinDir), info.major);

    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    try {
      const lock = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_xact_lock_shared($1) AS ok",
        [MIGRATION_LOCK_KEY],
      );
      if (!lock.rows[0]?.ok) {
        throw new Error("A migration or restore is running; try again when it finishes");
      }
      // Errors instead of silently filtering rows if RLS would apply after all.
      await client.query("SET LOCAL row_security = off");
      const snapshot = await client.query<{ id: string }>("SELECT pg_export_snapshot() AS id");

      // List the bucket now, so the listing is as close to the snapshot as possible.
      let objects: StoredObject[] | null = null;
      if (options.objects) {
        log(`listing s3://${options.objects.location.bucket}/${options.objects.location.prefix}…`);
        objects = await collect(options.objects);
      }

      const migrations = await readJournal(client);
      if (migrations.length === 0) {
        throw new Error("This database has no Kobe migrations applied; nothing to back up");
      }
      await assertCoverage(client);
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
      const auditHead = all.some((t) => t.name === "audit_log")
        ? await readAuditHead(client)
        : null;

      const referenced = await referencedObjectKeys(
        client,
        options.blobRefColumns ?? BLOB_REF_COLUMNS,
      );
      if (objects) {
        const unlisted = unlistedReferences(referenced, objects);
        if (unlisted.length > 0) {
          throw new Error(
            `The database references ${unlisted.length} objects that are not in the bucket (e.g. ${unlisted.slice(0, 5).join(", ")}); fix the bucket or retry`,
          );
        }
      } else if (referenced.length > 0) {
        log(`WARNING: ${referenced.length} referenced S3 objects were not checked (--no-objects)`);
      }

      log("dumping Postgres (encrypted)…");
      const database = await dumpEncrypted(
        options,
        snapshot.rows[0]?.id ?? "",
        excludedTables.map((t) => t.name),
        keys,
        join(dir, DATABASE_FILE),
      );
      return {
        serverVersion: info.version,
        pgDumpVersion,
        migrations,
        tables,
        excludedTables,
        auditHead,
        objects,
        referencedObjects: referenced.length,
        database,
      };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * `kobe backup`: encrypted data dump + encrypted S3 object listing + signed manifest, in a new
 * private directory.
 */
export async function runBackup(
  options: BackupOptions,
): Promise<Manifest & { readonly fingerprint: string }> {
  const log = options.log ?? (() => undefined);
  const out = resolve(options.out);
  const partial = `${out}.partial`;
  await assertAbsent(out, "Backup directory");
  await assertAbsent(partial, "Unfinished backup");
  if (!options.objects) {
    log(
      "WARNING: --no-objects: S3 objects are NOT listed or checked; uploads, artifacts and files cannot be verified on restore",
    );
  }
  const salt = newSalt();
  const keys = deriveKeys(options.key, salt);
  await mkdir(partial, { mode: 0o700 });
  try {
    const snap = await snapshotAndDump(options, keys, partial);

    let objectFile: Manifest["files"]["objects"] = null;
    let objectStorage: Manifest["objectStorage"] = null;
    if (options.objects && snap.objects) {
      const sealed = encryptBuffer(
        keys.enc,
        OBJECTS_FILE,
        Buffer.from(serializeObjectList(snap.objects)),
      );
      await writeFile(join(partial, OBJECTS_FILE), sealed.data, { mode: 0o600 });
      objectFile = {
        path: OBJECTS_FILE,
        ...(await sha256File(join(partial, OBJECTS_FILE))),
        iv: sealed.iv,
        tag: sealed.tag,
      };
      objectStorage = {
        ...options.objects.location,
        objects: snap.objects.length,
        bytes: snap.objects.reduce((sum, o) => sum + o.size, 0),
        referencedObjects: snap.referencedObjects,
        blobRefColumns: [...(options.blobRefColumns ?? BLOB_REF_COLUMNS)],
      };
    }

    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      createdAt: new Date().toISOString(),
      postgres: { serverVersion: snap.serverVersion, pgDumpVersion: snap.pgDumpVersion },
      migrations: snap.migrations,
      tables: snap.tables,
      excludedTables: snap.excludedTables,
      auditHead: snap.auditHead,
      files: { database: snap.database, objects: objectFile },
      encryption: { cipher: "aes-256-gcm", kdf: "hkdf-sha256", salt: salt.toString("hex") },
      coverage: { schemas: ["public"], otherSchemasChecked: true, largeObjects: 0 },
      objectStorage,
    };
    const fingerprint = await writeSignedManifest(partial, manifest, keys);
    await rename(partial, out);
    return { ...manifest, fingerprint };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
}

/** Last row of the audit hash chain in the current snapshot (KOBE-15), or null when empty. */
export async function readAuditHead(
  client: pg.ClientBase,
): Promise<{ readonly seq: number; readonly hash: string } | null> {
  const { rows } = await client.query<{ seq: string; hash: string }>(
    `SELECT a.seq::text AS seq, a.hash FROM public.audit_log a ORDER BY a.seq DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? { seq: Number(row.seq), hash: row.hash } : null;
}
