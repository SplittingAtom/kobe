import { unzipSync } from "fflate";
import {
  eq,
  personalSkillVersions,
  skillHashChecks,
  sql,
  teams,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { checkPackagePaths } from "@kobe/protocol";
import { runtimeHash } from "@kobe/protocol/node";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";

/**
 * What each stored skill hash is under the KOBE-309 package contract (KOBE-310;
 * docs/skill-package.md "Identity"), in the site-wide `skill_hash_checks`:
 *  - same: the stored zip is its own runtime payload (every version stored since KOBE-310);
 *  - alias: the stored zip held `evals/` or `kobe.skill.yaml`, so its runtime hash differs. Many
 *    stored hashes can share one runtime hash; the runtime hash and all of them are one group;
 *  - legacy: today's path rules refuse the stored zip. Its stored hash is its only identity.
 * Rows are written once and never changed.
 */

/** A version stored from KOBE-310 on is its own runtime payload. */
export async function recordRuntimeHash(tx: KobeTx, hash: string): Promise<void> {
  await tx
    .insert(skillHashChecks)
    .values({ storedHash: hash, runtimeHash: hash })
    .onConflictDoNothing();
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

/** Contract problems of a legacy stored hash; null when it is not legacy (or not checked yet). */
export async function legacyProblems(tx: KobeTx, hash: string): Promise<string[] | null> {
  const [row] = await tx
    .select({ problems: skillHashChecks.problems, runtime: skillHashChecks.runtimeHash })
    .from(skillHashChecks)
    .where(eq(skillHashChecks.storedHash, hash));
  return row && row.runtime === null ? row.problems : null;
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

/** The outcome for one stored zip (already verified against its hash). */
export function classifyStoredZip(
  hash: string,
  zip: Uint8Array,
): { runtimeHash: string | null; problems: string[] } {
  const files = new Map(Object.entries(unzipSync(zip)));
  const problems = [...new Set(checkPackagePaths(files.keys()).map((p) => p.problem))].sort();
  if (problems.length > 0) return { runtimeHash: null, problems };
  const runtime = runtimeHash(files);
  return { runtimeHash: runtime === hash ? hash : runtime, problems: [] };
}

/**
 * The one-off recompute (KOBE-310), safe to run any number of times and on several replicas: it
 * checks only stored hashes with no row yet and records each outcome with ON CONFLICT DO NOTHING,
 * so a later run picks up only what is new or was unreadable. Rows and bytes are never rewritten.
 */
export async function recomputeSkillHashes(deps: {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
}): Promise<RecomputeReport> {
  const counts = { checked: 0, same: 0, aliased: 0, legacy: 0, unreadable: 0 };
  for (const stored of await unchecked(deps.db)) {
    const zip = await readVerified(deps.blobs, stored.key, stored.hash, stored.size).catch(
      () => null,
    );
    if (!zip) {
      counts.unreadable++;
      deps.log.error({ hash: stored.hash }, "skills: stored bundle unreadable during recompute");
      continue;
    }
    let outcome: { runtimeHash: string | null; problems: string[] };
    try {
      outcome = classifyStoredZip(stored.hash, zip);
    } catch (err) {
      counts.unreadable++;
      deps.log.error({ err, hash: stored.hash }, "skills: stored bundle is not a readable zip");
      continue;
    }
    await deps.db
      .insert(skillHashChecks)
      .values({ storedHash: stored.hash, ...outcome })
      .onConflictDoNothing();
    counts.checked++;
    if (outcome.runtimeHash === null) counts.legacy++;
    else if (outcome.runtimeHash === stored.hash) counts.same++;
    else counts.aliased++;
  }
  deps.log.info(counts, "skills: stored hashes checked against the package contract");
  return counts;
}
