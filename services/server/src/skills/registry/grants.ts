import type { SiteGrant } from "@kobe/protocol";
import {
  and,
  asc,
  eq,
  inArray,
  siteGrants,
  siteSkillSettings,
  sql,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";

/**
 * Site grants beside the role ladder (KOBE-331, SK22): the **Skill reviewer** grant, given and
 * taken by the Owner or a Site admin, audited. Kobe adds every grantee to the Registry team as a
 * member (when granted, and when a team becomes the Registry team), since reviewers are its
 * members (SK21); taking the grant leaves the membership to the team's admins.
 */

export interface GrantHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly grant: SiteGrant;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export async function listGrants(db: KobeDb): Promise<GrantHolder[]> {
  const rows = await db
    .select({
      userId: siteGrants.userId,
      name: users.name,
      email: users.email,
      grant: siteGrants.grant,
      grantedBy: siteGrants.grantedBy,
      grantedAt: siteGrants.grantedAt,
    })
    .from(siteGrants)
    .innerJoin(users, eq(users.id, siteGrants.userId))
    .orderBy(asc(users.name));
  return rows.map((r) => ({ ...r, grantedAt: r.grantedAt.toISOString() }));
}

/** The user's site grants; an inactive account's grants count for nothing. */
export async function grantsOf(db: KobeDb, userId: string): Promise<SiteGrant[]> {
  const rows = await db
    .select({ grant: siteGrants.grant })
    .from(siteGrants)
    .innerJoin(users, eq(users.id, siteGrants.userId))
    .where(and(eq(siteGrants.userId, userId), sql`${users.deactivatedAt} IS NULL`));
  return rows.map((r) => r.grant);
}

/**
 * Adds these grantees to the Registry team as members (those not in it yet), each audited in
 * the team's log. Runs in its own team transaction (team_members has FORCE RLS).
 */
export async function joinRegistryTeam(
  db: KobeDb,
  teamId: string,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await withTeam(db, teamId, async (tx) => {
    const added = await tx
      .insert(teamMembers)
      .values(userIds.map((userId) => ({ teamId, userId, role: "member" as const })))
      .onConflictDoNothing()
      .returning({ userId: teamMembers.userId });
    for (const { userId } of added)
      await recordAudit(tx, {
        action: "identity.member.added",
        teamId,
        target: { userId, role: "member", via: "skill_reviewer_grant" },
      });
  });
}

async function registryTeamId(tx: KobeDb | KobeTx): Promise<string | null> {
  const [row] = await tx
    .select({ id: siteSkillSettings.registryTeamId })
    .from(siteSkillSettings)
    .where(eq(siteSkillSettings.id, 1));
  return row?.id ?? null;
}

/** Every Skill reviewer, for when a team becomes the Registry team. */
export async function reviewerIds(db: KobeDb | KobeTx): Promise<string[]> {
  const rows = await db
    .select({ userId: siteGrants.userId })
    .from(siteGrants)
    .where(eq(siteGrants.grant, "skill_reviewer"));
  return rows.map((r) => r.userId);
}

export async function giveGrant(
  db: KobeDb,
  userId: string,
  grant: SiteGrant,
  by: string,
): Promise<{ readonly changed: boolean }> {
  const changed = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(siteGrants)
      .values({ userId, grant, grantedBy: by })
      .onConflictDoNothing()
      .returning({ userId: siteGrants.userId });
    if (rows.length > 0)
      await recordAudit(tx, { action: "identity.site_grant.granted", target: { userId, grant } });
    return rows.length > 0;
  });
  const team = await registryTeamId(db);
  if (grant === "skill_reviewer" && team) await joinRegistryTeam(db, team, [userId]);
  return { changed };
}

export async function takeGrant(
  db: KobeDb,
  userId: string,
  grant: SiteGrant,
): Promise<{ readonly changed: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(siteGrants)
      .where(and(eq(siteGrants.userId, userId), inArray(siteGrants.grant, [grant])))
      .returning({ userId: siteGrants.userId });
    if (rows.length > 0)
      await recordAudit(tx, { action: "identity.site_grant.revoked", target: { userId, grant } });
    return { changed: rows.length > 0 };
  });
}
