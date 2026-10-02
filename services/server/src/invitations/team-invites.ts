import {
  and,
  asc,
  eq,
  gt,
  isNull,
  scanTeams,
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
import { normalizeEmail } from "./install-invites.js";

/** Team invitations stay open for 14 days (no secret involved: acceptance needs a signed-in user). */
export const TEAM_INVITE_TTL_DAYS = 14;

// Database clock for expiry, as for install invitations.
const teamInviteExpiry = sql`now() + make_interval(days => ${TEAM_INVITE_TTL_DAYS})`;

export interface TeamInvite {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly expiresAt: string;
}

export interface TeamInviteSummary extends TeamInvite {
  readonly invitedBy: { readonly id: string; readonly name: string };
  readonly createdAt: string;
  readonly status: "pending" | "expired";
}

/**
 * Invites an address into the team (or renews the invitation with the new role). The answer is
 * the same whether or not the address belongs to a Kobe user; only current members (visible on the
 * roster anyway) are reported.
 */
export async function inviteToTeam(
  db: KobeDb,
  teamId: string,
  input: { readonly email: string; readonly role: TeamRole; readonly invitedBy: string },
): Promise<TeamInvite | "already_member"> {
  const email = normalizeEmail(input.email);
  return withTeam(db, teamId, async (tx) => {
    const [member] = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), eq(users.email, email)));
    if (member) return "already_member";
    const values = {
      role: input.role,
      invitedBy: input.invitedBy,
      createdAt: sql`now()`,
      expiresAt: teamInviteExpiry,
    };
    const [row] = await tx
      .insert(teamInvitations)
      .values({ teamId, email, ...values })
      .onConflictDoUpdate({ target: [teamInvitations.teamId, teamInvitations.email], set: values })
      .returning({ id: teamInvitations.id, expiresAt: teamInvitations.expiresAt });
    if (!row) throw new Error("team invitation upsert returned no row");
    await recordAudit(tx, {
      action: "identity.team_invitation.created",
      teamId,
      target: { invitationId: row.id, email, role: input.role },
    });
    return { id: row.id, email, role: input.role, expiresAt: row.expiresAt.toISOString() };
  });
}

export async function listTeamInvites(db: KobeDb, teamId: string): Promise<TeamInviteSummary[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({
        id: teamInvitations.id,
        email: teamInvitations.email,
        role: teamInvitations.role,
        invitedById: users.id,
        invitedByName: users.name,
        createdAt: teamInvitations.createdAt,
        expiresAt: teamInvitations.expiresAt,
        live: sql<boolean>`${teamInvitations.expiresAt} > now()`,
      })
      .from(teamInvitations)
      .innerJoin(users, eq(users.id, teamInvitations.invitedBy))
      .where(eq(teamInvitations.teamId, teamId))
      .orderBy(asc(teamInvitations.createdAt)),
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: { id: r.invitedById, name: r.invitedByName },
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    status: r.live ? "pending" : "expired",
  }));
}

export async function revokeTeamInvite(db: KobeDb, teamId: string, id: string): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .delete(teamInvitations)
      .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.id, id)))
      .returning({ id: teamInvitations.id });
    if (rows.length === 0) return false;
    await recordAudit(tx, {
      action: "identity.team_invitation.revoked",
      teamId,
      target: { invitationId: id },
    });
    return true;
  });
}

/**
 * The invited user joins: consumes their open invitation to the team and adds the membership, in
 * one team transaction. `email` must be the signed-in user's own (verified) address. The invitation
 * counts only while its inviter is still an active team admin of this team (the authority to grant
 * any team role): the inviter's membership and user rows are share-locked, so a concurrent demotion,
 * removal or deactivation either waits for this to finish (and then revokes nothing left) or wins
 * and the invitation is refused. Null when no valid invitation exists (unknown team, expired,
 * revoked, inviter without authority: one answer); an invalid one is deleted.
 */
export async function acceptTeamInvite(
  db: KobeDb,
  teamId: string,
  user: { readonly id: string; readonly email: string },
): Promise<TeamRole | null> {
  const email = normalizeEmail(user.email);
  return withTeam(db, teamId, async (tx) => {
    const [invite] = await tx
      .delete(teamInvitations)
      .where(
        and(
          eq(teamInvitations.teamId, teamId),
          eq(teamInvitations.email, email),
          gt(teamInvitations.expiresAt, sql`now()`),
        ),
      )
      .returning({ role: teamInvitations.role, invitedBy: teamInvitations.invitedBy });
    if (!invite) return null;
    const [inviter] = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, invite.invitedBy),
          eq(teamMembers.role, "team_admin"),
          isNull(users.deactivatedAt),
        ),
      )
      .for("share");
    if (!inviter) return null;
    const joined = await tx
      .insert(teamMembers)
      .values({ teamId, userId: user.id, role: invite.role })
      .onConflictDoNothing()
      .returning({ role: teamMembers.role });
    const [membership] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)));
    // Recorded only when the invitation actually made them a member.
    if (joined.length > 0) {
      await recordAudit(tx, {
        action: "identity.team_invitation.accepted",
        teamId,
        target: { userId: user.id, role: invite.role, invitedBy: invite.invitedBy },
      });
    }
    return membership?.role ?? null;
  });
}

/**
 * Deletes the pending invitations a user sent in a team, inside the caller's team transaction:
 * used when they lose the authority to invite (demoted below team admin or removed).
 */
export async function revokeInvitesSentBy(tx: KobeTx, teamId: string, userId: string) {
  await tx
    .delete(teamInvitations)
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.invitedBy, userId)));
}

/** Deletes a user's pending invitations in every team (deactivation), team by team under RLS. */
export async function revokeAllInvitesSentBy(db: KobeDb, userId: string): Promise<void> {
  await scanTeams(db, "revokeAllInvitesSentBy", async (tx, team) => {
    await revokeInvitesSentBy(tx, team.id, userId);
    return undefined;
  });
}

/** The invited user says no; the invitation is deleted. */
export async function declineTeamInvite(
  db: KobeDb,
  teamId: string,
  email: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .delete(teamInvitations)
      .where(
        and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.email, normalizeEmail(email))),
      )
      .returning({ id: teamInvitations.id });
    if (rows.length === 0) return false;
    await recordAudit(tx, { action: "identity.team_invitation.declined", teamId, target: {} });
    return true;
  });
}
