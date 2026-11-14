import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  teamInvitations,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { normalizeEmail } from "../invitations/site-invites.js";
import { SITE_ADMIN_VIA } from "./members.js";
import { reopenRetentionInTx } from "../offboarding/reopen.js";

/** Most users one Add takes (the Site console picker sends a handful). */
export const ADD_MEMBERS_MAX = 50;
/** Most candidates one search returns. */
export const CANDIDATES_MAX = 20;

/** Why an Add was refused; nothing was added (all or nothing). */
export type AddMembersError =
  /** A Site admin reaches team content only through break-glass, never by adding themselves. */
  | "self_add_refused"
  | "user_not_found"
  | "user_deactivated"
  /**
   * The account's address is not verified (an identity provider did not vouch for it): the same
   * rule as accepting a team invitation (review L1), so nobody gets a team role by an address that
   * may be someone else's.
   */
  | "user_unverified"
  | "already_member";

export type AddMembersResult =
  | { readonly ok: true; readonly added: readonly string[] }
  | { readonly ok: false; readonly error: AddMembersError; readonly userId: string };

class Refused extends Error {
  constructor(
    readonly error: AddMembersError,
    readonly userId: string,
  ) {
    super(error);
  }
}

/**
 * A Site admin adds existing, active users to a team directly, without an invitation (KOBE-638).
 * All or nothing, in one team transaction: the users' rows are share-locked so a concurrent
 * deactivation waits (or wins and the Add is refused). Each new row is tagged `site_admin`, audited
 * `identity.member.added` with `via: "site_admin"` (the actor is the Site admin, in the team's own
 * log), and the user gets an in-app `team.member.added` notification naming the admin. Email is
 * the caller's (after the commit).
 */
export async function addExistingMembers(
  db: KobeDb,
  teamId: string,
  input: { readonly userIds: readonly string[]; readonly role: TeamRole; readonly actorId: string },
): Promise<AddMembersResult> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.includes(input.actorId)) {
    return { ok: false, error: "self_add_refused", userId: input.actorId };
  }
  try {
    await withTeam(db, teamId, (tx) => addInTx(tx, teamId, userIds, input));
    return { ok: true, added: userIds };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error, userId: err.userId };
    throw err;
  }
}

async function addInTx(
  tx: KobeTx,
  teamId: string,
  userIds: readonly string[],
  input: { readonly role: TeamRole; readonly actorId: string },
): Promise<void> {
  const found = await tx
    .select({
      id: users.id,
      email: users.email,
      deactivatedAt: users.deactivatedAt,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(inArray(users.id, [...userIds]))
    .for("share");
  const byId = new Map(found.map((u) => [u.id, u]));
  for (const userId of userIds) {
    const user = byId.get(userId);
    if (!user) throw new Refused("user_not_found", userId);
    if (user.deactivatedAt !== null) throw new Refused("user_deactivated", userId);
    if (!user.emailVerified) throw new Refused("user_unverified", userId);
  }
  const inserted = await tx
    .insert(teamMembers)
    .values(
      userIds.map((userId) => ({ teamId, userId, role: input.role, addedVia: SITE_ADMIN_VIA })),
    )
    .onConflictDoNothing()
    .returning({ userId: teamMembers.userId });
  const added = new Set(inserted.map((r) => r.userId));
  // Returning members' old 30-day records are reopened (KOBE-386 review H1).
  await reopenRetentionInTx(tx, teamId, [...added]);
  const existing = userIds.find((u) => !added.has(u));
  if (existing !== undefined) throw new Refused("already_member", existing);
  // Their pending invitations to this team are moot now (review L3): revoked, audited.
  const revoked = await tx
    .delete(teamInvitations)
    .where(
      and(
        eq(teamInvitations.teamId, teamId),
        inArray(
          teamInvitations.email,
          found.map((u) => normalizeEmail(u.email)),
        ),
      ),
    )
    .returning({ id: teamInvitations.id });
  for (const { id } of revoked) {
    await recordAudit(tx, {
      action: "identity.team_invitation.revoked",
      teamId,
      target: { invitationId: id },
    });
  }
  for (const userId of userIds) {
    await recordAudit(tx, {
      action: "identity.member.added",
      teamId,
      target: { userId, role: input.role, via: SITE_ADMIN_VIA },
    });
    await tx.execute(sql`
      INSERT INTO notifications (team_id, user_id, kind, actor_user_id)
      VALUES (${teamId}, ${userId}, 'team.member.added', ${input.actorId})`);
  }
}

export interface Candidate {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Users a Site admin can add to the team (KOBE-638): active, verified address (review L1), not
 * already members, never the caller, matched by name or email (case-insensitive substring), at most {@link CANDIDATES_MAX}.
 */
export async function searchCandidates(
  db: KobeDb,
  teamId: string,
  input: { readonly query: string; readonly actorId: string },
): Promise<Candidate[]> {
  const pattern = `%${input.query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  // NOT EXISTS, not a list of every member's id (review I3): any team size, one round trip.
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(users)
      .where(
        and(
          isNull(users.deactivatedAt),
          eq(users.emailVerified, true),
          sql`${users.id} <> ${input.actorId}`,
          sql`NOT EXISTS (SELECT 1 FROM team_members tm
                WHERE tm.team_id = ${teamId} AND tm.user_id = ${users.id})`,
          input.query === ""
            ? undefined
            : or(sql`${users.name} ILIKE ${pattern}`, sql`${users.email} ILIKE ${pattern}`),
        ),
      )
      .orderBy(asc(users.name), asc(users.email))
      .limit(CANDIDATES_MAX),
  );
  return rows;
}
