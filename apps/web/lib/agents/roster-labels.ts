/**
 * What an Agents page row says (KOBE-569, spec agents-roster AR1, AR2, §6.5, §6.6): its status,
 * the version in effect, where an own agent reaches, and where Edit leads. Pure, so each rule has
 * a unit test; the rights themselves come from the server (`row.actions`).
 */
import type {
  AgentLineage,
  AgentReach,
  AgentRosterRow,
  AgentRosterTab,
  AgentRosterUnavailableReason,
} from "@kobe/protocol";
import { agentPageHref } from "./redirects";

const UNAVAILABLE_REASONS: Readonly<Record<AgentRosterUnavailableReason, string>> = {
  owner_left: "its owner left the team",
  owner_deactivated: "its owner was deactivated",
};

/** The row's status for its tab (AR1); a draft reads "Draft" on Personal. */
export function rosterStatusLabel(row: AgentRosterRow, tab: AgentRosterTab): string {
  switch (row.status) {
    case "active":
      return "Active";
    case "proposed":
      return "Proposed";
    case "not_published":
      return tab === "personal" ? "Draft" : "Not published yet";
    case "suspended_here":
      return "Suspended here";
    case "suspended_site":
      return "Suspended site-wide";
    case "archived":
      return "Archived";
    case "unavailable": {
      const reason = row.unavailableReason ? UNAVAILABLE_REASONS[row.unavailableReason] : undefined;
      return reason ? `Unavailable: ${reason}` : "Unavailable";
    }
  }
}

/** "Update available: vN" for a pinned entry behind the agent's latest version (AR5). */
export function updateAvailableLabel(row: AgentRosterRow): string | null {
  return row.updateAvailable && row.currentVersion !== null
    ? `Update available: v${row.currentVersion}`
    : null;
}

/** The version this roster runs: `vN`, "Draft" for an own unpublished agent, else "Not published yet". */
export function versionInEffectLabel(row: AgentRosterRow, viewerId: string): string {
  if (row.versionInEffect !== null) return `v${row.versionInEffect}`;
  return row.kind === "personal" && row.ownerUserId === viewerId ? "Draft" : "Not published yet";
}

/** A pinned entry's rule, for admins: "Pinned to v3"; null when it follows the latest. */
export function pinLabel(row: AgentRosterRow): string | null {
  const entry = row.entry;
  return entry?.versionRule === "pinned" && entry.pinnedVersion !== null
    ? `Pinned to v${entry.pinnedVersion}`
    : null;
}

export interface ReachItem {
  readonly key: string;
  readonly label: string;
  /** A team roster other than the active team's that the owner may still withdraw from. */
  readonly withdrawFrom: { readonly teamId: string; readonly teamName: string } | null;
}

function reachTarget(r: AgentReach): string {
  return r.target === "site" ? "Site" : `Team: ${r.teamName ?? "a team"}`;
}

function reachText(r: AgentReach): string | null {
  const where = reachTarget(r);
  switch (r.state) {
    case "active":
      return where;
    case "proposed":
      return `Proposed to ${r.target === "site" ? "the site" : (r.teamName ?? "a team")}`;
    case "suspended":
      return `${where} (suspended)`;
    case "removed":
      // A decline (the server's marker, KOBE-571; older servers: a note) stays visible to the
      // owner; a withdrawn or removed entry no longer reaches anyone.
      if (r.declined === true || (r.declined === undefined && r.note)) {
        return r.note ? `Declined for ${where}: ${r.note}` : `Declined for ${where}`;
      }
      return null;
    default:
      return null;
  }
}

/**
 * The Personal tab's Reach column (AR2): Private, Team: X (assigned or bound), Site, Proposed to …
 * Entries on another team's roster carry the team to withdraw from (the owner may have left it).
 */
export function reachItems(
  row: AgentRosterRow,
  activeTeam: { id: string; name: string },
): ReachItem[] {
  const items: ReachItem[] = [];
  if (row.boundTeamId !== null) {
    const name =
      row.boundTeamId === activeTeam.id
        ? activeTeam.name
        : (row.reach?.find((r) => r.teamId === row.boundTeamId)?.teamName ?? "another team");
    items.push({ key: "bound", label: `Bound to Team: ${name}`, withdrawFrom: null });
  }
  for (const r of row.reach ?? []) {
    const label = reachText(r);
    if (label === null) continue;
    const elsewhere =
      r.target === "team" &&
      r.teamId !== null &&
      r.teamId !== activeTeam.id &&
      r.state !== "removed";
    items.push({
      key: `${r.target}:${r.teamId ?? "site"}`,
      label,
      withdrawFrom:
        elsewhere && r.teamId !== null
          ? { teamId: r.teamId, teamName: r.teamName ?? "a team" }
          : null,
    });
  }
  return items.length === 0 ? [{ key: "private", label: "Private", withdrawFrom: null }] : items;
}

/**
 * Where Edit leads (AR14): the own agent's editor, the Team console's builder for a team-owned
 * agent, the Site console's gallery editor for a gallery agent.
 */
export function editHref(row: AgentRosterRow): string {
  const id = encodeURIComponent(row.agentId);
  if (row.kind === "team_owned") return `/admin/team/agents/${id}`;
  if (row.kind === "gallery") return `/admin/site/gallery/${id}`;
  return agentPageHref(row.agentId);
}

/** The name of a team a row's agent is bound to: the active team's, its Reach's, or none. */
function boundTeamName(
  row: AgentRosterRow,
  teamId: string,
  activeTeam: { id: string; name: string },
): string {
  if (teamId === activeTeam.id) return activeTeam.name;
  return row.reach?.find((r) => r.teamId === teamId)?.teamName ?? "another team";
}

/**
 * The fork dialog's binding notice (AR8, §6.7): "Bound to Team X: usable only there" when the
 * server says a fork from this row is bound (`forkBoundTeamId`); null for an unbound copy.
 */
export function forkBindingNotice(
  row: AgentRosterRow,
  activeTeam: { id: string; name: string },
): string | null {
  const teamId = row.forkBoundTeamId ?? null;
  if (teamId === null) return null;
  return `Bound to Team ${boundTeamName(row, teamId, activeTeam)}: usable only there.`;
}

/** "Forked from <name> vN" (§6.7); the source stays unnamed when the viewer can't read it. */
export function forkedFromLabel(lineage: AgentLineage): string {
  const name = lineage.name ?? "an agent you can't see";
  return lineage.version === null
    ? `Forked from ${name}`
    : `Forked from ${name} v${lineage.version}`;
}

/** Where the lineage's source opens (read-only for non-owners), or null when it can't be read. */
export function lineageHref(lineage: AgentLineage): string | null {
  if (lineage.kind === null) return null;
  return agentPageHref(lineage.agentId);
}

/**
 * Where a row's version opens (§6.6): the version history, read-only, in the owner's editor for
 * the owner (Edit) and in the View for anyone else who may read the definition; null otherwise.
 */
export function versionHistoryHref(row: AgentRosterRow): string | null {
  if (row.versionInEffect === null && row.currentVersion === null) return null;
  if (row.actions.edit) return `${editHref(row)}#history-title`;
  if (row.actions.viewDefinition) return `${agentPageHref(row.agentId)}#history-title`;
  return null;
}
