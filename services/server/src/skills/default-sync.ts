import {
  DEFAULT_SYNC_MAX_ATTEMPTS,
  SYSTEM_ACTOR,
  eq,
  pgCodeOf,
  registrySkills,
  skillDefaultSyncs,
  sql,
  type DefaultSyncKind,
  type KobeDatabase,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { Mailer } from "../mail/mailer.js";
import { LeaseLost, SyncFailure, nextJob, runJob, type Job } from "./default-sync-run.js";
import { lockDefaultSet, type TargetVersion } from "./default-target.js";

/**
 * The Default sync (KOBE-314, SK6–SK8): background jobs that carry a Default tag change, or a move
 * to a new major, into every team. Jobs are queued in the transaction that changes the tag (see
 * `tags.ts`), under the exclusive Default-set lock, so their `seq` follows commit order. They run
 * one at a time in that order on the replica holding the lease (a session advisory lock on a
 * dedicated connection); each team step acts on the tag's current state (`default-sync-run.ts`).
 * Teams are walked in id order; each team's step and the job's progress commit together, so the
 * console's progress is exact and a crashed job resumes after its last team. Steps are idempotent,
 * so a re-sync (an upgrade's, KOBE-317) changes nothing in place and never undoes an opt-out.
 *
 * A job that fails is retried with backoff and, after {@link DEFAULT_SYNC_MAX_ATTEMPTS} attempts,
 * parked as `failed` (logged and audited) so the queue moves on.
 */
const SYNC_LEASE = "kobe.skills.default-sync";

export interface DefaultSyncDeps {
  readonly database: KobeDatabase;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly mailer?: Mailer;
  readonly publicUrl?: string;
  /** First retry delay; doubles per attempt up to {@link BACKOFF_MAX_MS} (tests shorten it). */
  readonly backoffMs?: number;
}

export interface QueueDefaultSync {
  readonly skillId: string;
  readonly kind: DefaultSyncKind;
  /** `add` and `move_major`: the major Default installs follow, and its newest version. */
  readonly target?: TargetVersion;
  readonly requestedBy: string;
}

/**
 * Queues a job in the caller's transaction. It takes the exclusive Default-set lock first (held
 * until commit), so the `seq` drawn at insert follows the order the tag changes commit.
 */
export async function queueDefaultSync(tx: KobeTx, job: QueueDefaultSync): Promise<string> {
  await lockDefaultSet(tx, "exclusive");
  const [row] = await tx
    .insert(skillDefaultSyncs)
    .values({
      skillId: job.skillId,
      kind: job.kind,
      major: job.kind === "remove" ? null : (job.target?.major ?? null),
      versionId: job.kind === "remove" ? null : (job.target?.id ?? null),
      requestedBy: job.requestedBy,
    })
    .returning({ id: skillDefaultSyncs.id });
  if (!row) throw new Error("skills: Default sync insert returned no row");
  return row.id;
}

const BACKOFF_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

const errorCode = (err: unknown): string => {
  if (err instanceof SyncFailure) return err.code;
  const pg = pgCodeOf(err);
  return pg ? `pg_${pg.toLowerCase()}` : "error";
};

/** Counts a failed attempt: a retry after a backoff, or `failed` (audited) after the last one. */
async function recordFailure(deps: DefaultSyncDeps, job: Job, err: unknown): Promise<void> {
  const db = deps.database.db;
  const attempts = job.attempts + 1;
  const code = errorCode(err);
  if (attempts < DEFAULT_SYNC_MAX_ATTEMPTS) {
    const delay = Math.min((deps.backoffMs ?? BACKOFF_MS) * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    await db
      .update(skillDefaultSyncs)
      .set({
        attempts,
        lastError: code,
        nextAttemptAt: sql`now() + make_interval(secs => ${delay / 1000})`,
      })
      .where(eq(skillDefaultSyncs.id, job.id));
    deps.log.warn({ err, jobId: job.id, attempts, code }, "skills: Default sync failed; retrying");
    return;
  }
  await db.transaction(async (tx: KobeTx) => {
    const [parked] = await tx
      .update(skillDefaultSyncs)
      .set({
        attempts,
        lastError: code,
        status: "failed",
        startedAt: sql`coalesce(${skillDefaultSyncs.startedAt}, now())`,
        finishedAt: new Date(),
        nextAttemptAt: null,
      })
      .where(eq(skillDefaultSyncs.id, job.id))
      .returning({ skillId: skillDefaultSyncs.skillId, kind: skillDefaultSyncs.kind });
    if (!parked) return;
    const [skill] = await tx
      .select({ name: registrySkills.name })
      .from(registrySkills)
      .where(eq(registrySkills.id, parked.skillId));
    await recordAudit(tx, {
      action: "skill.default.sync_failed",
      actor: SYSTEM_ACTOR,
      target: {
        skillId: parked.skillId,
        name: skill?.name ?? "skill",
        kind: parked.kind,
        attempts,
        error: code,
      },
    });
  });
  deps.log.error({ err, jobId: job.id, attempts, code }, "skills: Default sync parked as failed");
}

/** Runs every job that is due, oldest first. Stops when the lease turns out to be lost. */
async function drain(deps: DefaultSyncDeps): Promise<number> {
  const db: KobeDb = deps.database.db;
  const run = { db, log: deps.log, mailer: deps.mailer, publicUrl: deps.publicUrl };
  let ran = 0;
  for (let [job] = await nextJob(db); job; [job] = await nextJob(db)) {
    try {
      await runJob(run, job);
    } catch (err) {
      if (err instanceof LeaseLost) {
        deps.log.warn({ jobId: job.id }, "skills: Default sync lease lost; stopping");
        return ran;
      }
      const [fresh] = await db
        .select()
        .from(skillDefaultSyncs)
        .where(eq(skillDefaultSyncs.id, job.id));
      await recordFailure(deps, fresh ?? job, err);
    }
    ran += 1;
  }
  return ran;
}

/**
 * Runs every due Default sync job, on this replica if no other holds the lease. Returns the jobs
 * attempted, or null when another replica holds the lease.
 */
export async function defaultSyncOnce(deps: DefaultSyncDeps): Promise<number | null> {
  const client = await deps.database.pool.connect();
  let destroy = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [SYNC_LEASE],
    );
    if (!rows[0]?.locked) return null;
    try {
      return await drain(deps);
    } finally {
      await client
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [SYNC_LEASE])
        .catch((err: unknown) => {
          deps.log.warn({ err }, "skills: Default sync unlock failed; dropping the connection");
          destroy = true;
        });
    }
  } finally {
    client.release(destroy);
  }
}

/** How often each server looks for due jobs (one indexed query when there are none). */
export const DEFAULT_SYNC_EVERY_MS = 10_000;

/** Runs {@link defaultSyncOnce} whenever a job is due; returns a stop function. */
export function startDefaultSync(
  deps: DefaultSyncDeps & { readonly everyMs?: number },
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    nextJob(deps.database.db)
      .then(([job]) => (job ? defaultSyncOnce(deps) : null))
      .catch((err: unknown) => deps.log.error({ err }, "skills: Default sync failed"))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, deps.everyMs ?? DEFAULT_SYNC_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
