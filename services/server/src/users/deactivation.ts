import {
  and,
  eq,
  isNotNull,
  isNull,
  listMemberships,
  sessions,
  teamMembers,
  users,
  verifications,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { revokeAllInvitesSentBy } from "../invitations/team-invites.js";

/** True when the user exists and is deactivated. */
export async function isDeactivated(db: KobeDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.deactivatedAt)));
  return row !== undefined;
}

/**
 * Deactivates a user (spec D7) in one transaction: marks the user, deletes every session (so every
 * cookie and the sessions behind short-lived JWTs stop working at once) and every pending
 * verification bound to the user (password-reset tokens, 2FA challenges). The row lock taken by the
 * UPDATE pairs with the sessions trigger, so a sign-in racing this can't leave a live session.
 * Memberships are kept (inert while deactivated) so reactivation restores access. Returns false if
 * the user was already deactivated.
 */
export async function deactivateUser(db: KobeDb, userId: string): Promise<boolean> {
  const changed = await db.transaction(async (tx) => {
    const changed = await tx
      .update(users)
      .set({ deactivatedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deactivatedAt)))
      .returning({ id: users.id });
    // Revoke even when already deactivated: cheap, and closes anything a past bug left behind.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(verifications).where(eq(verifications.value, userId));
    if (changed.length > 0) {
      await recordAudit(tx, { action: "identity.user.deactivated", target: { userId } });
    }
    return changed.length > 0;
  });
  // Their pending team invitations lose their authority (acceptance re-checks it as well).
  await revokeAllInvitesSentBy(db, userId);
  return changed;
}

/** Reactivates a user; they sign in again with their existing credentials. False if not deactivated. */
export async function reactivateUser(db: KobeDb, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx
      .update(users)
      .set({ deactivatedAt: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNotNull(users.deactivatedAt)))
      .returning({ id: users.id });
    if (changed.length > 0) {
      await recordAudit(tx, { action: "identity.user.reactivated", target: { userId } });
    }
    return changed.length > 0;
  });
}

/** Teams where this user is a team admin and no other active team admin remains. */
export async function teamsLeftWithoutActiveAdmin(
  db: KobeDb,
  userId: string,
): Promise<{ readonly id: string; readonly slug: string; readonly name: string }[]> {
  const adminOf = (await listMemberships(db, userId)).filter((m) => m.role === "team_admin");
  const orphaned = [];
  for (const team of adminOf) {
    const others = await withTeam(db, team.teamId, (tx) =>
      tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            eq(teamMembers.teamId, team.teamId),
            eq(teamMembers.role, "team_admin"),
            isNull(users.deactivatedAt),
          ),
        ),
    );
    if (others.every((o) => o.userId === userId)) {
      orphaned.push({ id: team.teamId, slug: team.slug, name: team.name });
    }
  }
  return orphaned;
}
