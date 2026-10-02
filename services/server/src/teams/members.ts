import {
  and,
  asc,
  eq,
  teamMembers,
  teams,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";

export interface TeamMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly joinedAt: string;
}

export interface TeamSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** Why a membership change was refused; routes map these to HTTP errors. */
export type MembershipError = "not_a_member" | "already_member" | "last_team_admin";

export type MembershipResult =
  { readonly ok: true } | { readonly ok: false; error: MembershipError };

const OK: MembershipResult = { ok: true };
const fail = (error: MembershipError): MembershipResult => ({ ok: false, error });

/** Members of one team (read under that team's RLS), sorted by name. */
export async function listMembers(db: KobeDb, teamId: string): Promise<TeamMember[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({
        userId: teamMembers.userId,
        name: users.name,
        email: users.email,
        role: teamMembers.role,
        joinedAt: teamMembers.createdAt,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(users.name), asc(users.email)),
  );
  return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
}

export async function findTeam(db: KobeDb, teamId: string): Promise<TeamSummary | null> {
  const [team] = await db
    .select({ id: teams.id, slug: teams.slug, name: teams.name })
    .from(teams)
    .where(eq(teams.id, teamId));
  return team ?? null;
}

export async function findUserId(
  db: KobeDb,
  by: { readonly id: string } | { readonly email: string },
): Promise<string | null> {
  const where = "id" in by ? eq(users.id, by.id) : eq(users.email, by.email.toLowerCase());
  const [user] = await db.select({ id: users.id }).from(users).where(where);
  return user?.id ?? null;
}

/** Locks the team's admin rows and the target row, so concurrent changes can't drop the last admin. */
async function lockForChange(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<{ admins: number; current: TeamRole | null }> {
  const admins = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "team_admin")))
    .for("update");
  const [target] = await tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .for("update");
  return { admins: admins.length, current: target?.role ?? null };
}

export async function addMember(
  db: KobeDb,
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<MembershipResult> {
  return withTeam(db, teamId, async (tx) => {
    const inserted = await tx
      .insert(teamMembers)
      .values({ teamId, userId, role })
      .onConflictDoNothing()
      .returning({ userId: teamMembers.userId });
    return inserted.length > 0 ? OK : fail("already_member");
  });
}

/** Changes a member's role; a team always keeps at least one team admin. */
export async function setMemberRole(
  db: KobeDb,
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<MembershipResult> {
  return withTeam(db, teamId, async (tx) => {
    const { admins, current } = await lockForChange(tx, teamId, userId);
    if (current === null) return fail("not_a_member");
    if (current === "team_admin" && role !== "team_admin" && admins <= 1) {
      return fail("last_team_admin");
    }
    await tx
      .update(teamMembers)
      .set({ role })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return OK;
  });
}

/** Removes a member; the last team admin can't be removed. */
export async function removeMember(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<MembershipResult> {
  return withTeam(db, teamId, async (tx) => {
    const { admins, current } = await lockForChange(tx, teamId, userId);
    if (current === null) return fail("not_a_member");
    if (current === "team_admin" && admins <= 1) return fail("last_team_admin");
    await tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return OK;
  });
}

/**
 * Creates a team and its first team admin atomically (a team never exists without an admin).
 * The membership row is written under the new team's RLS context inside the same transaction.
 */
export async function createTeamWithAdmin(
  db: KobeDb,
  input: { readonly slug: string; readonly name: string },
  adminUserId: string,
): Promise<TeamSummary> {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ slug: input.slug, name: input.name })
      .returning({ id: teams.id, slug: teams.slug, name: teams.name });
    if (!team) throw new Error("team insert returned no row");
    await withTeam(tx, team.id, (inner) =>
      inner
        .insert(teamMembers)
        .values({ teamId: team.id, userId: adminUserId, role: "team_admin" }),
    );
    return team;
  });
}
