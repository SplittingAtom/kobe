import { and, eq, isNull, sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "../client.js";
import { egressDomains, teamEgress, teamMembers, users } from "../schema/index.js";
import { withTeam } from "../with-team.js";

/**
 * Change hints for egress allowlists (spec D28; CLAUDE.md "No Redis"). Writers NOTIFY in the
 * transaction that changes the ceiling or a team's enablement, so the hint is delivered only on
 * commit; the egress proxy drops its cached allowlists and re-reads Postgres. Payloads carry ids
 * only (any session may LISTEN): a team id, or {@link CEILING_CHANGED} for the install ceiling.
 */
export const EGRESS_CHANGES_CHANNEL = "kobe_egress";
export const CEILING_CHANGED = "ceiling";

/**
 * Blocked-connection hints: the egress proxy records an `events` row (kind
 * {@link EGRESS_BLOCKED_EVENT_KIND}) in the sandbox's team and NOTIFYs `<team_id>:<event_id>`; the
 * server turns pending rows into `egress.blocked` run events (KOBE-38) and KOBE-39 builds the
 * request-access flow on them.
 */
export const EGRESS_BLOCKED_CHANNEL = "kobe_egress_blocked";
export const EGRESS_BLOCKED_EVENT_KIND = "egress.blocked";

/** Queues the change hint in `tx` (delivered on commit). `teamId` null: the ceiling changed. */
export async function notifyEgressChanged(tx: KobeTx, teamId: string | null): Promise<void> {
  await tx.execute(sql`SELECT pg_notify(${EGRESS_CHANGES_CHANNEL}, ${teamId ?? CEILING_CHANGED})`);
}

/** The install ceiling: patterns teams may enable (rows with `in_ceiling`). */
export async function loadEgressCeiling(db: KobeDb): Promise<string[]> {
  const rows = await db
    .select({ domain: egressDomains.domain })
    .from(egressDomains)
    .where(eq(egressDomains.inCeiling, true));
  return rows.map((r) => r.domain);
}

/** Patterns the team enabled (read under its RLS), whether or not they are still in the ceiling. */
export async function loadTeamEgress(db: KobeDb, teamId: string): Promise<string[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx.select({ domain: teamEgress.domain }).from(teamEgress).where(eq(teamEgress.teamId, teamId)),
  );
  return rows.map((r) => r.domain);
}

/**
 * Whether the user is an active (not deactivated) member of the team: the egress proxy's liveness
 * check of a sandbox's (team_id, user_id) beyond its token (D7: deactivation stops everything).
 */
export async function isActiveTeamMember(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          isNull(users.deactivatedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}
