import type { MemorySteward } from "@kobe/protocol";
import {
  and,
  asc,
  eq,
  memoryStewards,
  siteGrants,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Memory stewards (KOBE-380, spec SM19). A Workspace steward is a `memory_stewards` row: a grant
 * on top of any Workspace role, given and taken by Team admins, audited
 * `memory.steward.granted/revoked` (team log), and it goes with the membership. A Site steward
 * is the `memory_steward` site grant (`skills/registry/grants.ts`, audited
 * `identity.site_grant.*`). What each may do is decided in `authz/permissions.ts`.
 */

const STEWARD_COLUMNS = {
  userId: memoryStewards.userId,
  name: users.name,
  grantedBy: memoryStewards.grantedBy,
  grantedAt: memoryStewards.grantedAt,
} as const;

type Row = { userId: string; name: string; grantedBy: string; grantedAt: Date };

const toWire = (r: Row): MemorySteward => ({
  user_id: r.userId,
  name: r.name,
  granted_by: r.grantedBy,
  granted_at: r.grantedAt.toISOString(),
});

/** The Workspace's stewards, by name. */
export async function listWorkspaceStewards(db: KobeDb, teamId: string): Promise<MemorySteward[]> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select(STEWARD_COLUMNS)
      .from(memoryStewards)
      .innerJoin(users, eq(users.id, memoryStewards.userId))
      .where(eq(memoryStewards.teamId, teamId))
      .orderBy(asc(users.name), asc(memoryStewards.userId)),
  );
  return rows.map(toWire);
}

/** Whether `userId` is a steward of the Workspace (read per request, so revoking works at once). */
export async function isWorkspaceSteward(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({ userId: memoryStewards.userId })
      .from(memoryStewards)
      .where(and(eq(memoryStewards.teamId, teamId), eq(memoryStewards.userId, userId))),
  );
  return rows.length > 0;
}

export type GrantStewardResult =
  | { readonly ok: true; readonly steward: MemorySteward; readonly changed: boolean }
  | { readonly ok: false; readonly code: "user_not_found" };

/** Makes a member of the Workspace a steward (any role); idempotent, audited once. */
export async function grantWorkspaceSteward(
  db: KobeDb,
  teamId: string,
  userId: string,
  by: string,
): Promise<GrantStewardResult> {
  return withTeam(db, teamId, async (tx) => {
    // The membership row is held while the grant is written, so a concurrent removal waits.
    const [member] = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .for("share");
    if (!member) return { ok: false as const, code: "user_not_found" as const };
    const added = await tx
      .insert(memoryStewards)
      .values({ teamId, userId, grantedBy: by })
      .onConflictDoNothing()
      .returning({ userId: memoryStewards.userId });
    if (added.length > 0)
      await recordAudit(tx, { action: "memory.steward.granted", teamId, target: { userId } });
    const [row] = await tx
      .select(STEWARD_COLUMNS)
      .from(memoryStewards)
      .innerJoin(users, eq(users.id, memoryStewards.userId))
      .where(and(eq(memoryStewards.teamId, teamId), eq(memoryStewards.userId, userId)));
    if (!row) throw new Error("memory steward vanished inside its own transaction");
    return { ok: true as const, steward: toWire(row), changed: added.length > 0 };
  });
}

/** Takes the grant inside the caller's team transaction; audited when there was one. */
export async function revokeWorkspaceStewardInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const gone = await tx
    .delete(memoryStewards)
    .where(and(eq(memoryStewards.teamId, teamId), eq(memoryStewards.userId, userId)))
    .returning({ userId: memoryStewards.userId });
  if (gone.length === 0) return false;
  await recordAudit(tx, { action: "memory.steward.revoked", teamId, target: { userId } });
  return true;
}

export async function revokeWorkspaceSteward(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<boolean> {
  return withTeam(db, teamId, (tx) => revokeWorkspaceStewardInTx(tx, teamId, userId));
}

/** The Site's stewards (the `memory_steward` site grant), active accounts only, by name. */
export async function listSiteStewards(db: KobeDb): Promise<MemorySteward[]> {
  const rows = await db
    .select({
      userId: siteGrants.userId,
      name: users.name,
      grantedBy: siteGrants.grantedBy,
      grantedAt: siteGrants.grantedAt,
      deactivatedAt: users.deactivatedAt,
    })
    .from(siteGrants)
    .innerJoin(users, eq(users.id, siteGrants.userId))
    .where(eq(siteGrants.grant, "memory_steward"))
    .orderBy(asc(users.name), asc(siteGrants.userId));
  return rows.filter((r) => r.deactivatedAt === null).map(toWire);
}
