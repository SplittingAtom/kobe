import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MIGRATION_LOCK_KEY } from "@kobe/db";
import pg from "pg";
import {
  listTables,
  listUserTriggers,
  readJournal,
  serverInfo,
  type TableInfo,
} from "./catalog.js";
import {
  MANIFEST_FILE,
  OBJECTS_FILE,
  parseManifest,
  verifyFile,
  type Manifest,
} from "./manifest.js";
import { isExcluded } from "./excluded.js";
import { collect, compareObjects, parseObjectList, type ObjectLister } from "./objects.js";
import { checkToolVersion, libpqConnection, pgBinary, spawnTool, waitForExit } from "./pg-tools.js";
import { journalText, restorePostlude, restorePrelude, type RestorePlan } from "./restore-sql.js";

export interface RestoreOptions {
  /** The owner role (migrate-url): owns every table, so it can lift FORCE RLS in the transaction. */
  readonly databaseUrl: string;
  readonly from: string;
  /** null: object storage not configured for this restore. */
  readonly objects: ObjectLister | null;
  /** Proceed although objects listed in the backup are missing or unverified. */
  readonly allowMissingObjects: boolean;
  readonly pgBinDir?: string | undefined;
  readonly log?: (message: string) => void;
}

export interface RestoreReport {
  readonly tables: number;
  readonly rows: number;
  readonly excludedTables: readonly string[];
  readonly objects: { readonly checked: number; readonly missing: number } | null;
}

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

async function readBackup(
  dir: string,
): Promise<{ manifest: Manifest; objectsText: string | null }> {
  const path = join(dir, MANIFEST_FILE);
  const size = (await stat(path)).size;
  if (size > MAX_MANIFEST_BYTES)
    throw new Error(`${MANIFEST_FILE} is too large to be a Kobe manifest`);
  const manifest = parseManifest(await readFile(path, "utf8"));
  await verifyFile(dir, manifest.files.database);
  let objectsText: string | null = null;
  if (manifest.files.objects) {
    await verifyFile(dir, manifest.files.objects);
    objectsText = await readFile(join(dir, OBJECTS_FILE), "utf8");
  }
  return { manifest, objectsText };
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
  objectsText: string | null,
  options: RestoreOptions,
): Promise<RestoreReport["objects"]> {
  const log = options.log ?? (() => undefined);
  if (!manifest.objectStorage || objectsText === null) return null;
  const expected = parseObjectList(objectsText);
  if (!options.objects) {
    if (!options.allowMissingObjects) {
      throw new Error(
        `The backup lists ${expected.length} S3 objects but object storage is not configured: set KOBE_S3_* to verify them, or pass --allow-missing-objects`,
      );
    }
    log(`WARNING: ${expected.length} S3 objects were not verified (no object storage configured)`);
    return { checked: 0, missing: expected.length };
  }
  log(
    `verifying ${expected.length} objects in s3://${options.objects.location.bucket}/${options.objects.location.prefix}…`,
  );
  const diff = compareObjects(expected, await collect(options.objects));
  const problems = diff.missing.length + diff.sizeMismatch.length;
  if (diff.etagMismatch > 0)
    log(`note: ${diff.etagMismatch} objects have the same size but a different ETag`);
  if (diff.extra > 0)
    log(`note: ${diff.extra} objects in the bucket are not in the backup (left untouched)`);
  if (problems > 0) {
    const sample = [
      ...diff.missing.map((o) => o.key),
      ...diff.sizeMismatch.map((o) => o.key),
    ].slice(0, 10);
    const message = `${diff.missing.length} objects are missing and ${diff.sizeMismatch.length} differ in size in the target bucket (e.g. ${sample.join(", ")})`;
    if (!options.allowMissingObjects) {
      throw new Error(`${message}. Copy them into the bucket, or pass --allow-missing-objects`);
    }
    log(`WARNING: ${message}`);
  }
  return { checked: expected.length, missing: problems };
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
    ["--no-psqlrc", "--quiet", "--no-password", "--set=ON_ERROR_STOP=1", `--dbname=${conn.dbname}`],
    { env: conn.env },
  );
  const psqlExit = waitForExit(psql, psqlBin);
  psql.stdout?.resume();
  const dump = spawnTool(restoreBin, ["--data-only", "--file=-", dumpPath]);
  dump.stdin?.end();
  const dumpExit = waitForExit(dump, restoreBin);

  async function* script(): AsyncGenerator<string | Buffer> {
    yield restorePrelude(plan);
    for await (const chunk of dump.stdout ?? []) yield chunk as Buffer;
    const { code, stderr } = await dumpExit;
    // Without COMMIT, psql's session ends and Postgres rolls everything back.
    if (code !== 0) throw new Error(`pg_restore failed (exit ${code}): ${stderr.trim()}`);
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
    const reason = stderr
      .split("\n")
      .filter((l) => /ERROR|FATAL|psql:/.test(l))
      .join("\n");
    throw new Error(
      `Restore failed and was rolled back; the target is unchanged:\n${reason || stderr.trim()}`,
    );
  }
  if (streamError) {
    throw new Error(
      `Restore failed and was rolled back; the target is unchanged: ${(streamError as Error).message}`,
    );
  }
}

/** `kobe restore`: verify the backup and the target, then load all data in one transaction. */
export async function runRestore(options: RestoreOptions): Promise<RestoreReport> {
  const log = options.log ?? (() => undefined);
  const dir = resolve(options.from);
  const { manifest, objectsText } = await readBackup(dir);
  log(
    `backup from ${manifest.createdAt}: ${manifest.tables.length} tables, ${describeJournal(manifest.migrations)}`,
  );

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
    };
  } finally {
    await client.end().catch(() => undefined);
  }
  await checkToolVersion(pgBinary("pg_restore", options.pgBinDir), major);
  await checkToolVersion(pgBinary("psql", options.pgBinDir), major);

  const objects = await checkObjects(manifest, objectsText, options);
  log("loading data in one transaction…");
  await loadData(plan, join(dir, manifest.files.database.path), options);
  return {
    tables: manifest.tables.length,
    rows: manifest.tables.reduce((sum, t) => sum + t.rows, 0),
    excludedTables: manifest.excludedTables.map((t) => t.name),
    objects,
  };
}
