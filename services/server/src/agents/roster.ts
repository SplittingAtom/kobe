import {
  and,
  eq,
  inArray,
  ne,
  scanTeams,
  siteAgentRoster,
  teamAgentRoster,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { AgentReach, AgentRosterEntry } from "@kobe/protocol";
import type { RosterEntryState, RosterTarget } from "./access.js";

/**
 * Agent roster reads (KOBE-566, spec agents-roster AR3, AR5, §6.2): entries are references to a
 * personal agent with a version rule, ids and timestamps only. Team entries live in the RLS table
 * `team_agent_roster`: every query here runs inside `withTeam()` (or `scanTeams`) and still states
 * `team_id` explicitly. Site entries are site-wide. KOBE-567 resolves runnable agents and pins
 * through {@link activeTeamEntries}, {@link activeSiteEntries} and {@link resolvedVersion}.
 */

export interface RosterEntryRecord {
  readonly agentId: string;
  readonly target: RosterTarget;
  readonly teamId: string | null;
  readonly state: RosterEntryState;
  readonly versionRule: "latest" | "pinned";
  readonly pinnedVersion: number | null;
  readonly assignedBy: string;
  readonly assignedAt: Date;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly note: string | null;
  readonly removedAt: Date | null;
}

const ENTRY = {
  agentId: siteAgentRoster.siteAgentId,
  state: siteAgentRoster.state,
  versionRule: siteAgentRoster.versionRule,
  pinnedVersion: siteAgentRoster.pinnedVersion,
  assignedBy: siteAgentRoster.assignedBy,
  assignedAt: siteAgentRoster.assignedAt,
  decidedBy: siteAgentRoster.decidedBy,
  decidedAt: siteAgentRoster.decidedAt,
  note: siteAgentRoster.note,
  removedAt: siteAgentRoster.removedAt,
};
const TEAM_ENTRY = {
  teamId: teamAgentRoster.teamId,
  agentId: teamAgentRoster.siteAgentId,
  state: teamAgentRoster.state,
  versionRule: teamAgentRoster.versionRule,
  pinnedVersion: teamAgentRoster.pinnedVersion,
  assignedBy: teamAgentRoster.assignedBy,
  assignedAt: teamAgentRoster.assignedAt,
  decidedBy: teamAgentRoster.decidedBy,
  decidedAt: teamAgentRoster.decidedAt,
  note: teamAgentRoster.note,
  removedAt: teamAgentRoster.removedAt,
};

type SiteRow = Omit<RosterEntryRecord, "target" | "teamId">;
type TeamRow = Omit<RosterEntryRecord, "target">;

const fromSite = (r: SiteRow): RosterEntryRecord => ({ ...r, target: "site", teamId: null });
const fromTeam = (r: TeamRow): RosterEntryRecord => ({ ...r, target: "team" });

/**
 * The version a roster entry runs (AR5): the agent's latest published version for `latest`, the
 * pin otherwise. Null when the agent was never published (a draft is assignable, not runnable).
 */
export function resolvedVersion(
  entry: Pick<RosterEntryRecord, "versionRule" | "pinnedVersion">,
  currentVersion: number | null,
): number | null {
  if (entry.versionRule === "pinned" && entry.pinnedVersion !== null) return entry.pinnedVersion;
  return currentVersion;
}

/** A pinned entry behind the agent's latest published version ("Update available"). */
export const updateAvailable = (
  entry: Pick<RosterEntryRecord, "versionRule" | "pinnedVersion">,
  currentVersion: number | null,
): boolean =>
  entry.versionRule === "pinned" &&
  entry.pinnedVersion !== null &&
  currentVersion !== null &&
  currentVersion > entry.pinnedVersion;

/** Every entry of a team's roster (any state). Call inside `withTeam(db, teamId)`. */
export async function teamEntries(tx: KobeTx, teamId: string): Promise<RosterEntryRecord[]> {
  const rows = await tx
    .select(TEAM_ENTRY)
    .from(teamAgentRoster)
    .where(eq(teamAgentRoster.teamId, teamId));
  return rows.map(fromTeam);
}

/** The team roster's active entries (what the team runs besides its own agents and the site). */
export async function activeTeamEntries(tx: KobeTx, teamId: string): Promise<RosterEntryRecord[]> {
  const rows = await tx
    .select(TEAM_ENTRY)
    .from(teamAgentRoster)
    .where(and(eq(teamAgentRoster.teamId, teamId), eq(teamAgentRoster.state, "active")));
  return rows.map(fromTeam);
}

/** One agent's entry on a team roster, any state. Call inside `withTeam(db, teamId)`. */
export async function teamEntry(
  tx: KobeTx,
  teamId: string,
  agentId: string,
  lock = false,
): Promise<RosterEntryRecord | null> {
  const query = tx
    .select(TEAM_ENTRY)
    .from(teamAgentRoster)
    .where(and(eq(teamAgentRoster.teamId, teamId), eq(teamAgentRoster.siteAgentId, agentId)));
  const [row] = lock ? await query.for("update") : await query;
  return row ? fromTeam(row) : null;
}

/** Every entry of the site roster (any state). */
export async function siteEntries(db: KobeDb | KobeTx): Promise<RosterEntryRecord[]> {
  return (await db.select(ENTRY).from(siteAgentRoster)).map(fromSite);
}

/** The site roster's active entries: run by every team (minus a team's own suspensions). */
export async function activeSiteEntries(db: KobeDb | KobeTx): Promise<RosterEntryRecord[]> {
  const rows = await db
    .select(ENTRY)
    .from(siteAgentRoster)
    .where(eq(siteAgentRoster.state, "active"));
  return rows.map(fromSite);
}

export async function siteEntry(
  db: KobeDb | KobeTx,
  agentId: string,
  lock = false,
): Promise<RosterEntryRecord | null> {
  const query = db
    .select(ENTRY)
    .from(siteAgentRoster)
    .where(eq(siteAgentRoster.siteAgentId, agentId));
  const [row] = lock ? await query.for("update") : await query;
  return row ? fromSite(row) : null;
}

/**
 * True while the agent holds a place on any roster (proposed, active or suspended), which refuses
 * its deletion (409 `agent_rostered`, §6.3). Scans every team: entries outlive the owner's
 * membership. Must not run inside a team transaction.
 */
export async function isRostered(db: KobeDb, agentId: string): Promise<boolean> {
  const site = await db
    .select({ id: siteAgentRoster.siteAgentId })
    .from(siteAgentRoster)
    .where(and(eq(siteAgentRoster.siteAgentId, agentId), ne(siteAgentRoster.state, "removed")))
    .limit(1);
  if (site.length > 0) return true;
  const teams = await scanTeams(db, "isRostered", async (tx, team) => {
    const [row] = await tx
      .select({ id: teamAgentRoster.siteAgentId })
      .from(teamAgentRoster)
      .where(
        and(
          eq(teamAgentRoster.teamId, team.id),
          eq(teamAgentRoster.siteAgentId, agentId),
          ne(teamAgentRoster.state, "removed"),
        ),
      )
      .limit(1);
    return row ? true : undefined;
  });
  return teams.length > 0;
}

/** Thrown by {@link refuseIfRostered}: the route answers 409 `agent_rostered`. */
export class AgentRosteredError extends Error {
  constructor(agentId: string) {
    super(`agent ${agentId} is on a roster`);
    this.name = "AgentRosteredError";
  }
}

/**
 * `deleteOrArchiveAgent`'s guard (§6.3), run under the agent's `FOR UPDATE` lock: roster writes
 * lock the agent `FOR SHARE`, so an assignment either committed before this check or waits and
 * then finds no agent.
 */
export async function refuseIfRostered(db: KobeDb, agentId: string): Promise<void> {
  if (await isRostered(db, agentId)) throw new AgentRosteredError(agentId);
}

/**
 * Where the owner's agents reach (the Personal tab's Reach column, AR2): their entries on every
 * team's roster and on the site roster, any state (a removed entry carries a decline's note).
 */
/**
 * A removed entry an admin declined as a proposal (KOBE-571): only a decline leaves `removedAt`
 * null with a decision recorded; removals, withdrawals and adopts write `removedAt`. Entries
 * declined before KOBE-571 carry `removedAt` and can't be told from a removal: not declined.
 */
export function isDeclined(e: {
  readonly state: string;
  readonly decidedAt: Date | null;
  readonly removedAt: Date | null;
}): boolean {
  return e.state === "removed" && e.decidedAt !== null && e.removedAt === null;
}

export async function reachOf(
  db: KobeDb,
  agentIds: readonly string[],
): Promise<ReadonlyMap<string, readonly AgentReach[]>> {
  const reach = new Map<string, AgentReach[]>();
  if (agentIds.length === 0) return reach;
  const add = (agentId: string, item: AgentReach) =>
    reach.set(agentId, [...(reach.get(agentId) ?? []), item]);
  const perTeam = await scanTeams(db, "reachOf", async (tx, team) => {
    const rows = await tx
      .select({
        agentId: teamAgentRoster.siteAgentId,
        state: teamAgentRoster.state,
        note: teamAgentRoster.note,
        decidedAt: teamAgentRoster.decidedAt,
        removedAt: teamAgentRoster.removedAt,
      })
      .from(teamAgentRoster)
      .where(
        and(
          eq(teamAgentRoster.teamId, team.id),
          inArray(teamAgentRoster.siteAgentId, [...agentIds]),
        ),
      );
    return rows.length > 0 ? { team, rows } : undefined;
  });
  for (const { team, rows } of perTeam) {
    for (const r of rows) {
      add(r.agentId, {
        target: "team",
        teamId: team.id,
        teamName: team.name,
        state: r.state,
        note: r.note,
        declined: isDeclined(r),
      });
    }
  }
  const site = await db
    .select({
      agentId: siteAgentRoster.siteAgentId,
      state: siteAgentRoster.state,
      note: siteAgentRoster.note,
      decidedAt: siteAgentRoster.decidedAt,
      removedAt: siteAgentRoster.removedAt,
    })
    .from(siteAgentRoster)
    .where(inArray(siteAgentRoster.siteAgentId, [...agentIds]));
  for (const r of site) {
    add(r.agentId, {
      target: "site",
      teamId: null,
      teamName: null,
      state: r.state,
      note: r.note,
      declined: isDeclined(r),
    });
  }
  return reach;
}

/** An entry on the wire (`@kobe/protocol` `AgentRosterEntry`). */
export function entryView(e: RosterEntryRecord): AgentRosterEntry {
  return {
    agentId: e.agentId,
    target: e.target,
    teamId: e.teamId,
    state: e.state,
    versionRule: e.versionRule,
    pinnedVersion: e.pinnedVersion,
    assignedBy: e.assignedBy,
    assignedAt: e.assignedAt.toISOString(),
    decidedBy: e.decidedBy,
    decidedAt: e.decidedAt?.toISOString() ?? null,
    note: e.note,
    removedAt: e.removedAt?.toISOString() ?? null,
  };
}
