import { endUnreachableThreadRules } from "../policy/user-rules.js";
import {
  and,
  asc,
  eq,
  inArray,
  notifyEgressUserChanged,
  ssoProviders,
  teamMembers,
  teams,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { revokeInvitesSentBy } from "../invitations/team-invites.js";
import { endProjectStandingInTx } from "../projects/offboard.js";
import { pauseOwnerSchedulesInTx } from "../schedules/offboard.js";
import { endSharesOf } from "../threads/share-scope.js";
import { seedDefaultSkillInstalls } from "../skills/default-sync-team.js";

export interface TeamMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly joinedAt: string;
  /**
   * Kobe added them for the Skill reviewer grant (KOBE-331); taking the grant removes them.
   * `idp`: an identity provider's access mappings manage the row (KOBE-627, SSO10): see `managedBy`.
   * `site_admin`: a Site admin added them from the Site console (KOBE-638). Null: they joined by
   * invitation, or were the team's first admin.
   */
  readonly addedVia: "skill_reviewer_grant" | "idp" | "site_admin" | null;
  /** Deactivated users stay members but can't sign in (KOBE-638: the roster shows the status). */
  readonly deactivated: boolean;
  /** The provider whose mappings manage the row; a team admin can only take it over. */
  readonly managedBy: { readonly providerId: string; readonly providerName: string } | null;
}

export interface TeamSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** Why a membership change was refused; routes map these to HTTP errors. */
export type MembershipError =
  | "not_a_member"
  | "last_team_admin"
  | "changed_since_approval"
  /** The row is managed by an identity provider's mappings (SSO10): take it over first. */
  | "managed_by_idp"
  /** Take over of a row no identity provider manages. */
  | "not_managed";

/** `team_members.added_via` of a row the provider's access mappings manage (spec sso §7). */
export const idpAddedVia = (providerId: string): string => `idp:${providerId}`;

const IDP_PREFIX = "idp:";

/** The provider id of a managed row's `added_via`, or null for any other row. */
export function idpProviderOf(addedVia: string | null): string | null {
  return addedVia?.startsWith(IDP_PREFIX) ? addedVia.slice(IDP_PREFIX.length) : null;
}

/** `team_members.added_via` of a row a Site admin added from the Site console (KOBE-638). */
export const SITE_ADMIN_VIA = "site_admin";

/**
 * Who changed a row when it was not the team's own admin (KOBE-638): a Site admin from the Site
 * console. Only the audit event says so (`via: "site_admin"`, the actor is the Site admin); the
 * rules are a person's (managed rows refused, last team admin kept).
 */
export type MemberChangeOrigin = typeof SITE_ADMIN_VIA;

const originAudit = (origin: MemberChangeOrigin | undefined) =>
  origin === undefined ? {} : { via: origin };

/** Why Kobe itself changes a row: the Skill reviewer grant, or a provider's mappings. */
export type MemberChangeVia = "skill_reviewer_grant" | { readonly idp: string };

const auditVia = (via: MemberChangeVia | undefined) =>
  via === undefined
    ? {}
    : via === "skill_reviewer_grant"
      ? { via }
      : { via: "idp" as const, providerId: via.idp };

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
        addedVia: teamMembers.addedVia,
        deactivatedAt: users.deactivatedAt,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(users.name), asc(users.email)),
  );
  const providerIds = [
    ...new Set(rows.map((r) => idpProviderOf(r.addedVia)).filter((p) => p !== null)),
  ];
  const names = new Map(
    providerIds.length === 0
      ? []
      : (
          await db
            .select({ id: ssoProviders.id, name: ssoProviders.displayName })
            .from(ssoProviders)
            .where(inArray(ssoProviders.id, providerIds))
        ).map((p) => [p.id, p.name]),
  );
  return rows.map(({ deactivatedAt, ...r }) => {
    const providerId = idpProviderOf(r.addedVia);
    return {
      ...r,
      joinedAt: r.joinedAt.toISOString(),
      deactivated: deactivatedAt !== null,
      addedVia:
        r.addedVia === "skill_reviewer_grant" || r.addedVia === SITE_ADMIN_VIA
          ? r.addedVia
          : providerId !== null
            ? "idp"
            : null,
      managedBy:
        providerId === null
          ? null
          : { providerId, providerName: names.get(providerId) ?? "identity provider" },
    };
  });
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

/**
 * Locks the team's admin rows and the target row, so concurrent changes can't drop the last admin.
 * Only active (not deactivated) team admins count: a deactivated admin can't run the team.
 */
export async function lockForChange(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<{
  activeAdmins: number;
  current: TeamRole | null;
  targetActive: boolean;
  addedVia: string | null;
}> {
  const admins = await tx
    .select({ userId: teamMembers.userId, deactivatedAt: users.deactivatedAt })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "team_admin")))
    .for("update", { of: teamMembers });
  const [target] = await tx
    .select({
      role: teamMembers.role,
      deactivatedAt: users.deactivatedAt,
      addedVia: teamMembers.addedVia,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .for("update", { of: teamMembers });
  return {
    activeAdmins: admins.filter((a) => a.deactivatedAt === null).length,
    current: target?.role ?? null,
    targetActive: target?.deactivatedAt === null,
    addedVia: target?.addedVia ?? null,
  };
}

/**
 * Whether `via` may change the locked row (SSO10): a provider's mappings only their own rows; a
 * person (no `via`) or the Skill reviewer grant never a row a provider manages.
 */
function managedRefusal(
  lock: Awaited<ReturnType<typeof lockForChange>>,
  via: MemberChangeVia | undefined,
): MembershipError | null {
  const provider = idpProviderOf(lock.addedVia);
  if (via !== undefined && via !== "skill_reviewer_grant") {
    return provider === via.idp ? null : "not_managed";
  }
  return provider === null ? null : "managed_by_idp";
}

/** Whether changing the target away from team admin would leave no active team admin. */
const losesLastActiveAdmin = (lock: Awaited<ReturnType<typeof lockForChange>>) =>
  lock.current === "team_admin" && lock.targetActive && lock.activeAdmins <= 1;

/** Changes a member's role; a team always keeps at least one team admin. */
export async function setMemberRole(
  db: KobeDb,
  teamId: string,
  userId: string,
  role: TeamRole,
  /** KOBE-619: change only while the role is still this one (the approved before-state). */
  expected?: TeamRole,
  /** KOBE-638: a Site admin's change from the Site console. */
  origin?: MemberChangeOrigin,
): Promise<MembershipResult> {
  return withTeam(db, teamId, (tx) =>
    setMemberRoleInTx(tx, teamId, userId, role, {
      ...(expected === undefined ? {} : { expected }),
      ...(origin === undefined ? {} : { origin }),
    }),
  );
}

/**
 * {@link setMemberRole} inside the caller's team transaction. A person's change (no `via`) makes
 * the row the team's own (KOBE-331 review) and is refused on a provider-managed row (SSO10); a
 * provider's change (`via.idp`) keeps the row managed and applies only to its own rows.
 */
export async function setMemberRoleInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
  role: TeamRole,
  opts: {
    readonly expected?: TeamRole;
    readonly via?: { readonly idp: string };
    readonly origin?: MemberChangeOrigin;
  } = {},
): Promise<MembershipResult> {
  const lock = await lockForChange(tx, teamId, userId);
  if (lock.current === null) return fail("not_a_member");
  if (opts.expected !== undefined && lock.current !== opts.expected)
    return fail("changed_since_approval");
  const refusal = managedRefusal(lock, opts.via);
  if (refusal) return fail(refusal);
  if (role !== "team_admin" && losesLastActiveAdmin(lock)) return fail("last_team_admin");
  // A person's decision makes a Skill reviewer grant row the team's own member (KOBE-331
  // review); a provider keeps its rows managed, and the other tags only say how they joined.
  const ownRow = opts.via === undefined && lock.addedVia === "skill_reviewer_grant";
  await tx
    .update(teamMembers)
    .set(ownRow ? { role, addedVia: null } : { role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  // Below team admin they can no longer invite: their pending invitations go too.
  if (role !== "team_admin") await revokeInvitesSentBy(tx, teamId, userId);
  // Projects they could open only as a team admin: their thread rules there end (KOBE-289 S2).
  if (role !== "team_admin") await endUnreachableThreadRules(tx, teamId);
  if (lock.current !== role) {
    await recordAudit(tx, {
      action: "identity.member.role_changed",
      teamId,
      target: {
        userId,
        from: lock.current,
        to: role,
        ...(opts.via ? { via: "idp" as const, providerId: opts.via.idp } : {}),
        ...originAudit(opts.origin),
      },
    });
  }
  return OK;
}

/**
 * Removes a member; the last team admin can't be removed. Their schedules in this team are paused
 * in the same transaction; the route then cancels their in-flight scheduled runs here.
 */
export async function removeMember(
  db: KobeDb,
  teamId: string,
  userId: string,
  /** KOBE-621: remove only while the role is still this one (the approved before-state). */
  expected?: TeamRole,
  /** KOBE-638: a Site admin's removal from the Site console. */
  origin?: MemberChangeOrigin,
): Promise<MembershipResult> {
  return withTeam(db, teamId, (tx) =>
    removeMemberInTx(tx, teamId, userId, undefined, expected, origin),
  );
}

/**
 * {@link removeMember} inside the caller's team transaction (KOBE-331 review: taking the Skill
 * reviewer grant removes the membership it made, with the same side effects). `via` names Kobe's
 * reason in the audit event; a provider's mappings (`via.idp`) remove only their own rows, and
 * nothing else removes a provider-managed row (SSO10).
 */
export async function removeMemberInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
  via?: MemberChangeVia,
  expected?: TeamRole,
  origin?: MemberChangeOrigin,
): Promise<MembershipResult> {
  const lock = await lockForChange(tx, teamId, userId);
  if (lock.current === null) return fail("not_a_member");
  if (expected !== undefined && lock.current !== expected) return fail("changed_since_approval");
  const refusal = managedRefusal(lock, via);
  if (refusal) return fail(refusal);
  if (losesLastActiveAdmin(lock)) return fail("last_team_admin");
  await tx
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  await revokeInvitesSentBy(tx, teamId, userId);
  // Their schedules here stop with the membership; other teams' keep running (KOBE-180).
  await pauseOwnerSchedulesInTx(tx, teamId, userId, "member_removed");
  // Egress proxies close the user's open tunnels in this team (KOBE-38).
  await notifyEgressUserChanged(tx, userId);
  // Their shared threads go private: nobody else could revoke them (KOBE-221).
  await endSharesOf(tx, teamId, userId);
  // Their checkouts are discarded and their project rows go (Workspaces PJ3/MT4); the caller
  // reconciles their mounts after the commit.
  await endProjectStandingInTx(tx, teamId, userId);
  await recordAudit(tx, {
    action: "identity.member.removed",
    teamId,
    target: {
      userId,
      role: lock.current,
      ...auditVia(via),
      ...originAudit(via ? undefined : origin),
    },
  });
  return OK;
}

/**
 * Take over (SSO10): a team admin turns a provider-managed row into the team's own. From then on
 * the provider's mappings never change or remove it. The role stays as it is.
 */
export async function takeOverMember(
  db: KobeDb,
  teamId: string,
  userId: string,
  /** KOBE-638: a Site admin's Take over from the Site console. */
  origin?: MemberChangeOrigin,
): Promise<MembershipResult> {
  return withTeam(db, teamId, async (tx) => {
    const lock = await lockForChange(tx, teamId, userId);
    if (lock.current === null) return fail("not_a_member");
    const providerId = idpProviderOf(lock.addedVia);
    if (providerId === null) return fail("not_managed");
    await tx
      .update(teamMembers)
      .set({ addedVia: null })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    await recordAudit(tx, {
      action: "identity.member.taken_over",
      teamId,
      target: { userId, providerId, ...originAudit(origin) },
    });
    return OK;
  });
}

/**
 * Creates a team and its first team admin atomically (a team never exists without an admin).
 * The membership row is written under the new team's RLS context inside the same transaction,
 * with the team's installs of every Default skill.
 */
export async function createTeamWithAdmin(
  db: KobeDb,
  input: { readonly slug: string; readonly name: string; readonly registry?: boolean },
  adminUserId: string,
  /** Runs in the new team's transaction (the Registry team's settings and reviewers, KOBE-330). */
  then?: (tx: KobeTx, team: TeamSummary) => Promise<void>,
): Promise<TeamSummary> {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ slug: input.slug, name: input.name, registry: input.registry === true })
      .returning({ id: teams.id, slug: teams.slug, name: teams.name });
    if (!team) throw new Error("team insert returned no row");
    await withTeam(tx, team.id, async (inner) => {
      await inner
        .insert(teamMembers)
        .values({ teamId: team.id, userId: adminUserId, role: "team_admin" });
      // Every Default skill is installed in a new team at creation (KOBE-314, SK8).
      await seedDefaultSkillInstalls(inner, team.id);
      await recordAudit(inner, {
        action: "identity.team.created",
        teamId: team.id,
        target: { slug: team.slug, name: team.name, adminUserId },
      });
      if (then) await then(inner, team);
    });
    return team;
  });
}
