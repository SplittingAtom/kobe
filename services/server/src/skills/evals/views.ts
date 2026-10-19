import { sql, withTeam, type KobeDb, type KobeTx, type TeamRole } from "@kobe/db";
import {
  skillEvalRunSchema,
  type SkillEvalExecutionStatus,
  type SkillEvalRun,
  type SkillEvalSubject,
} from "@kobe/protocol";
import { teamRoleAllows } from "../../authz/permissions.js";
import { visibleDraft } from "../drafts/records.js";

// Reading skill evals (KOBE-325): the API's `SkillEvalRun`, who may read one, and the executions
// done so far (the progress events). An eval is team content: only ever read inside its team.

type RunRow = {
  id: string;
  started_by: string;
  subject_kind: "draft" | "team" | "personal";
  subject_id: string;
  subject_rev: number;
  package_hash: string;
  mode: SkillEvalRun["mode"];
  status: SkillEvalRun["status"];
  progress_done: number;
  progress_total: number;
  scorecard: unknown;
  failure: unknown;
  started_at: Date | string;
  finished_at: Date | string | null;
};

const COLUMNS = sql.raw(`id, started_by, subject_kind, subject_id, subject_rev, package_hash, mode,
  status, progress_done, progress_total, scorecard, failure, started_at, finished_at`);

const iso = (d: Date | string) => new Date(d).toISOString();

function subjectOf(r: RunRow): SkillEvalSubject {
  return r.subject_kind === "draft"
    ? { kind: "draft", draftId: r.subject_id, rev: r.subject_rev }
    : { kind: "version", scope: r.subject_kind, skillId: r.subject_id, seq: r.subject_rev };
}

function toView(r: RunRow): SkillEvalRun {
  return skillEvalRunSchema.parse({
    id: r.id,
    subject: subjectOf(r),
    packageHash: r.package_hash,
    mode: r.mode,
    status: r.status,
    progress: { done: r.progress_done, total: r.progress_total },
    scorecard: r.scorecard ?? null,
    failure: r.failure ?? null,
    startedBy: r.started_by,
    startedAt: iso(r.started_at),
    finishedAt: r.finished_at === null ? null : iso(r.finished_at),
  });
}

export interface EvalViewer {
  readonly teamId: string;
  readonly userId: string;
  readonly role: TeamRole;
}

/** Its starter, and whoever can see its subject (a draft shared with them, a team version). */
async function mayRead(tx: KobeTx, who: EvalViewer, r: RunRow): Promise<boolean> {
  if (r.started_by === who.userId) return true;
  if (r.subject_kind === "team") return true;
  if (r.subject_kind === "draft")
    return (await visibleDraft(tx, who.teamId, r.subject_id, who)) !== null;
  return false;
}

/**
 * What an open eval stream re-checks (re-review R2): the session is live, the account is active,
 * and the viewer's current role in the team; null when any of that is gone.
 */
export async function evalStreamAccess(
  db: KobeDb,
  who: { readonly teamId: string; readonly userId: string; readonly sessionId: string },
): Promise<TeamRole | null> {
  // In the team's transaction: team_members is a team table (RLS), as in the thread stream's read.
  const res = await withTeam(db, who.teamId, (tx) =>
    tx.execute<{ live: boolean; role: TeamRole | null }>(sql`
    SELECT EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${who.sessionId} AND s.expires_at > now())
             AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${who.userId} AND u.deactivated_at IS NULL)
             AS live,
           (SELECT m.role::text FROM team_members m
             WHERE m.team_id = ${who.teamId} AND m.user_id = ${who.userId}) AS role`),
  );
  const row = res.rows[0];
  return row?.live && row.role ? row.role : null;
}

/** Whether `who` may cancel it: its starter, or a team admin (review L6). */
export const mayCancel = (who: EvalViewer, run: SkillEvalRun): boolean =>
  run.startedBy === who.userId || teamRoleAllows(who.role, "team.skills.review");

export async function readEvalRun(
  tx: KobeTx,
  who: EvalViewer,
  id: string,
): Promise<SkillEvalRun | null> {
  const res = await tx.execute<RunRow>(sql`
    SELECT ${COLUMNS} FROM skill_eval_runs WHERE team_id = ${who.teamId} AND id = ${id}`);
  const r = res.rows[0];
  if (!r || !(await mayRead(tx, who, r))) return null;
  return toView(r);
}

/** A subject's eval history, newest first (KOBE-328 shows it). */
export async function listEvalRuns(
  tx: KobeTx,
  who: EvalViewer,
  subject: { readonly kind: "draft" | "team" | "personal"; readonly id: string },
  limit = 50,
): Promise<SkillEvalRun[]> {
  const res = await tx.execute<RunRow>(sql`
    SELECT ${COLUMNS} FROM skill_eval_runs
     WHERE team_id = ${who.teamId} AND subject_kind = ${subject.kind} AND subject_id = ${subject.id}
     ORDER BY started_at DESC LIMIT ${limit}`);
  const out: SkillEvalRun[] = [];
  for (const r of res.rows) if (await mayRead(tx, who, r)) out.push(toView(r));
  return out;
}

export interface DoneExecution {
  readonly caseId: string;
  readonly withSkill: boolean;
  readonly status: SkillEvalExecutionStatus;
}

/** The executions done so far, in finishing order. */
export async function doneExecutions(
  tx: KobeTx,
  teamId: string,
  evalRunId: string,
): Promise<DoneExecution[]> {
  const res = await tx.execute<{ case_id: string; with_skill: boolean; status: string }>(sql`
    SELECT case_id, with_skill, execution ->> 'status' AS status FROM skill_eval_results
     WHERE team_id = ${teamId} AND eval_run_id = ${evalRunId} AND state = 'done'
     ORDER BY finished_at, case_id, with_skill DESC`);
  return res.rows.map((r) => ({
    caseId: r.case_id,
    withSkill: r.with_skill,
    status: r.status as SkillEvalExecutionStatus,
  }));
}
