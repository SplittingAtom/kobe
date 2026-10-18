import {
  SYSTEM_ACTOR,
  and,
  asc,
  eq,
  gt,
  isNull,
  lt,
  ne,
  or,
  registrySkills,
  skillDefaultSyncs,
  sql,
  teams,
  withTeam,
  type DefaultSyncKind,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { Mailer } from "../mail/mailer.js";
import { notifyTeamAdmins, type DefaultNotice } from "./default-notify.js";
import {
  NOTHING,
  addInTeam,
  auditApplied,
  changesOf,
  moveInTeam,
  removeInTeam,
  type TeamStepResult,
} from "./default-sync-team.js";
import {
  defaultTargets,
  isDefaultSkill,
  lockDefaultSet,
  newestApproved,
  type TargetVersion,
} from "./default-target.js";

/**
 * Running one Default sync job (KOBE-314, SK6–SK8). Each team's step re-reads the tag under the
 * shared Default-set lock and acts on the state it finds, not on the event that queued the job:
 * an `add` installs only while the skill is Default, a `remove` converts only once it is not, a
 * `move_major` moves only while its major is the Default's current one. So jobs that ran late or
 * out of order, or a fast off-on toggle, can never install a skill that is not Default.
 */
export type Job = typeof skillDefaultSyncs.$inferSelect;

export interface RunDeps {
  readonly db: KobeDb;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly mailer?: Mailer | undefined;
  readonly publicUrl?: string | undefined;
}

const TEAM_BATCH = 50;

/** A job that cannot make progress; its code is stored and audited (never a message). */
export class SyncFailure extends Error {
  constructor(readonly code: string) {
    super(`skills: Default sync failed: ${code}`);
  }
}

/** Another replica took over the job (the lease connection dropped): stop without a trace. */
export class LeaseLost extends Error {
  constructor() {
    super("skills: Default sync lease lost");
  }
}

const COUNTS = [
  "installed",
  "kept",
  "optedOut",
  "blocked",
  "converted",
  "optoutsCleared",
  "moved",
] as const;

const plus = (step: TeamStepResult) =>
  Object.fromEntries(COUNTS.map((k) => [k, sql`${skillDefaultSyncs[k]} + ${step[k]}`])) as Record<
    (typeof COUNTS)[number],
    ReturnType<typeof sql>
  >;

/** Team counts that the minimum-count rule (SK26) hides when they are 1 or 2. */
export const isMasked = (j: Pick<Job, "optedOut" | "optoutsCleared" | "blocked">): boolean =>
  [j.optedOut, j.optoutsCleared, j.blocked].some((n) => n > 0 && n < 3);

/** Is the job's change still the tag's current state? Read under the shared Default-set lock. */
async function stillCurrent(tx: KobeTx, job: Job): Promise<boolean> {
  await lockDefaultSet(tx, "shared");
  if (job.kind === "remove") return !(await isDefaultSkill(tx, job.skillId));
  if (job.kind === "add") return isDefaultSkill(tx, job.skillId);
  const [target] = await defaultTargets(tx, job.skillId);
  return target?.major === job.major;
}

async function teamStep(
  tx: KobeTx,
  job: Job,
  teamId: string,
  version: TargetVersion | null,
): Promise<TeamStepResult> {
  if (!(await stillCurrent(tx, job))) return NOTHING;
  if (job.kind === "remove") return removeInTeam(tx, teamId, job.skillId);
  if (!version) return NOTHING;
  return job.kind === "add"
    ? addInTeam(tx, teamId, job.skillId, version, job.requestedBy)
    : moveInTeam(tx, teamId, job.skillId, version);
}

/** What a team's admins hear about (SK8); null for nothing to tell. */
function noticeOf(kind: DefaultSyncKind, step: TeamStepResult): DefaultNotice | null {
  if (kind === "add" && step.installed > 0) return { kind: "added", installed: true };
  if (kind === "add" && step.kept > step.present) return { kind: "added", installed: false };
  if (kind === "remove" && step.kept + step.converted + step.optoutsCleared > 0)
    return { kind: "removed" };
  return null;
}

/**
 * One team: its step, the job's progress and the team's audit of what changed, in one
 * transaction; then the notice. The cursor only moves forward: a second runner (a lost lease)
 * finds it past this team and rolls its step back.
 */
async function syncTeam(
  deps: RunDeps,
  job: Job,
  team: { readonly id: string; readonly name: string },
  skill: { readonly id: string; readonly name: string },
  version: TargetVersion | null,
): Promise<void> {
  const step = await withTeam(deps.db, team.id, async (tx) => {
    const result = await teamStep(tx, job, team.id, version);
    const moved = await tx
      .update(skillDefaultSyncs)
      .set({
        teamsDone: sql`${skillDefaultSyncs.teamsDone} + 1`,
        afterTeamId: team.id,
        ...plus(result),
      })
      .where(
        and(
          eq(skillDefaultSyncs.id, job.id),
          eq(skillDefaultSyncs.status, "running"),
          or(isNull(skillDefaultSyncs.afterTeamId), lt(skillDefaultSyncs.afterTeamId, team.id)),
        ),
      )
      .returning({ id: skillDefaultSyncs.id });
    if (moved.length === 0) throw new LeaseLost();
    await auditApplied(tx, team.id, skill, changesOf(result), version?.semver ?? null);
    return result;
  });
  const notice = noticeOf(job.kind, step);
  if (notice && deps.mailer && deps.publicUrl) {
    await notifyTeamAdmins(
      { db: deps.db, mailer: deps.mailer, publicUrl: deps.publicUrl },
      team,
      skill.name,
      notice,
    ).catch((err: unknown) =>
      deps.log.warn({ err, teamId: team.id, jobId: job.id }, "skills: Default notice failed"),
    );
  }
}

/** Ends the job and records its totals in the site audit (masked per SK26). */
async function finish(db: KobeDb, jobId: string, skillName: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [done] = await tx
      .update(skillDefaultSyncs)
      // Teams created during the run are walked too, so the total is at least the teams done.
      .set({
        status: "done",
        finishedAt: new Date(),
        nextAttemptAt: null,
        teamsTotal: sql`greatest(${skillDefaultSyncs.teamsTotal}, ${skillDefaultSyncs.teamsDone})`,
      })
      .where(and(eq(skillDefaultSyncs.id, jobId), eq(skillDefaultSyncs.status, "running")))
      .returning();
    if (!done) return;
    const masked = isMasked(done);
    await recordAudit(tx, {
      action: "skill.default.synced",
      actor: SYSTEM_ACTOR,
      target: {
        skillId: done.skillId,
        name: skillName,
        kind: done.kind,
        teams: done.teamsDone,
        masked,
        ...(masked ? {} : Object.fromEntries(COUNTS.map((k) => [k, done[k]]))),
      },
    });
  });
}

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

/** The version `add`/`move_major` installs now (re-read per batch: it may be withdrawn). */
async function versionOf(db: KobeDb, job: Job): Promise<TargetVersion | null> {
  if (job.kind === "remove" || job.major === null) return null;
  return newestApproved(db, job.skillId, job.major);
}

/** Runs one job to its end, or resumes it after its cursor. Throws on failure. */
export async function runJob(deps: RunDeps, queued: Job): Promise<void> {
  const db = deps.db;
  await start(db, queued);
  const [job] = await db
    .select()
    .from(skillDefaultSyncs)
    .where(eq(skillDefaultSyncs.id, queued.id));
  if (!job || job.status !== "running") return;
  const [row] = await db
    .select({ name: registrySkills.name })
    .from(registrySkills)
    .where(eq(registrySkills.id, job.skillId));
  const skill = { id: job.skillId, name: row?.name ?? "skill" };
  // Nothing to install or move to is a failure the console shows (not a silent `done`), unless
  // the change is no longer current (then every step is a no-op anyway).
  const current = await db.transaction((tx) => stillCurrent(tx, job));
  if (current && job.kind !== "remove" && !(await versionOf(db, job)))
    throw new SyncFailure("no_version");
  let after = job.afterTeamId;
  for (;;) {
    const version = await versionOf(db, job);
    const batch = await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(after ? gt(teams.id, after) : undefined)
      .orderBy(asc(teams.id))
      .limit(TEAM_BATCH);
    for (const team of batch) await syncTeam(deps, job, team, skill, version);
    if (batch.length < TEAM_BATCH) break;
    after = batch[batch.length - 1]?.id ?? null;
  }
  await finish(db, job.id, skill.name);
  deps.log.info(
    { jobId: job.id, kind: job.kind, skillId: job.skillId },
    "skills: Default sync done",
  );
}

/** Jobs still to run: in `seq` order (commit order), skipping any waiting out a backoff. */
export const nextJob = (db: KobeDb) =>
  db
    .select()
    .from(skillDefaultSyncs)
    .where(
      and(
        ne(skillDefaultSyncs.status, "done"),
        ne(skillDefaultSyncs.status, "failed"),
        or(
          isNull(skillDefaultSyncs.nextAttemptAt),
          sql`${skillDefaultSyncs.nextAttemptAt} <= now()`,
        ),
      ),
    )
    .orderBy(asc(skillDefaultSyncs.seq))
    .limit(1);
