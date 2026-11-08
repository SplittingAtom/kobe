/**
 * What an Agents page row says (KOBE-569, spec agents-roster AR1, AR2, §6.5, §6.6): its status,
 * the version in effect, where an own agent reaches, and where Edit leads. Pure, so each rule has
 * a unit test; the rights themselves come from the server (`row.actions`).
 */
import type { AgentReach, AgentRosterRow, AgentRosterTab } from "@kobe/protocol";
import { agentPageHref } from "./redirects";

/** `unavailable` and its reason arrive with KOBE-567's contract; read them defensively until then. */
type RowStatus = AgentRosterRow["status"] | "unavailable";
type RosterRow = AgentRosterRow & { readonly unavailableReason?: string | undefined };

const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  owner_left: "its owner left the team",
  owner_deactivated: "its owner was deactivated",
};

/** The row's status for its tab (AR1); a draft reads "Draft" on Personal. */
export function rosterStatusLabel(row: RosterRow, tab: AgentRosterTab): string {
  const status = row.status as RowStatus;
  switch (status) {
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
    default:
      return String(status);
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
      // Only a decline carries a note; a withdrawn or removed entry no longer reaches anyone.
      return r.note ? `Declined for ${where}: ${r.note}` : null;
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
