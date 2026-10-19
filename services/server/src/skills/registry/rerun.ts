import { getMembership, sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import type { BlobStore } from "../../retention/blobs.js";
import { startSkillEval, type StartRefusal } from "../evals/start.js";
import { DECIDABLE_STATES, PROBLEMS } from "./review-problems.js";
import { versionRow } from "./review-queue.js";
import { registryTeamFor } from "./settings.js";

/**
 * Re-run evals (KOBE-335, SK23): a reviewer starts a full eval of a submitted Registry version in
 * the Registry team. It runs as an eval of that team, as the reviewer (a member of it: Skill
 * reviewers join it with the grant), under that team's policy, egress and budget (SK21: charged
 * to the Registry team), without the reviewer's personal connector keys (every eval run skips
 * them, `withSkillEvals`) and judged by the Site judge only. Its completed scorecard becomes the
 * version's authoritative scorecard (`authoritative.ts`), which Approve requires.
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

export async function rerunEvals(
  deps: RerunDeps,
  versionId: string,
  userId: string,
): Promise<RerunResult> {
  const v = await versionRow(deps.db, versionId);
  if (!v || v.publisher !== "maintainer") return { ok: false, status: 404, ...PROBLEMS.not_found };
  if (!DECIDABLE_STATES.has(v.state)) return { ok: false, status: 409, ...PROBLEMS.decided };
  const teamId = await registryTeamFor(deps.db);
  if (!teamId) return { ok: false, status: 409, ...PROBLEMS.registry_not_ready };
  const role = await getMembership(deps.db, teamId, userId);
  if (!role)
    return {
      ok: false,
      status: 409,
      code: "not_registry_member",
      message:
        "Re-runs run in the Registry team as one of its members: ask its Team admin to add you.",
    };
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

export interface RerunStatus {
  readonly evalRunId: string;
  readonly status: string;
  readonly progress: { readonly done: number; readonly total: number };
  readonly startedAt: string;
}

/** The version's latest re-run in the Registry team: its state and progress only. */
export async function latestRerun(db: KobeDb, versionId: string): Promise<RerunStatus | null> {
  const teamId = await registryTeamFor(db);
  if (!teamId) return null;
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{
      id: string;
      status: string;
      progress_done: number;
      progress_total: number;
      started_at: Date;
    }>(sql`
      SELECT id, status, progress_done, progress_total, started_at FROM skill_eval_runs
       WHERE team_id = ${teamId} AND subject_kind = 'registry' AND subject_id = ${versionId}
       ORDER BY started_at DESC LIMIT 1`),
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    evalRunId: r.id,
    status: r.status,
    progress: { done: Number(r.progress_done), total: Number(r.progress_total) },
    startedAt: new Date(r.started_at).toISOString(),
  };
}
