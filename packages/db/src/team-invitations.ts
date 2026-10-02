import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { KobeDb } from "./client.js";
import type { TeamRole } from "./memberships.js";
import { teamInvitations, users } from "./schema/index.js";
import { scanTeams } from "./team-scan.js";

export interface PendingTeamInvitation {
  readonly id: string;
  readonly teamId: string;
  readonly teamSlug: string;
  readonly teamName: string;
  readonly role: TeamRole;
  readonly invitedByName: string;
  readonly expiresAt: Date;
}

/**
 * Open (unexpired) team invitations addressed to `email`, across every team, read under each
 * team's RLS in turn (see scanTeams). The caller must pass the signed-in user's own, verified email.
 */
export async function listTeamInvitationsFor(
  db: KobeDb,
  email: string,
): Promise<PendingTeamInvitation[]> {
  const address = email.trim().toLowerCase();
  return scanTeams(db, "listTeamInvitationsFor", async (tx, team) => {
    const [row] = await tx
      .select({
        id: teamInvitations.id,
        role: teamInvitations.role,
        invitedByName: users.name,
        expiresAt: teamInvitations.expiresAt,
      })
      .from(teamInvitations)
      .innerJoin(users, eq(users.id, teamInvitations.invitedBy))
      .where(and(eq(teamInvitations.email, address), gt(teamInvitations.expiresAt, sql`now()`)))
      .orderBy(asc(teamInvitations.createdAt));
    return row ? { ...row, teamId: team.id, teamSlug: team.slug, teamName: team.name } : undefined;
  });
}
