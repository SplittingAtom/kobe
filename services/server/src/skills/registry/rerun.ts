import { getMembership, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import type { BlobStore } from "../../retention/blobs.js";
import { startSkillEval, type StartRefusal } from "../evals/start.js";
import { cancelEvalRun } from "../evals/store.js";
import { dutiesProblem } from "./review-duties.js";
import { DECIDABLE_STATES, PROBLEMS, type Problem } from "./review-problems.js";
import { userNames, versionRow, type Person, type VersionRow } from "./review-queue.js";
import { registryTeamFor } from "./settings.js";

/**
 * Re-run evals (KOBE-335, SK23): a reviewer starts a full eval of a submitted Registry version in
 * the Registry team. It runs as an eval of that team, as the reviewer (a member of it), under that
 * team's policy, egress and budget (SK21: charged to the Registry team), without the reviewer's
 * personal connector keys (every eval run skips them, `withSkillEvals`) and judged by the Site
 * judge only. Its completed scorecard becomes the version's authoritative scorecard
 * (`authoritative.ts`), which Approve requires.
 *
 * No cherry-picking (review-335 M3, coordinator): only a reviewer who is neither the submitter nor
 * the confirming Team admin starts or cancels re-runs (a single-admin Site excepted); every
 * re-run, completed, cancelled or failed, is kept with its starter and shown as the version's
 * history; the card Approve uses is the latest completed one, and the history marks earlier runs
 * that scored lower than it. A team's own cancel route doesn't touch re-runs.
 *
 * Connectors: like every eval, a re-run reads no personal connector key; the Registry team's own
 * connectors (no key, or a site key) do connect, so the Registry team should enable no keyed
 * connector: submitted code runs there (review-335 L6).
 */

export interface RerunDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
}

export type RerunResult =
  | { readonly ok: true; readonly evalRunId: string }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 409 | 422 | 503;
      readonly code: string;
      readonly message: string;
    };

const fromRefusal = (r: StartRefusal): RerunResult => ({
  ok: false,
  status: r.status,
  code: r.code,
  message: r.message,
});

const fromProblem = (p: Problem, status: 403 | 404 | 409): RerunResult => ({
  ok: false,
  status,
  code: p.code,
  message: p.message,
});

export const NOT_REGISTRY_MEMBER = {
  code: "not_registry_member",
  message:
    "Re-runs run in the Registry team as one of its members, and you aren't one. Skill reviewers join it with their grant; anyone else is added by its Team admin.",
} as const;

/** The duties check for re-runs, in its own read transaction (it takes the admin-set lock). */
async function mayWeigh(db: KobeDb, v: VersionRow, userId: string): Promise<Problem | null> {
  return db.transaction(async (tx) => (await dutiesProblem(tx, v, userId)).problem);
}

export async function rerunEvals(
  deps: RerunDeps,
  versionId: string,
  userId: string,
): Promise<RerunResult> {
  const v = await versionRow(deps.db, versionId);
  if (!v || v.publisher !== "maintainer") return fromProblem(PROBLEMS.not_found, 404);
  if (!DECIDABLE_STATES.has(v.state)) return fromProblem(PROBLEMS.decided, 409);
  const duties = await mayWeigh(deps.db, v, userId);
  if (duties) return fromProblem(duties, 403);
  const teamId = await registryTeamFor(deps.db);
  if (!teamId) return fromProblem(PROBLEMS.registry_not_ready, 409);
  const role = await getMembership(deps.db, teamId, userId);
  if (!role) return fromProblem(NOT_REGISTRY_MEMBER, 409);
  const started = await startSkillEval(
    deps,
    { teamId, userId, role },
    { kind: "registry", versionId: v.id },
    "full",
  );
  if (!started.ok) return fromRefusal(started.refusal);
  const evalRunId = started.value.evalRunId;
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO registry_review_events (version_id, actor_id, action, checklist)
      VALUES (${v.id}, ${userId}, 'evals_rerun', ${JSON.stringify({ evalRunId })}::jsonb)`);
    await recordAudit(tx, {
      action: "registry.evals_rerun",
      target: { registryVersionId: v.id, evalRunId, teamId },
    });
  });
  return { ok: true, evalRunId };
}

/** Cancels one open re-run of the version (an eligible reviewer; the history keeps it). */
export async function cancelRerun(
  db: KobeDb,
  versionId: string,
  evalRunId: string,
  userId: string,
): Promise<RerunResult> {
  const v = await versionRow(db, versionId);
  if (!v || v.publisher !== "maintainer") return fromProblem(PROBLEMS.not_found, 404);
  const duties = await mayWeigh(db, v, userId);
  if (duties) return fromProblem(duties, 403);
  const teamId = await registryTeamFor(db);
  if (!teamId) return fromProblem(PROBLEMS.registry_not_ready, 409);
  const outcome = await withTeam(db, teamId, async (tx) => {
    const run = await tx.execute<{ done: number; total: number }>(sql`
      SELECT progress_done AS done, progress_total AS total FROM skill_eval_runs
       WHERE team_id = ${teamId} AND id = ${evalRunId}
         AND subject_kind = 'registry' AND subject_id = ${v.id}`);
    const at = run.rows[0];
    if (!at) return "not_found" as const;
    if (!(await cancelEvalRun(tx, teamId, evalRunId))) return "ended" as const;
    await tx.execute(sql`
      INSERT INTO registry_review_events (version_id, actor_id, action, checklist)
      VALUES (${v.id}, ${userId}, 'evals_rerun',
        ${JSON.stringify({
          evalRunId,
          cancelled: true,
          // How far it had got, kept with the cancel (review-336 L7).
          progress: { done: Number(at.done), total: Number(at.total) },
        })}::jsonb)`);
    await recordAudit(tx, {
      action: "registry.rerun_cancelled",
      target: { registryVersionId: v.id, evalRunId },
    });
    return "cancelled" as const;
  });
  if (outcome === "not_found")
    return { ok: false, status: 404, code: "not_found", message: "No such re-run." };
  if (outcome === "ended")
    return { ok: false, status: 409, code: "eval_ended", message: "The re-run has already ended." };
  return { ok: true, evalRunId };
}

/**
 * Cancels the version's open re-runs once it is decided or retracted (review-335 L3), in the
 * decision's transaction when that runs in the Registry team's context (`tx` and its team).
 */
export async function cancelOpenReruns(
  tx: KobeTx,
  teamId: string,
  versionId: string,
): Promise<number> {
  const open = await tx.execute<{ id: string }>(sql`
    SELECT id FROM skill_eval_runs
     WHERE team_id = ${teamId} AND subject_kind = 'registry' AND subject_id = ${versionId}
       AND status IN ('queued', 'running')`);
  let n = 0;
  for (const r of open.rows) if (await cancelEvalRun(tx, teamId, r.id)) n += 1;
  return n;
}

export interface RerunEntry {
  readonly evalRunId: string;
  readonly startedBy: Person | null;
  readonly startedAt: string;
  /** queued, running, completed, failed, cancelled, budget_stopped, or `gone` (purged). */
  readonly status: string;
  readonly cancelledBy: Person | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** Numbers of a completed run: pass rate with the skill and lift. */
  readonly passRate: number | null;
  readonly lift: number | null;
  /** The run whose card is the version's authoritative scorecard now. */
  readonly current: boolean;
  /** A completed run that scored lower than the current card (pass rate or lift). */
  readonly lowerThanCurrent: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Every re-run of the version, oldest first (review-335 M3): from the Registry's own events (so
 * a run the Registry team's retention purged still shows, as `gone`), with each run's state and,
 * when completed, its pass rate and lift.
 */
export async function rerunHistory(
  db: KobeDb,
  v: Pick<VersionRow, "id" | "authoritativeScorecard">,
): Promise<RerunEntry[]> {
  const events = await db.execute<{
    actor_id: string;
    checklist: { evalRunId?: string; cancelled?: boolean } | null;
    at: Date;
  }>(sql`
    SELECT actor_id, checklist, at FROM registry_review_events
     WHERE version_id = ${v.id} AND action = 'evals_rerun' ORDER BY at, id`);
  const started = events.rows.filter((e) => e.checklist?.evalRunId && !e.checklist.cancelled);
  if (started.length === 0) return [];
  const cancelled = new Map(
    events.rows
      .filter((e) => e.checklist?.cancelled && e.checklist.evalRunId)
      .map((e) => [e.checklist?.evalRunId as string, e.actor_id]),
  );
  const ids = started.map((e) => e.checklist?.evalRunId as string);
  const teamId = await registryTeamFor(db);
  const runs = new Map<
    string,
    { status: string; progress_done: number; progress_total: number; scorecard: unknown }
  >();
  if (teamId) {
    const res = await withTeam(db, teamId, (tx) =>
      tx.execute<{
        id: string;
        status: string;
        progress_done: number;
        progress_total: number;
        scorecard: unknown;
      }>(sql`
        SELECT id, status, progress_done, progress_total, scorecard FROM skill_eval_runs
         WHERE team_id = ${teamId} AND subject_kind = 'registry' AND subject_id = ${v.id}
           AND id IN (${sql.join(
             ids.map((i) => sql`${i}`),
             sql`, `,
           )})`),
    );
    for (const r of res.rows) runs.set(r.id, r);
  }
  const who = await userNames(db, [...started.map((e) => e.actor_id), ...cancelled.values()]);
  const person = (id: string | undefined) =>
    id ? { id, name: who.get(id) ?? "Unknown user" } : null;
  const card = v.authoritativeScorecard;
  const currentId = (card?.rerun as { evalRunId?: string } | undefined)?.evalRunId ?? null;
  const currentPass = num(card?.passRateWith);
  const currentLift = num(card?.lift);
  return started.map((e): RerunEntry => {
    const id = e.checklist?.evalRunId as string;
    const run = runs.get(id);
    const sc = (run?.scorecard ?? null) as Record<string, unknown> | null;
    const passRate = num(sc?.passRate);
    const lift = num(sc?.lift);
    const completed = run?.status === "completed";
    const lower =
      completed &&
      id !== currentId &&
      ((passRate !== null && currentPass !== null && passRate < currentPass) ||
        (lift !== null && currentLift !== null && lift < currentLift));
    return {
      evalRunId: id,
      startedBy: person(e.actor_id),
      startedAt: new Date(e.at).toISOString(),
      status: run?.status ?? "gone",
      cancelledBy: person(cancelled.get(id)),
      progress: run ? { done: Number(run.progress_done), total: Number(run.progress_total) } : null,
      passRate,
      lift,
      current: id === currentId,
      lowerThanCurrent: lower,
    };
  });
}
