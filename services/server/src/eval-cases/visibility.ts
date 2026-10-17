import { agentEvalCases, sql, type KobeTx } from "@kobe/db";
import { PERIOD_DAYS, effectiveAt } from "../retention/periods.js";
import { readMaximumLayer, readTeamLayer } from "../retention/settings.js";

type SQL = ReturnType<typeof sql>;

/**
 * Which shared eval cases the API shows (KOBE-276 review S3, S5, R1). The retention pass and
 * offboarding skip cases a legal hold covers, so a case that outlived its window, or its sharer's
 * membership, would show that a hold exists. Every read therefore treats such a case exactly as
 * purged: not listed, not readable, not run in the gate. The rows themselves stay for the hold.
 * Once the pass has skipped a held case it marks it hidden, so lengthening the window or
 * reactivating the sharer later doesn't bring it back while its unheld peers are gone.
 *
 * The agent's owner also sees a case only once the UTC day it was shared has ended, so watching
 * the list never pinpoints when (and so by whom) a case was shared.
 */

/** Cases shared before this are past the team's effective retention window (null: forever). */
export async function caseCutoff(tx: KobeTx, teamId: string): Promise<Date | null> {
  const now = new Date();
  const days =
    PERIOD_DAYS[effectiveAt(await readTeamLayer(tx, teamId), await readMaximumLayer(tx), now)];
  return days === null ? null : new Date(now.getTime() - days * 86_400_000);
}

/**
 * Not hidden for good (`hidden_at`: the retention pass found it purgeable but held), within the
 * window, its sharer still an active member, and shared during their current membership: a
 * member who left and rejoined never gets older cases back (re-review R1).
 */
export function liveCase(cutoff: Date | null): SQL {
  const window =
    cutoff === null ? sql`TRUE` : sql`${agentEvalCases.createdAt} >= ${cutoff.toISOString()}`;
  return sql`(${agentEvalCases.hiddenAt} IS NULL AND ${window} AND EXISTS (
    SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ${agentEvalCases.teamId} AND m.user_id = ${agentEvalCases.userId}
       AND u.deactivated_at IS NULL AND m.created_at <= ${agentEvalCases.createdAt}))`;
}

/** Shared on a UTC day that has ended (what the agent's owner may see). */
export const sharedOnFinishedDay: SQL = sql`${agentEvalCases.createdAt} < (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
