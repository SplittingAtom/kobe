import {
  and,
  eq,
  isNotNull,
  isNull,
  listMemberships,
  notifyEgressUserChanged,
  sessions,
  teamMembers,
  users,
  verifications,
  withTeam,
  type KobeDb,
  type KobeTx,
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

/** Extra writes a caller makes in the same transaction as the (de)activation (e.g. SCIM's audit). */
export interface ActivationOptions {
  /** Runs inside the transaction, before its audit row; `changed` says whether the state moved. */
  readonly inTx?: (tx: KobeTx, changed: boolean) => Promise<void>;
}

/** Who deactivates (SSO11): a site admin (default), or one provider's SCIM (`scim:<id>`). */
export type DeactivatedVia = "admin" | `scim:${string}`;

export interface DeactivationOptions extends ActivationOptions {
  readonly via?: DeactivatedVia;
}

/** How a deactivation was recorded (`users.deactivated_via`); null when active or unknown. */
export async function deactivatedVia(db: KobeDb | KobeTx, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ via: users.deactivatedVia, at: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row?.at ? (row.via ?? "admin") : null;
}

/**
 * Deactivates a user (spec D7) in one transaction: marks the user, deletes every session (so every
 * cookie and the sessions behind short-lived JWTs stop working at once) and every pending
 * verification bound to the user (password-reset tokens, 2FA challenges). The row lock taken by the
 * UPDATE pairs with the sessions trigger, so a sign-in racing this can't leave a live session.
 * Memberships are kept (inert while deactivated) so reactivation restores access. Returns false if
 * the user was already deactivated.
 */
export async function deactivateUser(
  db: KobeDb,
  userId: string,
  options: DeactivationOptions = {},
): Promise<boolean> {
  const via = options.via ?? "admin";
  const changed = await db.transaction(async (tx) => {
    const changed = await tx
      .update(users)
      .set({ deactivatedAt: new Date(), deactivatedVia: via, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deactivatedAt)))
      .returning({ id: users.id });
    // A site admin deactivating someone SCIM already deactivated makes it theirs (SSO11): SCIM can
    // no longer reactivate the user.
    if (changed.length === 0 && via === "admin") {
      await tx
        .update(users)
        .set({ deactivatedVia: "admin" })
        .where(and(eq(users.id, userId), isNotNull(users.deactivatedAt)));
    }
    // Revoke even when already deactivated: cheap, and closes anything a past bug left behind.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(verifications).where(eq(verifications.value, userId));
    await options.inTx?.(tx, changed.length > 0);
    if (changed.length > 0) {
      // Egress proxies close the user's open tunnels (KOBE-38).
      await notifyEgressUserChanged(tx, userId);
      await recordAudit(tx, { action: "identity.user.deactivated", target: { userId } });
    }
    return changed.length > 0;
  });
  // Their pending team invitations lose their authority (acceptance re-checks it as well).
  await revokeAllInvitesSentBy(db, userId);
  return changed;
}

/** Reactivates a user; they sign in again with their existing credentials. False if not deactivated. */
export async function reactivateUser(
  db: KobeDb,
  userId: string,
  options: ActivationOptions = {},
): Promise<boolean> {
  return (await reactivate(db, userId, undefined, options)) === "reactivated";
}

/**
 * Reactivates a user only when `via` deactivated them (SSO11: SCIM undoes only its own
 * deactivation). The check and the update run in one transaction on the locked user row, so an
 * admin's deactivation committed meanwhile wins (`refused`).
 */
export function reactivateUserIfVia(
  db: KobeDb,
  userId: string,
  via: DeactivatedVia,
  options: ActivationOptions = {},
): Promise<"reactivated" | "unchanged" | "refused"> {
  return reactivate(db, userId, via, options);
}

async function reactivate(
  db: KobeDb,
  userId: string,
  via: DeactivatedVia | undefined,
  options: ActivationOptions,
): Promise<"reactivated" | "unchanged" | "refused"> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ at: users.deactivatedAt, via: users.deactivatedVia })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (via !== undefined && row?.at && (row.via ?? "admin") !== via) return "refused";
    const changed = await tx
      .update(users)
      .set({ deactivatedAt: null, deactivatedVia: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNotNull(users.deactivatedAt)))
      .returning({ id: users.id });
    await options.inTx?.(tx, changed.length > 0);
    if (changed.length > 0) {
      await recordAudit(tx, { action: "identity.user.reactivated", target: { userId } });
    }
    return changed.length > 0 ? "reactivated" : "unchanged";
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
