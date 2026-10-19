import {
  decideEgress,
  loadEgressCeiling,
  loadTeamEgress,
  normalizeHost,
  type KobeDb,
} from "@kobe/db";

/**
 * Whether each host a skill asks for is reachable from a team's sandboxes, decided exactly as the
 * egress proxy decides (`decideEgress` and the same loaders, @kobe/db): wildcard patterns
 * included (`*.pythonhosted.org` covers `files.pythonhosted.org`). For the catalog's egress check
 * (KOBE-336, D28) and the review console's capabilities (KOBE-334). `teamId` null: the Site
 * ceiling only.
 */
export interface HostStanding {
  readonly host: string;
  /** A ceiling pattern covers it: a member may request it (D28); otherwise only a Site admin. */
  readonly inCeiling: boolean;
  /** The team enabled a pattern that covers it, and the ceiling still holds that pattern. */
  readonly enabledHere: boolean;
}

export async function hostStandings(
  db: KobeDb,
  teamId: string | null,
  hosts: readonly string[],
): Promise<HostStanding[]> {
  if (hosts.length === 0) return [];
  const ceiling = new Set(await loadEgressCeiling(db));
  const team = new Set(teamId ? await loadTeamEgress(db, teamId) : []);
  return hosts.map((host) => {
    const canonical = normalizeHost(host);
    if (canonical === null) return { host, inCeiling: false, enabledHere: false };
    const d = decideEgress(ceiling, team, canonical);
    return { host, inCeiling: d.allowed || d.reason === "not_enabled", enabledHere: d.allowed };
  });
}
