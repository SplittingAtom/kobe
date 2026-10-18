import {
  SYSTEM_ACTOR,
  and,
  asc,
  eq,
  gt,
  ne,
  registrySkills,
  skillDefaultSyncs,
  sql,
  teams,
  withTeam,
  type DefaultSyncKind,
  type KobeDatabase,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { Mailer } from "../mail/mailer.js";
import { newestApproved, type TargetVersion } from "./default-target.js";
import { notifyTeamAdmins, type DefaultNotice } from "./default-notify.js";
import { addInTeam, moveInTeam, removeInTeam, type TeamStepResult } from "./default-sync-team.js";

/**
 * The Default sync (KOBE-314, SK6–SK8): background jobs that carry a Default tag change, or a move
 * to a new major, into every team. Jobs are queued in the transaction that changes the tag (see
 * `tags.ts`) and run one at a time, oldest first, on the replica holding the lease (a session
 * advisory lock on a dedicated connection). Teams are walked in id order; each team's step and the
 * job's progress (counts, cursor) commit together, so the console's progress is exact and a job
 * resumed after a crash continues after the last team it finished. Steps are idempotent, so
 * running the same kind of job again (an upgrade's re-sync, KOBE-317) changes nothing that is in
 * place and never undoes an opt-out.
 */
const SYNC_LEASE = "kobe.skills.default-sync";
const TEAM_BATCH = 50;

export interface DefaultSyncDeps {
  readonly database: KobeDatabase;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly mailer?: Mailer;
  readonly publicUrl?: string;
}

export interface QueueDefaultSync {
  readonly skillId: string;
  readonly kind: DefaultSyncKind;
  /** `add` and `move_major`: the major Default installs follow, and its newest version. */
  readonly target?: TargetVersion;
  readonly requestedBy: string;
}

/** Queues a job (in the caller's transaction, which holds the Default-set lock). */
export async function queueDefaultSync(tx: KobeTx, job: QueueDefaultSync): Promise<string> {
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

type Job = typeof skillDefaultSyncs.$inferSelect;

const pending = (db: KobeDb) =>
  db
    .select()
    .from(skillDefaultSyncs)
    .where(ne(skillDefaultSyncs.status, "done"))
    .orderBy(asc(skillDefaultSyncs.createdAt), asc(skillDefaultSyncs.id))
    .limit(1);

/** Marks a queued job running and records how many teams it starts with. */
async function start(db: KobeDb, job: Job): Promise<void> {
  if (job.status !== "queued") return;
  await db
    .update(skillDefaultSyncs)
    .set({
      status: "running",
      startedAt: new Date(),
      teamsTotal: sql`(SELECT count(*)::integer FROM teams)`,
    })
    .where(and(eq(skillDefaultSyncs.id, job.id), eq(skillDefaultSyncs.status, "queued")));
}

const add = (column: keyof TeamStepResult, step: TeamStepResult) => {
  const col = {
    installed: skillDefaultSyncs.installed,
    kept: skillDefaultSyncs.kept,
    optedOut: skillDefaultSyncs.optedOut,
    converted: skillDefaultSyncs.converted,
    optoutsCleared: skillDefaultSyncs.optoutsCleared,
    moved: skillDefaultSyncs.moved,
  }[column];
  return sql`${col} + ${step[column]}`;
};

/** What a team's step changed that its admins hear about (SK8); null for nothing to tell. */
function noticeOf(kind: DefaultSyncKind, step: TeamStepResult): DefaultNotice | null {
  if (kind === "add" && step.installed + step.kept > 0)
    return { kind: "added", installed: step.installed > 0 };
  if (kind === "remove" && step.kept + step.converted + step.optoutsCleared > 0)
    return { kind: "removed" };
  return null;
}

async function teamStep(
  tx: KobeTx,
  job: Job,
  teamId: string,
  version: TargetVersion | null,
): Promise<TeamStepResult> {
  if (job.kind === "remove") return removeInTeam(tx, teamId, job.skillId);
  if (!version) throw new Error("skills: Default sync without a version");
  return job.kind === "add"
    ? addInTeam(tx, teamId, job.skillId, version, job.requestedBy)
    : moveInTeam(tx, teamId, job.skillId, version);
}

/** One team: its step and the job's progress in one transaction, then the notice. */
async function syncTeam(
  deps: DefaultSyncDeps,
  job: Job,
  team: { readonly id: string; readonly name: string },
  skillName: string,
  version: TargetVersion | null,
): Promise<void> {
  const db = deps.database.db;
  const step = await withTeam(db, team.id, async (tx) => {
    const result = await teamStep(tx, job, team.id, version);
    await tx
      .update(skillDefaultSyncs)
      .set({
        teamsDone: sql`${skillDefaultSyncs.teamsDone} + 1`,
        afterTeamId: team.id,
        installed: add("installed", result),
        kept: add("kept", result),
        optedOut: add("optedOut", result),
        converted: add("converted", result),
        optoutsCleared: add("optoutsCleared", result),
        moved: add("moved", result),
      })
      .where(eq(skillDefaultSyncs.id, job.id));
    return result;
  });
  const notice = noticeOf(job.kind, step);
  if (notice && deps.mailer && deps.publicUrl) {
    await notifyTeamAdmins(
      { db, mailer: deps.mailer, publicUrl: deps.publicUrl },
      team,
      skillName,
      notice,
    ).catch((err: unknown) =>
      deps.log.warn({ err, teamId: team.id, jobId: job.id }, "skills: Default notice failed"),
    );
  }
}

/** Ends the job and records its totals in the site audit. */
async function finish(db: KobeDb, jobId: string, skillName: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [done] = await tx
      .update(skillDefaultSyncs)
      // Teams created during the run are walked too, so the total is at least the teams done.
      .set({
        status: "done",
        finishedAt: new Date(),
        teamsTotal: sql`greatest(${skillDefaultSyncs.teamsTotal}, ${skillDefaultSyncs.teamsDone})`,
      })
      .where(and(eq(skillDefaultSyncs.id, jobId), ne(skillDefaultSyncs.status, "done")))
      .returning();
    if (!done) return;
    await recordAudit(tx, {
      action: "skill.default.synced",
      actor: SYSTEM_ACTOR,
      target: {
        skillId: done.skillId,
        name: skillName,
        kind: done.kind,
        teams: done.teamsDone,
        installed: done.installed,
        kept: done.kept,
        optedOut: done.optedOut,
        converted: done.converted,
        optoutsCleared: done.optoutsCleared,
        moved: done.moved,
      },
    });
  });
}

/** Runs one job to its end (or resumes it after its cursor). */
async function runJob(deps: DefaultSyncDeps, queued: Job): Promise<void> {
  const db = deps.database.db;
  await start(db, queued);
  const [job] = await db
    .select()
    .from(skillDefaultSyncs)
    .where(eq(skillDefaultSyncs.id, queued.id));
  if (!job || job.status === "done") return;
  const [skill] = await db
    .select({ name: registrySkills.name })
    .from(registrySkills)
    .where(eq(registrySkills.id, job.skillId));
  const skillName = skill?.name ?? "skill";
  // The newest approved version of the job's major now (a version may have been withdrawn or
  // approved since the job was queued); none left means there is nothing to install or move to.
  const version =
    job.kind === "remove" || job.major === null
      ? null
      : await newestApproved(db, job.skillId, job.major);
  if (job.kind !== "remove" && !version) {
    deps.log.warn(
      { jobId: job.id, skillId: job.skillId, major: job.major },
      "skills: Default sync has no approved version in its major; nothing to do",
    );
    await finish(db, job.id, skillName);
    return;
  }
  let after = job.afterTeamId;
  for (;;) {
    const batch = await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(after ? gt(teams.id, after) : undefined)
      .orderBy(asc(teams.id))
      .limit(TEAM_BATCH);
    for (const team of batch) await syncTeam(deps, job, team, skillName, version);
    if (batch.length < TEAM_BATCH) break;
    after = batch[batch.length - 1]?.id ?? null;
  }
  await finish(db, job.id, skillName);
  deps.log.info(
    { jobId: job.id, kind: job.kind, skillId: job.skillId },
    "skills: Default sync done",
  );
}

/**
 * Runs every queued or unfinished Default sync job, on this replica if no other holds the lease.
 * Returns the jobs run, or null when another replica holds the lease.
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
      let ran = 0;
      for (
        let [job] = await pending(deps.database.db);
        job;
        [job] = await pending(deps.database.db)
      ) {
        await runJob(deps, job);
        ran += 1;
      }
      return ran;
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

/** How often each server looks for queued jobs (one indexed query when there are none). */
export const DEFAULT_SYNC_EVERY_MS = 10_000;

/** Runs {@link defaultSyncOnce} whenever a job is waiting; returns a stop function. */
export function startDefaultSync(
  deps: DefaultSyncDeps & { readonly everyMs?: number },
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    pending(deps.database.db)
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
