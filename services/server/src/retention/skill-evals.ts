import { lockLegalHolds, sql, teams, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { logger } from "../logger.js";
import type { BlobStore } from "./blobs.js";

// Skill eval runs (KOBE-325) follow team retention by their start and offboarding by their
// starter. A held starter's run is skipped silently by its row trigger (0146): DELETE … RETURNING
// returns only the rows really deleted, and only their objects (the runtime bundle, the fixtures)
// are removed from the bucket, after the delete committed. Open runs are never purged; their
// eval threads are ordinary team threads with their own retention.

const BATCH = 200;

export interface EvalPurgeCounts {
  readonly runs: number;
  readonly objects: number;
}

export const NO_EVAL_PURGE: EvalPurgeCounts = { runs: 0, objects: 0 };

const FINISHED = sql.raw(`('completed', 'failed', 'cancelled', 'budget_stopped')`);

async function deleteObjects(blobs: BlobStore | undefined, keys: readonly string[]) {
  if (!blobs || keys.length === 0) return 0;
  try {
    await blobs.objects.delete(keys);
    return keys.length;
  } catch (err) {
    logger.warn({ err, keys: keys.length }, "skill evals: objects could not be deleted (orphaned)");
    return 0;
  }
}

async function purge(
  db: KobeDb,
  blobs: BlobStore | undefined,
  teamId: string,
  stop: (() => boolean) | undefined,
  select: (tx: KobeTx) => ReturnType<KobeTx["execute"]>,
): Promise<EvalPurgeCounts> {
  let runs = 0;
  let objects = 0;
  for (;;) {
    if (stop?.()) break;
    const keys = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      const res = await select(tx);
      return res.rows as { bundle_key: string; fixtures_key: string | null }[];
    });
    runs += keys.length;
    objects += await deleteObjects(
      blobs,
      keys.flatMap((k) => (k.fixtures_key ? [k.bundle_key, k.fixtures_key] : [k.bundle_key])),
    );
    if (keys.length < BATCH) break;
  }
  return { runs, objects };
}

/** Finished eval runs started before `cutoff` (the team's window), with their objects. */
export function purgeSkillEvals(
  db: KobeDb,
  blobs: BlobStore | undefined,
  teamId: string,
  cutoff: Date | null,
  options: { readonly stop?: () => boolean } = {},
): Promise<EvalPurgeCounts> {
  if (cutoff === null) return Promise.resolve(NO_EVAL_PURGE);
  return purge(db, blobs, teamId, options.stop, (tx) =>
    tx.execute(sql`
      DELETE FROM skill_eval_runs r
       WHERE r.team_id = ${teamId} AND r.id IN (
         SELECT k.id FROM skill_eval_runs k
          WHERE k.team_id = ${teamId} AND k.started_at < ${cutoff.toISOString()}
            AND k.status IN ${FINISHED}
          ORDER BY k.started_at, k.id LIMIT ${BATCH})
      RETURNING r.bundle_key, r.fixtures_key`),
  );
}

/**
 * One team's departed starters (offboarding): finished eval runs whose starter is no longer an
 * active member, finished more than `retainDays` ago.
 */
export function purgeDepartedSkillEvals(
  db: KobeDb,
  blobs: BlobStore | undefined,
  teamId: string,
  retainDays: number,
  options: { readonly stop?: () => boolean } = {},
): Promise<EvalPurgeCounts> {
  return purge(db, blobs, teamId, options.stop, (tx) =>
    tx.execute(sql`
      DELETE FROM skill_eval_runs r
       WHERE r.team_id = ${teamId} AND r.id IN (
         SELECT k.id FROM skill_eval_runs k
          WHERE k.team_id = ${teamId} AND k.status IN ${FINISHED}
            AND k.finished_at <= now() - make_interval(days => ${retainDays})
            AND NOT EXISTS (
              SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
               WHERE m.team_id = k.team_id AND m.user_id = k.started_by
                 AND u.deactivated_at IS NULL)
          ORDER BY k.finished_at, k.id LIMIT ${BATCH})
      RETURNING r.bundle_key, r.fixtures_key`),
  );
}

/** Every team's departed starters. */
export async function sweepDepartedSkillEvals(
  db: KobeDb,
  blobs: BlobStore | undefined,
  retainDays: number,
): Promise<number> {
  let runs = 0;
  for (const team of await db.select({ id: teams.id }).from(teams))
    runs += (await purgeDepartedSkillEvals(db, blobs, team.id, retainDays)).runs;
  return runs;
}
