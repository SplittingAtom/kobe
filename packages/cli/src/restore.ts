import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MIGRATION_LOCK_KEY } from "@kobe/db";
import pg from "pg";
import {
  listImmediateForeignKeys,
  listTables,
  listUserTriggers,
  readJournal,
  serverInfo,
  type TableInfo,
} from "./catalog.js";
import { decryptBuffer, decryptFile } from "./crypto.js";
import { isExcluded } from "./excluded.js";
import { readSignedManifest, verifyFile, type Manifest } from "./manifest.js";
import {
  collect,
  compareObjects,
  parseObjectList,
  type ObjectLister,
  type StoredObject,
} from "./objects.js";
import {
  checkToolVersion,
  libpqConnection,
  pgBinary,
  safePsqlErrors,
  safeToolErrors,
  spawnTool,
  waitForExit,
} from "./pg-tools.js";
import { RestrictGuard } from "./restrict-guard.js";
import { journalText, restorePostlude, restorePrelude, type RestorePlan } from "./restore-sql.js";
import { makePrivateWorkDir, removeOnSignal } from "./workdir.js";

export interface RestoreOptions {
  /** The owner role (migrate-url): owns every table, so it can lift FORCE RLS in the transaction. */
  readonly databaseUrl: string;
  readonly from: string;
  /** Operator-held key material: authenticates and decrypts the backup. */
  readonly key: Buffer;
  /** null: object storage not configured for this restore. */
  readonly objects: ObjectLister | null;
  /** Proceed although bucket objects are missing or differ from the backup's listing. */
  readonly allowObjectMismatch: boolean;
  /** Skip object verification (operator passed --no-objects; warned loudly). */
  readonly skipObjects: boolean;
  readonly pgBinDir?: string | undefined;
  /** Where the decrypted dump lives during the restore (KOBE_TMPDIR; default: OS temp dir). */
  readonly tmpDir?: string | undefined;
  readonly log?: (message: string) => void;
}

export interface RestoreReport {
  /** sha256 of manifest.json: compare with the value recorded when the backup was taken. */
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly tables: number;
  readonly rows: number;
  readonly excludedTables: readonly string[];
  readonly objects: { readonly checked: number; readonly problems: number } | null;
}

function describeJournal(migrations: readonly { hash: string }[]): string {
  return migrations.length === 0
    ? "no migrations (Kobe is not installed)"
    : `${migrations.length} migrations, latest ${migrations.at(-1)?.hash.slice(0, 12) ?? ""}`;
}

function checkOwnership(tables: readonly TableInfo[]): void {
  const notOwned = tables.filter((t) => !t.ownedByCurrentUser).map((t) => t.name);
  if (notOwned.length > 0) {
    throw new Error(
      `Restore must run as the owner role (KOBE_DB_MIGRATE_URL); the connected role does not own: ${notOwned.join(", ")}`,
    );
  }
}

/** Read-only checks before anything is locked; the transaction repeats the ones that can race. */
function checkTarget(
  manifest: Manifest,
  tables: readonly TableInfo[],
  journal: RestorePlan["migrations"],
): void {
  if (journalText(journal) !== journalText(manifest.migrations)) {
    throw new Error(
      `The target database's schema does not match the backup: backup has ${describeJournal(manifest.migrations)}, target has ${describeJournal(journal)}. Install the Kobe version the backup was taken with (same migrations), then restore`,
    );
  }
  const unknownExclusions = manifest.excludedTables.filter((t) => !isExcluded(t.name));
  if (unknownExclusions.length > 0) {
    throw new Error(
      `The backup left out tables this kobe never excludes: ${unknownExclusions.map((t) => t.name).join(", ")}; restore with the kobe version that made the backup`,
    );
  }
  const target = new Set(tables.map((t) => t.name));
  const backup = new Set([...manifest.tables, ...manifest.excludedTables].map((t) => t.name));
  const onlyBackup = [...backup].filter((n) => !target.has(n));
  const onlyTarget = [...target].filter((n) => !backup.has(n));
  if (onlyBackup.length > 0 || onlyTarget.length > 0) {
    throw new Error(
      `Table sets differ although migrations match (manual changes?): only in backup: ${onlyBackup.join(", ") || "-"}; only in target: ${onlyTarget.join(", ") || "-"}`,
    );
  }
}

async function checkObjects(
  manifest: Manifest,
  expected: readonly StoredObject[] | null,
  options: RestoreOptions,
): Promise<RestoreReport["objects"]> {
  const log = options.log ?? (() => undefined);
  if (!manifest.objectStorage || expected === null) {
    log(
      "WARNING: this backup has no S3 object listing (taken with --no-objects): uploads, artifacts and files are NOT verified",
    );
    return null;
  }
  if (options.skipObjects || !options.objects) {
    if (!options.skipObjects) {
      throw new Error(
        `The backup lists ${expected.length} S3 objects but object storage is not configured: set KOBE_S3_* to verify them, or pass --no-objects to skip the check`,
      );
    }
    log(`WARNING: --no-objects: ${expected.length} S3 objects are NOT verified`);
    return { checked: 0, problems: 0 };
  }
  log(
    `verifying ${expected.length} objects in s3://${options.objects.location.bucket}/${options.objects.location.prefix}…`,
  );
  const diff = compareObjects(expected, await collect(options.objects));
  if (diff.extra > 0) {
    log(`note: ${diff.extra} objects in the bucket are not in the backup (left untouched)`);
  }
  const problems = diff.missing.length + diff.sizeMismatch.length + diff.etagMismatch.length;
  if (problems > 0) {
    const sample = [
      ...diff.missing.map((o) => o.key),
      ...diff.sizeMismatch.map((o) => o.key),
      ...diff.etagMismatch.map((o) => o.key),
    ].slice(0, 10);
    const message = `${diff.missing.length} objects are missing, ${diff.sizeMismatch.length} differ in size and ${diff.etagMismatch.length} differ in ETag in the target bucket (e.g. ${sample.join(", ")})`;
    if (!options.allowObjectMismatch) {
      throw new Error(
        `${message}. Restore the objects (bucket versioning/replication), or pass --allow-object-mismatch`,
      );
    }
    log(`WARNING: --allow-object-mismatch: ${message}`);
  }
  return { checked: expected.length, problems };
}

/** Streams prelude + pg_restore's data script + postlude into one psql session. */
async function loadData(
  plan: RestorePlan,
  dumpPath: string,
  options: RestoreOptions,
): Promise<void> {
  const psqlBin = pgBinary("psql", options.pgBinDir);
  const restoreBin = pgBinary("pg_restore", options.pgBinDir);
  const conn = libpqConnection(options.databaseUrl);
  const psql = spawnTool(
    psqlBin,
    [
      "--no-psqlrc",
      "--quiet",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=verbose",
      "--set=SHOW_CONTEXT=never",
      `--dbname=${conn.dbname}`,
    ],
    { env: conn.env },
  );
  const psqlExit = waitForExit(psql, psqlBin);
  psqlExit.catch(() => undefined);
  psql.stdout?.resume();
  const dump = spawnTool(restoreBin, ["--data-only", "--file=-", dumpPath]);
  dump.stdin?.end();
  const dumpExit = waitForExit(dump, restoreBin);
  dumpExit.catch(() => undefined);

  async function* script(): AsyncGenerator<string | Buffer> {
    yield restorePrelude(plan);
    // Throwing anywhere below ends psql's input without COMMIT: Postgres rolls everything back.
    const guard = new RestrictGuard();
    for await (const chunk of dump.stdout ?? []) yield* guard.push(chunk as Buffer);
    const { code, stderr } = await dumpExit;
    if (code !== 0) throw new Error(`pg_restore failed (exit ${code}): ${safeToolErrors(stderr)}`);
    yield* guard.finish();
    yield restorePostlude(plan);
  }

  let streamError: unknown = null;
  if (psql.stdin) {
    await pipeline(Readable.from(script()), psql.stdin).catch((err: unknown) => {
      streamError = err;
    });
  }
  const [{ code, stderr }] = await Promise.all([psqlExit, dumpExit.catch(() => undefined)]);
  if (code !== 0) {
    throw new Error(
      `Restore failed and was rolled back; the target is unchanged:\n${safePsqlErrors(stderr) || `psql exited with ${code}`}`,
    );
  }
  if (streamError) {
    throw new Error(
      `Restore failed and was rolled back; the target is unchanged: ${(streamError as Error).message}`,
    );
  }
}

/**
 * `kobe restore`: authenticate the backup (before running any tool), decrypt it into a private
 * temporary directory, verify the target and the bucket, then load all data in one transaction.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreReport> {
  const log = options.log ?? (() => undefined);
  const dir = resolve(options.from);
  const { manifest, keys, fingerprint } = await readSignedManifest(dir, options.key);
  await verifyFile(dir, manifest.files.database);
  let expectedObjects: StoredObject[] | null = null;
  if (manifest.files.objects) {
    const ref = manifest.files.objects;
    await verifyFile(dir, ref);
    const sealed = { iv: ref.iv, tag: ref.tag, data: await readFile(join(dir, ref.path)) };
    expectedObjects = parseObjectList(decryptBuffer(keys.enc, ref.path, sealed).toString("utf8"));
  }
  log(
    `backup ${fingerprint} from ${manifest.createdAt} (signature verified; check both against the values recorded at backup time): ${manifest.tables.length} tables, ${describeJournal(manifest.migrations)}`,
  );

  const work = await makePrivateWorkDir(options.tmpDir);
  const cleanup = removeOnSignal(work);
  try {
    const dumpPath = join(work, "database.dump");
    const ref = manifest.files.database;
    await decryptFile(keys.enc, ref.path, join(dir, ref.path), ref, dumpPath);

    const client = new pg.Client({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    let plan: RestorePlan;
    let major: number;
    try {
      const info = await serverInfo(client);
      major = info.major;
      const tables = await listTables(client);
      checkOwnership(tables);
      checkTarget(manifest, tables, await readJournal(client));
      plan = {
        lockKey: MIGRATION_LOCK_KEY,
        migrations: manifest.migrations,
        lockTables: tables.map((t) => t.name),
        loadTables: manifest.tables,
        forcedRls: tables.filter((t) => t.forcedRls).map((t) => t.name),
        userTriggers: await listUserTriggers(client),
        immediateForeignKeys: await listImmediateForeignKeys(client),
      };
    } finally {
      await client.end().catch(() => undefined);
    }
    await checkToolVersion(pgBinary("pg_restore", options.pgBinDir), major, true);
    await checkToolVersion(pgBinary("psql", options.pgBinDir), major, true);

    const objects = await checkObjects(manifest, expectedObjects, options);
    log("loading data in one transaction…");
    await loadData(plan, dumpPath, options);
    return {
      fingerprint,
      createdAt: manifest.createdAt,
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((sum, t) => sum + t.rows, 0),
      excludedTables: manifest.excludedTables.map((t) => t.name),
      objects,
    };
  } finally {
    cleanup.dispose();
    await rm(work, { recursive: true, force: true });
  }
}
