import {
  and,
  asc,
  connectors,
  eq,
  installRoles,
  listMemberships,
  isNull,
  parseToolsSnapshot,
  teamConnectors,
  teamMembers,
  teams,
  users,
  withTeam,
  type KobeDb,
} from "@kobe/db";

/**
 * Who hears about connector tool drift (KOBE-103, D27). Today: every active install owner and
 * admin (they re-approve), plus the active admins of each team with a `team_connectors` row for the
 * connector. Per-user grants (KOBE-108) and team enablement changes (KOBE-104) extend this module
 * only: add the users holding a grant for the connector to {@link driftRecipients} and, in
 * {@link driftNoticesFor}, their connectors; nothing else needs to know who the recipients are.
 */
export interface DriftRecipient {
  readonly userId: string;
  readonly email: string;
}

/** Teams (all of them; each read under its own RLS) that enabled the connector. */
async function teamsUsing(db: KobeDb, connectorId: string): Promise<string[]> {
  const all = await db.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
  const using: string[] = [];
  for (const { id } of all) {
    const rows = await withTeam(db, id, (tx) =>
      tx
        .select({ id: teamConnectors.connectorId })
        .from(teamConnectors)
        .where(and(eq(teamConnectors.teamId, id), eq(teamConnectors.connectorId, connectorId))),
    );
    if (rows.length > 0) using.push(id);
  }
  return using;
}

export async function driftRecipients(db: KobeDb, connectorId: string): Promise<DriftRecipient[]> {
  const installAdmins = await db
    .select({ userId: users.id, email: users.email })
    .from(installRoles)
    .innerJoin(users, eq(users.id, installRoles.userId))
    .where(isNull(users.deactivatedAt));
  const using = await teamsUsing(db, connectorId);
  const teamAdmins: DriftRecipient[] = [];
  for (const teamId of using) {
    teamAdmins.push(
      ...(await withTeam(db, teamId, (tx) =>
        tx
          .select({ userId: users.id, email: users.email })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(
            and(
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.role, "team_admin"),
              isNull(users.deactivatedAt),
            ),
          ),
      )),
    );
  }
  const byId = new Map<string, DriftRecipient>();
  for (const r of [...installAdmins, ...teamAdmins]) byId.set(r.userId, r);
  return [...byId.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export interface DriftNotice {
  readonly connectorId: string;
  readonly name: string;
  /** Names of the tools awaiting re-approval (changed or new), never their definitions. */
  readonly tools: string[];
}

/** Connectors with tools awaiting re-approval that this user is told about (the in-app notice). */
export async function driftNoticesFor(
  db: KobeDb,
  user: { readonly id: string; readonly installRole: "owner" | "admin" | null },
): Promise<DriftNotice[]> {
  const rows = await db
    .select({ id: connectors.id, name: connectors.name, snapshot: connectors.toolsSnapshot })
    .from(connectors)
    .where(and(eq(connectors.status, "active"), isNull(connectors.deletedAt)))
    .orderBy(asc(connectors.name));
  const drifted = rows
    .map((r) => ({
      connectorId: r.id,
      name: r.name,
      tools: parseToolsSnapshot(r.snapshot)
        .filter((t) => t.status === "drifted")
        .map((t) => t.name),
    }))
    .filter((r) => r.tools.length > 0);
  if (user.installRole !== null || drifted.length === 0) return drifted;

  const adminOf = (await listMemberships(db, user.id)).filter((m) => m.role === "team_admin");
  const visible = new Set<string>();
  for (const { teamId } of adminOf) {
    const enabled = await withTeam(db, teamId, (tx) =>
      tx
        .select({ id: teamConnectors.connectorId })
        .from(teamConnectors)
        .where(eq(teamConnectors.teamId, teamId)),
    );
    for (const e of enabled) visible.add(e.id);
  }
  return drifted.filter((d) => visible.has(d.connectorId));
}
