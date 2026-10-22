import { eq, sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "./client.js";
import { parseUserId, type TeamMembership } from "./memberships.js";
import { teamMembers, teamModels, userLastTeams } from "./schema/index.js";
import { scanTeams } from "./team-scan.js";

/** A team the user can pick, with what a new session needs to choose a default (KOBE-456). */
export interface TeamChoice extends TeamMembership {
  /** The Site's Registry team: Skill review, not a working team. */
  readonly registry: boolean;
  /** Chat can run there: the team has at least one model enabled. */
  readonly chatReady: boolean;
}

/** The user's teams by name, each read under its own RLS (one scan, like listMemberships). */
export async function listTeamChoices(db: KobeDb, userId: string): Promise<TeamChoice[]> {
  const user = parseUserId("listTeamChoices", userId);
  return scanTeams(db, "listTeamChoices", async (tx, team) => {
    const [row] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, user));
    if (!row) return undefined;
    const models = await tx
      .select({ one: sql<number>`1` })
      .from(teamModels)
      .where(eq(teamModels.teamId, team.id))
      .limit(1);
    return {
      teamId: team.id,
      slug: team.slug,
      name: team.name,
      role: row.role,
      registry: team.registry,
      chatReady: models.length > 0,
    };
  });
}

/** The team the user last made active, if any (membership is the caller's to check). */
export async function readLastTeam(db: KobeDb, userId: string): Promise<string | null> {
  const user = parseUserId("readLastTeam", userId);
  const [row] = await db
    .select({ teamId: userLastTeams.teamId })
    .from(userLastTeams)
    .where(eq(userLastTeams.userId, user));
  return row?.teamId ?? null;
}

/** Records the team a user just made active, so their next session can start there. */
export async function rememberLastTeam(
  db: KobeDb | KobeTx,
  userId: string,
  teamId: string,
): Promise<void> {
  const user = parseUserId("rememberLastTeam", userId);
  await db
    .insert(userLastTeams)
    .values({ userId: user, teamId })
    .onConflictDoUpdate({
      target: userLastTeams.userId,
      set: { teamId, updatedAt: new Date() },
    });
}
