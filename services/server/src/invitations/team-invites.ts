import {
  and,
  asc,
  eq,
  gt,
  sql,
  teamInvitations,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type TeamRole,
} from "@kobe/db";
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
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .delete(teamInvitations)
      .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.id, id)))
      .returning({ id: teamInvitations.id }),
  );
  return rows.length > 0;
}

/**
 * The invited user joins: consumes their open invitation to the team and adds the membership, in
 * one team transaction. `email` must be the signed-in user's own (verified) address. Null when no
 * open invitation exists (unknown team, expired, revoked: one answer).
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
      .returning({ role: teamInvitations.role });
    if (!invite) return null;
    await tx
      .insert(teamMembers)
      .values({ teamId, userId: user.id, role: invite.role })
      .onConflictDoNothing();
    const [membership] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)));
    return membership?.role ?? null;
  });
}

/** The invited user says no; the invitation is deleted. */
export async function declineTeamInvite(
  db: KobeDb,
  teamId: string,
  email: string,
): Promise<boolean> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .delete(teamInvitations)
      .where(
        and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.email, normalizeEmail(email))),
      )
      .returning({ id: teamInvitations.id }),
  );
  return rows.length > 0;
}
