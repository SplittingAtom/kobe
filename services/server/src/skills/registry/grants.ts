import type { SiteGrant } from "@kobe/protocol";
import {
  and,
  asc,
  eq,
  isNull,
  siteGrants,
  siteRoles,
  sql,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { removeMemberInTx } from "../../teams/members.js";

/**
 * Site grants beside the role ladder (KOBE-331, SK22): the **Skill reviewer** grant, given and
 * taken by the Owner or a Site admin, audited. Kobe adds every grantee to the dedicated Registry
 * team (never another team: review H1) as a member it marks `added_via` the grant, and taking the
 * grant removes exactly those memberships (a member by invitation, or one a team admin changed,
 * stays). The grant and the membership change are one transaction (review M4).
 */

export const VIA_GRANT = "skill_reviewer_grant" as const;

export interface GrantHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly grant: SiteGrant;
  readonly grantedBy: string;
  readonly grantedAt: string;
  /** A deactivated holder's grant counts for nothing until they are reactivated (D7). */
  readonly deactivated: boolean;
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
      deactivatedAt: users.deactivatedAt,
    })
    .from(siteGrants)
    .innerJoin(users, eq(users.id, siteGrants.userId))
    .orderBy(asc(users.name));
  return rows.map(({ deactivatedAt, ...r }) => ({
    ...r,
    grantedAt: r.grantedAt.toISOString(),
    deactivated: deactivatedAt !== null,
  }));
}

/** The user's site grants; an inactive account's grants count for nothing. */
export async function grantsOf(db: KobeDb, userId: string): Promise<SiteGrant[]> {
  const rows = await db
    .select({ grant: siteGrants.grant })
    .from(siteGrants)
    .innerJoin(users, eq(users.id, siteGrants.userId))
    .where(and(eq(siteGrants.userId, userId), isNull(users.deactivatedAt)));
  return rows.map((r) => r.grant);
}

/** Every active Skill reviewer, for when the Registry team is created. */
export async function reviewerIds(db: KobeDb | KobeTx): Promise<string[]> {
  const rows = await db
    .select({ userId: siteGrants.userId })
    .from(siteGrants)
    .innerJoin(users, eq(users.id, siteGrants.userId))
    .where(and(eq(siteGrants.grant, "skill_reviewer"), isNull(users.deactivatedAt)));
  return rows.map((r) => r.userId);
}

/**
 * Adds grantees to the Registry team (inside its team transaction) as members Kobe made; anyone
 * already a member keeps their own membership. Each addition is audited in the team's log.
 */
export async function joinRegistryTeamInTx(
  tx: KobeTx,
  teamId: string,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const added = await tx
    .insert(teamMembers)
    .values(
      userIds.map((userId) => ({ teamId, userId, role: "member" as const, addedVia: VIA_GRANT })),
    )
    .onConflictDoNothing()
    .returning({ userId: teamMembers.userId });
  for (const { userId } of added)
    await recordAudit(tx, {
      action: "identity.member.added",
      teamId,
      target: { userId, role: "member", via: VIA_GRANT },
    });
}

/** The Registry team under a share lock on the settings row, read inside the caller's transaction. */
async function registryTeamIn(tx: KobeDb | KobeTx): Promise<string | null> {
  const res = await tx.execute<{ id: string | null }>(sql`
    SELECT registry_team_id AS id FROM site_skill_settings WHERE id = 1 FOR SHARE`);
  return res.rows[0]?.id ?? null;
}

/**
 * Runs `fn` in one transaction that also covers the Registry team's rows (team_members has FORCE
 * RLS): inside `withTeam(registry)` when there is one. If the Registry team changed between the
 * look and the lock, it looks again once.
 */
async function inRegistryTx<T>(
  db: KobeDb,
  fn: (tx: KobeTx, team: string | null) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const seen = await registryTeamIn(db);
    const run = async (tx: KobeTx) => {
      const team = await registryTeamIn(tx);
      if (team !== seen) return { retry: true as const };
      return { retry: false as const, value: await fn(tx, team) };
    };
    const r = seen ? await withTeam(db, seen, run) : await db.transaction(run);
    if (!r.retry || attempt > 0) {
      if (r.retry) throw new Error("the Registry team changed while granting");
      return r.value;
    }
  }
}

export type GrantRefusal = "user_not_found" | "user_deactivated" | "not_grantable";

/**
 * Gives the grant (review H1a, M3): never to oneself, never to a Site admin or the Owner (they
 * review through their role), never to a deactivated account.
 */
export async function giveGrant(
  db: KobeDb,
  userId: string,
  grant: SiteGrant,
  by: string,
): Promise<
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly code: GrantRefusal }
> {
  const [user] = await db
    .select({ deactivatedAt: users.deactivatedAt, role: siteRoles.role })
    .from(users)
    .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
    .where(eq(users.id, userId));
  if (!user) return { ok: false, code: "user_not_found" };
  if (user.deactivatedAt !== null) return { ok: false, code: "user_deactivated" };
  if (userId === by || user.role !== null) return { ok: false, code: "not_grantable" };
  return inRegistryTx(db, async (tx, team) => {
    const rows = await tx
      .insert(siteGrants)
      .values({ userId, grant, grantedBy: by })
      .onConflictDoNothing()
      .returning({ userId: siteGrants.userId });
    if (rows.length > 0)
      await recordAudit(tx, { action: "identity.site_grant.granted", target: { userId, grant } });
    if (team && grant === "skill_reviewer") await joinRegistryTeamInTx(tx, team, [userId]);
    return { ok: true as const, changed: rows.length > 0 };
  });
}

/** Takes the grant and, in the same transaction, the Registry membership it made. */
export async function takeGrant(
  db: KobeDb,
  userId: string,
  grant: SiteGrant,
): Promise<{ readonly changed: boolean }> {
  return inRegistryTx(db, async (tx, team) => {
    const rows = await tx
      .delete(siteGrants)
      .where(and(eq(siteGrants.userId, userId), eq(siteGrants.grant, grant)))
      .returning({ userId: siteGrants.userId });
    if (rows.length === 0) return { changed: false };
    await recordAudit(tx, { action: "identity.site_grant.revoked", target: { userId, grant } });
    if (team && grant === "skill_reviewer") {
      const [member] = await tx
        .select({ addedVia: teamMembers.addedVia })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, team), eq(teamMembers.userId, userId)));
      if (member?.addedVia === VIA_GRANT) await removeMemberInTx(tx, team, userId, VIA_GRANT);
    }
    return { changed: true };
  });
}
