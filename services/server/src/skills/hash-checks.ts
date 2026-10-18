import { unzipSync } from "fflate";
import {
  eq,
  personalSkillVersions,
  skillHashChecks,
  sql,
  teams,
  teamSkillVersions,
  withTeam,
  type KobeDatabase,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { checkPackagePaths, MANIFEST_PATH } from "@kobe/protocol";
import { runtimeHash } from "@kobe/protocol/node";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";
import { readManifest } from "./bundle.js";
import { parseSkillMd } from "./skill-md.js";

/**
 * What each stored skill hash is under the KOBE-309 package contract (KOBE-310;
 * docs/skill-package.md "Identity"), in the site-wide `skill_hash_checks`:
 *  - same: the stored zip is its own runtime payload (every version stored since KOBE-310);
 *  - alias: the stored zip held `evals/` or `kobe.skill.yaml`, so its runtime hash differs. Many
 *    stored hashes can share one runtime hash; the runtime hash and all of them are one group;
 *  - legacy: today's path rules refuse the stored zip. Its stored hash is its only identity.
 * Rows are written once and never changed.
 */

/**
 * A version stored from KOBE-310 on is its own runtime payload; its package zip, when it has one,
 * joins the runtime hash's group, so blocking the hash of a downloaded package blocks the skill.
 */
export async function recordUploadHashes(
  tx: KobeTx,
  hashes: { readonly runtimeHash: string; readonly packageHash: string },
): Promise<void> {
  const rows = [{ storedHash: hashes.runtimeHash, runtimeHash: hashes.runtimeHash }];
  if (hashes.packageHash !== hashes.runtimeHash)
    rows.push({ storedHash: hashes.packageHash, runtimeHash: hashes.runtimeHash });
  await tx.insert(skillHashChecks).values(rows).onConflictDoNothing();
}

/**
 * The group each of `hashes` belongs to (itself included): its runtime hash and every stored hash
 * aliased to that. One query; a hash nobody checked yet is a group of one.
 */
export async function hashGroups(
  tx: KobeTx,
  hashes: readonly string[],
): Promise<Map<string, string[]>> {
  const unique = [...new Set(hashes)];
  const groups = new Map(unique.map((h) => [h, new Set([h])]));
  if (unique.length === 0) return new Map();
  const { rows } = await tx.execute<{ hash: string; member: string }>(sql`
    WITH input AS (SELECT unnest(${sql.param(unique)}::text[]) AS hash),
    roots AS (
      SELECT i.hash, coalesce(c.runtime_hash, i.hash) AS root
        FROM input i LEFT JOIN skill_hash_checks c ON c.stored_hash = i.hash
    )
    SELECT r.hash, r.root AS member FROM roots r
    UNION
    SELECT r.hash, c.stored_hash AS member
      FROM roots r JOIN skill_hash_checks c ON c.runtime_hash = r.root`);
  for (const { hash, member } of rows) groups.get(hash)?.add(member);
  return new Map([...groups].map(([h, members]) => [h, [...members].sort()]));
}

export type HashOutcome =
  | { readonly runtimeHash: string; readonly problems: readonly [] }
  | { readonly runtimeHash: null; readonly problems: readonly string[] };

/** The recorded outcome for a stored hash; null when it has not been checked yet. */
export async function hashOutcome(tx: KobeTx, hash: string): Promise<HashOutcome | null> {
  const [row] = await tx
    .select({ problems: skillHashChecks.problems, runtime: skillHashChecks.runtimeHash })
    .from(skillHashChecks)
    .where(eq(skillHashChecks.storedHash, hash));
  if (!row) return null;
  return row.runtime === null
    ? { runtimeHash: null, problems: row.problems }
    : { runtimeHash: row.runtime, problems: [] };
}

/**
 * Checks one stored zip (bytes already verified against `hash`) and records the outcome; the
 * recorded row wins if another runner was first. Used by the recompute and, on demand, by export,
 * so an unchecked hash is never treated as clean.
 */
export async function checkStoredZip(
  db: KobeDb,
  hash: string,
  zip: Uint8Array,
): Promise<HashOutcome> {
  const outcome = classifyStoredZip(hash, zip);
  await db
    .insert(skillHashChecks)
    .values({ storedHash: hash, runtimeHash: outcome.runtimeHash, problems: [...outcome.problems] })
    .onConflictDoNothing();
  return (await db.transaction((tx) => hashOutcome(tx, hash))) ?? outcome;
}

export interface RecomputeReport {
  readonly checked: number;
  readonly same: number;
  readonly aliased: number;
  readonly legacy: number;
  /** Bytes missing or not matching their hash: left unrecorded, retried by the next run. */
  readonly unreadable: number;
}

interface Stored {
  readonly hash: string;
  readonly key: string;
  readonly size: number;
}

/** Every distinct stored hash not checked yet, with one key holding its bytes. */
async function unchecked(db: KobeDb): Promise<Stored[]> {
  const found = new Map<string, Stored>();
  const add = (rows: readonly { hash: string; key: string; size: number }[]) => {
    for (const r of rows) if (!found.has(r.hash)) found.set(r.hash, r);
  };
  const notChecked = (column: unknown) =>
    sql`NOT EXISTS (SELECT 1 FROM skill_hash_checks c WHERE c.stored_hash = ${column})`;
  add(
    await db
      .select({
        hash: personalSkillVersions.contentHash,
        key: personalSkillVersions.storageKey,
        size: personalSkillVersions.sizeBytes,
      })
      .from(personalSkillVersions)
      .where(notChecked(personalSkillVersions.contentHash)),
  );
  for (const { id } of await db.select({ id: teams.id }).from(teams)) {
    add(
      await withTeam(db, id, (tx) =>
        tx
          .select({
            hash: teamSkillVersions.contentHash,
            key: teamSkillVersions.storageKey,
            size: teamSkillVersions.sizeBytes,
          })
          .from(teamSkillVersions)
          .where(
            sql`${teamSkillVersions.teamId} = ${id} AND ${notChecked(teamSkillVersions.contentHash)}`,
          ),
      ),
    );
  }
  return [...found.values()];
}

/**
 * The outcome for one stored zip (already verified against its hash): legacy when today's path
 * rules refuse it, or when its SKILL.md or `kobe.skill.yaml` (never read before KOBE-310) is
 * invalid; otherwise its runtime hash. Rows are written once and never re-evaluated, so a later
 * tightening of the rules applies to new uploads only.
 */
export function classifyStoredZip(hash: string, zip: Uint8Array): HashOutcome {
  const files = new Map(Object.entries(unzipSync(zip)));
  const problems = new Set<string>(checkPackagePaths(files.keys()).map((p) => p.problem));
  if (problems.size === 0) {
    const skillMd = files.get("SKILL.md");
    const parsed = skillMd ? parseSkillMd(skillMd) : "missing";
    if (typeof parsed === "string") problems.add("invalid_skill_md");
    else if (!readManifest(files.get(MANIFEST_PATH), parsed.name).ok)
      problems.add("invalid_manifest");
  }
  if (problems.size > 0) return { runtimeHash: null, problems: [...problems].sort() };
  const runtime = runtimeHash(files);
  return { runtimeHash: runtime === hash ? hash : runtime, problems: [] };
}

/**
 * The recompute (KOBE-310), safe to run any number of times and on several replicas: it checks
 * only stored hashes with no row yet and records each outcome with ON CONFLICT DO NOTHING, so a
 * later run picks up only what is new (rows a pod of the previous release wrote during a rolling
 * upgrade, or after a rollback) or was unreadable. Rows and bytes are never rewritten.
 */
export async function recomputeSkillHashes(deps: {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
}): Promise<RecomputeReport> {
  const counts = { checked: 0, same: 0, aliased: 0, legacy: 0, unreadable: 0 };
  const todo = await unchecked(deps.db);
  for (const [i, stored] of todo.entries()) {
    if (i > 0 && i % PROGRESS_EVERY === 0)
      deps.log.info({ done: i, of: todo.length }, "skills: checking stored hashes");
    const zip = await readVerified(deps.blobs, stored.key, stored.hash, stored.size).catch(
      () => null,
    );
    if (!zip) {
      counts.unreadable++;
      deps.log.error({ hash: stored.hash }, "skills: stored bundle unreadable during recompute");
      continue;
    }
    let outcome: HashOutcome;
    try {
      outcome = await checkStoredZip(deps.db, stored.hash, zip);
    } catch (err) {
      counts.unreadable++;
      deps.log.error({ err, hash: stored.hash }, "skills: stored bundle is not a readable zip");
      continue;
    }
    counts.checked++;
    if (outcome.runtimeHash === null) counts.legacy++;
    else if (outcome.runtimeHash === stored.hash) counts.same++;
    else counts.aliased++;
  }
  if (todo.length > 0)
    deps.log.info(counts, "skills: stored hashes checked against the package contract");
  return counts;
}

const PROGRESS_EVERY = 100;
const RECOMPUTE_LOCK = "kobe.skills.hash_recompute";

/**
 * One recompute on this replica if no other replica is running one: a session advisory lock on a
 * dedicated connection, released (with the connection) when the run ends. Returns null when
 * another replica holds it.
 */
export async function recomputeOnce(deps: {
  readonly database: KobeDatabase;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
}): Promise<RecomputeReport | null> {
  const client = await deps.database.pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [RECOMPUTE_LOCK],
    );
    if (!rows[0]?.locked) return null;
    try {
      return await recomputeSkillHashes({ db: deps.database.db, blobs: deps.blobs, log: deps.log });
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [RECOMPUTE_LOCK]);
    }
  } finally {
    client.release();
  }
}

/** How often each server looks for stored hashes not checked yet (cheap when there are none). */
export const RECOMPUTE_EVERY_MS = 10 * 60_000;

/**
 * Runs {@link recomputeOnce} now and every {@link RECOMPUTE_EVERY_MS}, never two at once on this
 * replica. Returns a stop function. Failures are logged; the next tick retries.
 */
export function startSkillHashRecompute(deps: {
  readonly database: KobeDatabase;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly everyMs?: number;
}): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    recomputeOnce(deps)
      .catch((err: unknown) => deps.log.error({ err }, "skills: stored hash recompute failed"))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, deps.everyMs ?? RECOMPUTE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
