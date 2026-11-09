import { lockLegalHolds, SYSTEM_ACTOR, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { historyKeep, type HistoryKeep } from "../projects/storage.js";
import { queueProjectBlobs, referencedKeys, refreshProjectStorage } from "../projects/tree.js";

/**
 * Project history retention (KOBE-579, Workspaces GV3) in the retention job. Per project, commits
 * older than the workspace's rule (`projects.history_keep`: all, the newest N, or the last N days)
 * or beyond the hard cap (`PROJECT_HISTORY_MAX_COMMITS`, a chart value) go, oldest first, but
 * never the head, never a commit a checkout is based on (the database refuses both too), and
 * nothing while a legal hold covers the workspace (any hold in the team: project history's rule;
 * the 0200 guard refuses the delete as well). Objects no remaining commit or head file names are
 * queued for the blob deleter (`retention_blob_deletions`, after its grace period), which checks
 * again that no workspace row names them. Each project that lost history is audited
 * `project.history_pruned` with the counts (system actor). The current files never change.
 */

export interface HistoryPruneCounts {
  readonly projects: number;
  readonly commits: number;
  readonly treeEntries: number;
  readonly blobsQueued: number;
}

export const NO_HISTORY_PRUNE: HistoryPruneCounts = {
  projects: 0,
  commits: 0,
  treeEntries: 0,
  blobsQueued: 0,
};

type Rule = "commits" | "days" | "hard_cap";

async function teamHeld(tx: KobeTx, teamId: string): Promise<boolean> {
  const res = await tx.execute<{ held: boolean }>(
    sql`SELECT public.memory_legal_hold_covers(${teamId}, NULL) AS held`,
  );
  return res.rows[0]?.held === true;
}

/** The highest seq the rule lets go (0 = nothing), and which rule set it. */
async function cutoff(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  headSeq: number,
  keep: HistoryKeep,
  maxCommits: number,
  now: Date,
): Promise<{ seq: number; rule: Rule }> {
  let ruleSeq = 0;
  if (keep.mode === "commits") ruleSeq = headSeq - keep.n;
  if (keep.mode === "days") {
    const res = await tx.execute<{ seq: number | null }>(sql`
      SELECT max(seq) AS seq FROM project_commits
       WHERE team_id = ${teamId} AND project_id = ${projectId} AND seq < ${headSeq}
         AND created_at < ${new Date(now.getTime() - keep.n * 86_400_000).toISOString()}::timestamptz`);
    ruleSeq = Number(res.rows[0]?.seq ?? 0);
  }
  const capSeq = headSeq - maxCommits;
  return capSeq > ruleSeq
    ? { seq: capSeq, rule: "hard_cap" }
    : { seq: ruleSeq, rule: keep.mode === "days" ? "days" : "commits" };
}

/** One project, in its own transaction under the project row lock. */
async function pruneProject(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  keep: HistoryKeep,
  maxCommits: number,
  now: Date,
): Promise<HistoryPruneCounts> {
  await lockLegalHolds(tx);
  if (await teamHeld(tx, teamId)) return NO_HISTORY_PRUNE;
  const head = await tx.execute<{ id: string; seq: number; created_by: string }>(sql`
    SELECT c.id, c.seq, p.created_by FROM projects p
      JOIN project_commits c ON c.team_id = p.team_id AND c.id = p.head_commit_id
     WHERE p.team_id = ${teamId} AND p.id = ${projectId}
       FOR UPDATE OF p`);
  const h = head.rows[0];
  if (!h) return NO_HISTORY_PRUNE;
  const limit = await cutoff(tx, teamId, projectId, Number(h.seq), keep, maxCommits, now);
  if (limit.seq <= 0) return NO_HISTORY_PRUNE;
  const doomed = await tx.execute<{ id: string }>(sql`
    SELECT id FROM project_commits c
     WHERE c.team_id = ${teamId} AND c.project_id = ${projectId} AND c.seq <= ${limit.seq}
       AND c.id <> ${h.id}
       AND NOT EXISTS (SELECT 1 FROM project_checkouts k
                        WHERE k.team_id = c.team_id AND k.project_id = c.project_id
                          AND k.base_commit_id = c.id)`);
  const ids = doomed.rows.map((r) => r.id);
  if (ids.length === 0) return NO_HISTORY_PRUNE;
  const refs = await tx.execute<{ key: string; entries: string }>(sql`
    SELECT blob_ref AS key, count(*) AS entries FROM project_tree_entries
     WHERE team_id = ${teamId} AND commit_id IN ${ids} GROUP BY blob_ref`);
  const treeEntries = refs.rows.reduce((n, r) => n + Number(r.entries), 0);
  await tx.execute(sql`
    DELETE FROM project_commits WHERE team_id = ${teamId} AND project_id = ${projectId}
       AND id IN ${ids}`);
  const keys = refs.rows.map((r) => r.key);
  const still = await referencedKeys(tx, teamId, projectId, keys);
  const released = keys.filter((k) => !still.has(k));
  await queueProjectBlobs(tx, teamId, projectId, h.created_by, released);
  await refreshProjectStorage(tx, teamId, projectId);
  const counts = { projects: 1, commits: ids.length, treeEntries, blobsQueued: released.length };
  await recordAudit(tx, {
    action: "project.history_pruned",
    actor: SYSTEM_ACTOR,
    teamId,
    target: {
      projectId,
      commits: counts.commits,
      treeEntries,
      blobsQueued: counts.blobsQueued,
      rule: limit.rule,
    },
  });
  return counts;
}

/** The team's sweep: every project with more than one commit. */
export async function pruneProjectHistory(
  db: KobeDb,
  teamId: string,
  options: { readonly maxCommits: number; readonly stop?: () => boolean; readonly now?: Date },
): Promise<HistoryPruneCounts> {
  const now = options.now ?? new Date();
  const { keep, projects, held } = await withTeam(db, teamId, async (tx) => ({
    held: await teamHeld(tx, teamId),
    keep: await historyKeep(tx, teamId),
    projects: (
      await tx.execute<{ project_id: string }>(sql`
        SELECT project_id FROM project_commits WHERE team_id = ${teamId}
         GROUP BY project_id HAVING count(*) > 1 ORDER BY project_id`)
    ).rows.map((r) => r.project_id),
  }));
  if (held) return NO_HISTORY_PRUNE;
  let total = NO_HISTORY_PRUNE;
  for (const projectId of projects) {
    if (options.stop?.()) break;
    const done = await withTeam(db, teamId, (tx) =>
      pruneProject(tx, teamId, projectId, keep, options.maxCommits, now),
    );
    total = {
      projects: total.projects + done.projects,
      commits: total.commits + done.commits,
      treeEntries: total.treeEntries + done.treeEntries,
      blobsQueued: total.blobsQueued + done.blobsQueued,
    };
  }
  return total;
}
