import {
  and,
  asc,
  connectors,
  eq,
  isNull,
  teamConnectors,
  teams,
  withTeam,
  type ConnectorExposureKind,
  type KobeDb,
} from "@kobe/db";

/** One team that has a connector enabled, as the site connector detail panel shows it (KOBE-641). */
export interface ConnectorTeamUse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly exposure: ConnectorExposureKind;
  /** How many tools a `custom` exposure ticks (0 otherwise); never which credentials exist. */
  readonly enabled_tools: number;
}

/**
 * The teams that have the connector enabled, with their exposure, ordered by team name; undefined
 * when the connector is unknown or removed. `team_connectors` is a team table, so this walks the
 * teams one `withTeam` at a time (as `countTeamsUsing`): RLS never lets one query see them all.
 */
export async function listTeamsUsing(
  db: KobeDb,
  connectorId: string,
): Promise<ConnectorTeamUse[] | undefined> {
  const [found] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)));
  if (!found) return undefined;
  const all = await db
    .select({ id: teams.id, name: teams.name, slug: teams.slug })
    .from(teams)
    .orderBy(asc(teams.name), asc(teams.slug));
  const used: ConnectorTeamUse[] = [];
  for (const team of all) {
    const [row] = await withTeam(db, team.id, (tx) =>
      tx
        .select({ exposure: teamConnectors.exposure, enabledTools: teamConnectors.enabledTools })
        .from(teamConnectors)
        .where(
          and(eq(teamConnectors.teamId, team.id), eq(teamConnectors.connectorId, connectorId)),
        ),
    );
    if (row) {
      used.push({
        ...team,
        exposure: row.exposure,
        enabled_tools: row.exposure === "custom" ? row.enabledTools.length : 0,
      });
    }
  }
  return used;
}
