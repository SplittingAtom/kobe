import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { KobeDb } from "./client.js";
import { teamMembers, teamRole } from "./schema/index.js";
import { scanTeams } from "./team-scan.js";
import { withTeam } from "./with-team.js";

/** Fixed team roles (spec D8), most to least privileged. */
export type TeamRole = (typeof teamRole.enumValues)[number];
export const TEAM_ROLES: readonly TeamRole[] = teamRole.enumValues;

export interface TeamMembership {
  readonly teamId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: TeamRole;
}

const userIdSchema = z.uuid({ error: "user id must be a UUID" });

function parseUserId(fn: string, userId: string): string {
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    throw new Error(
      `${fn}: invalid user id ${JSON.stringify(userId.slice(0, 64))} (must be a UUID)`,
    );
  }
  return parsed.data;
}

/** The user's role in one team, read under that team's RLS; null when not a member. */
export async function getMembership(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const user = parseUserId("getMembership", userId);
  const [row] = await withTeam(db, teamId, (tx) =>
    tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user))),
  );
  return row?.role ?? null;
}

/**
 * Every team the user belongs to (the team switcher, spec D9), sorted by name. `team_members` stays
 * behind its one canonical RLS policy: this visits each team in turn inside one transaction,
 * setting `kobe.team_id` transaction-locally per team, so it never sees another user's rows and
 * needs no bypass. Cost is one query per team, fine for one organization's teams.
 */
export async function listMemberships(db: KobeDb, userId: string): Promise<TeamMembership[]> {
  const user = parseUserId("listMemberships", userId);
  return scanTeams(db, "listMemberships", async (tx, team) => {
    const [row] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, user));
    return row ? { teamId: team.id, slug: team.slug, name: team.name, role: row.role } : undefined;
  });
}
