import type { AgentFrontmatter } from "@kobe/agent-file";
import {
  and,
  eq,
  inArray,
  ne,
  or,
  siteAgents,
  siteAgentVersions,
  sql,
  teamAgentSuspensions,
  type KobeTx,
} from "@kobe/db";
import type { AgentRosterUnavailableReason } from "@kobe/protocol";
import {
  activeTeamEntries,
  resolvedVersion,
  siteEntries,
  siteEntry,
  teamEntry,
  type RosterEntryRecord,
} from "./roster.js";
import { SITE, toRecord, type AgentRecord } from "./store.js";

/**
 * Roster-driven resolution (KOBE-567, spec agents-roster AR5, AR9, AR10, §6.2): which members'
 * personal agents a team runs besides its own agents, the gallery and the caller's own agents.
 * A personal agent is *lent* to team T by an active entry on T's roster or a live (active or
 * site-wide suspended) entry on the site roster. The team runs it at the entry's resolved version
 * (latest or the pin), only while the owner is eligible: still a member of T for a team entry,
 * not deactivated for either (else Unavailable). A bound agent (AR8) is lent only in its team.
 * `team_agent_suspensions` and a site-wide suspension make it suspended here. Every team read
 * runs inside the caller's `withTeam()` and states `team_id`.
 */

/** Why an entry is Unavailable (AR10): shown to the roster's admins. */
export type UnavailableReason = AgentRosterUnavailableReason;

export interface OwnerState {
  /** Still a member of the team being resolved for. */
  readonly member: boolean;
  readonly deactivated: boolean;
}

/** Whether the owner keeps an entry available (AR10): null when they do. */
export function entryUnavailable(
  entry: Pick<RosterEntryRecord, "target">,
  owner: OwnerState,
): UnavailableReason | null {
  if (owner.deactivated) return "owner_deactivated";
  if (entry.target === "team" && !owner.member) return "owner_left";
  return null;
}

/** The entry through which a team runs a lent agent, and what stops it there. */
export interface Lending {
  readonly entry: RosterEntryRecord;
  readonly unavailable: UnavailableReason | null;
  /** The site entry it runs through is suspended site-wide (§6.5). */
  readonly suspendedSiteWide: boolean;
}

/**
 * How team `teamId` gets an agent from its entries (pure): an eligible active team entry first,
 * then an eligible site entry (active, else suspended site-wide). With entries but no eligible
 * owner the first live entry is returned Unavailable. Null: not lent to this team at all (no live
 * entry, or bound to another team; a bound agent's site entry is ignored).
 */
export function lendingIn(
  teamId: string,
  agent: { readonly boundTeamId: string | null },
  team: RosterEntryRecord | null,
  site: RosterEntryRecord | null,
  owner: OwnerState,
): Lending | null {
  if (agent.boundTeamId !== null && agent.boundTeamId !== teamId) return null;
  const live = [
    team?.target === "team" && team.state === "active" ? team : null,
    agent.boundTeamId === null && (site?.state === "active" || site?.state === "suspended")
      ? site
      : null,
  ].filter((e): e is RosterEntryRecord => e !== null);
  const [first] = live;
  if (!first) return null;
  const eligible = live.filter((e) => entryUnavailable(e, owner) === null);
  const pick = eligible.find((e) => e.state === "active") ?? eligible[0];
  if (pick)
    return { entry: pick, unavailable: null, suspendedSiteWide: pick.state === "suspended" };
  return { entry: first, unavailable: entryUnavailable(first, owner), suspendedSiteWide: false };
}

/**
 * Someone else's personal agent as the caller's team sees it: `currentVersion` is the version in
 * effect (null when Unavailable or never published, so it can't start threads), `status` the
 * effective one here, and `frontmatter`/`prompt` those of that version, never the owner's draft.
 */
export interface LentAgent {
  readonly record: AgentRecord;
  readonly lending: Lending;
}

/** True for a personal agent of someone else: it reaches the viewer only through a roster. */
export const isLentAgent = (agent: AgentRecord, viewer: { readonly userId: string }): boolean =>
  agent.scope === "personal" && agent.ownerUserId !== viewer.userId;

/** Site-wide agents bound to another team (AR8) are never visible from `teamId`. */
export const notBoundElsewhere = (teamId: string) =>
  sql`(${siteAgents.boundTeamId} IS NULL OR ${siteAgents.boundTeamId} = ${teamId}::uuid)`;

/** Membership in `teamId` and deactivation of the given owners. Inside `withTeam(teamId)`. */
export async function ownerStates(
  tx: KobeTx,
  teamId: string,
  ownerIds: readonly string[],
): Promise<ReadonlyMap<string, OwnerState>> {
  const unique = [...new Set(ownerIds)];
  if (unique.length === 0) return new Map();
  const res = await tx.execute<{ id: string; deactivated: boolean; member: boolean }>(sql`
    SELECT u.id, u.deactivated_at IS NOT NULL AS deactivated,
           EXISTS (SELECT 1 FROM team_members m
                    WHERE m.team_id = ${teamId} AND m.user_id = u.id) AS member
      FROM users u
     WHERE u.id = ANY(${`{${unique.join(",")}}`}::uuid[])`);
  return new Map(res.rows.map((r) => [r.id, { member: r.member, deactivated: r.deactivated }]));
}

const GONE: OwnerState = { member: false, deactivated: true };

const live = (e: RosterEntryRecord | null): e is RosterEntryRecord =>
  e?.state === "active" || e?.state === "suspended";

/** Live site entries (active or suspended site-wide), optionally of one agent. */
async function liveSiteEntries(tx: KobeTx, agentId?: string): Promise<RosterEntryRecord[]> {
  if (agentId !== undefined) return [await siteEntry(tx, agentId)].filter(live);
  return (await siteEntries(tx)).filter(live);
}

/** The frontmatter and prompt of the given published versions, by agent id. */
async function versionContent(
  tx: KobeTx,
  pairs: readonly (readonly [string, number])[],
): Promise<ReadonlyMap<string, { frontmatter: AgentFrontmatter; prompt: string }>> {
  if (pairs.length === 0) return new Map();
  const rows = await tx
    .select({
      agentId: siteAgentVersions.agentId,
      frontmatter: siteAgentVersions.frontmatter,
      prompt: siteAgentVersions.prompt,
    })
    .from(siteAgentVersions)
    .where(
      or(
        ...pairs.map(([id, v]) =>
          and(eq(siteAgentVersions.agentId, id), eq(siteAgentVersions.version, v)),
        ),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.agentId,
      { frontmatter: r.frontmatter as AgentFrontmatter, prompt: r.prompt },
    ]),
  );
}

/**
 * The personal agents of other members lent to the viewer's team (§6.2), or the one `agentId`.
 * `lock` takes `FOR SHARE` on the agent rows (as `findPinnableAgent` does). Entries of deleted
 * agents are inert. Call inside `withTeam(db, viewer.teamId)`.
 */
export async function lentAgents(
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
  options: { readonly agentId?: string; readonly lock?: boolean } = {},
): Promise<LentAgent[]> {
  const { teamId } = viewer;
  const { agentId } = options;
  const team =
    agentId === undefined
      ? await activeTeamEntries(tx, teamId)
      : [await teamEntry(tx, teamId, agentId)].filter(
          (e): e is RosterEntryRecord => e?.state === "active",
        );
  const site = await liveSiteEntries(tx, agentId);
  const ids = [...new Set([...team, ...site].map((e) => e.agentId))];
  if (ids.length === 0) return [];
  const query = tx
    .select({ ...SITE, boundTeamId: siteAgents.boundTeamId })
    .from(siteAgents)
    .where(
      and(
        inArray(siteAgents.id, ids),
        eq(siteAgents.scope, "personal"),
        ne(siteAgents.ownerUserId, viewer.userId),
      ),
    );
  const agents = await (options.lock ? query.for("share") : query);
  if (agents.length === 0) return [];
  const owners = await ownerStates(
    tx,
    teamId,
    agents.flatMap((a) => (a.ownerUserId ? [a.ownerUserId] : [])),
  );
  const suspended = new Set(
    (
      await tx
        .select({ id: teamAgentSuspensions.agentId })
        .from(teamAgentSuspensions)
        .where(
          and(eq(teamAgentSuspensions.teamId, teamId), inArray(teamAgentSuspensions.agentId, ids)),
        )
    ).map((r) => r.id),
  );
  const teamBy = new Map(team.map((e) => [e.agentId, e]));
  const siteBy = new Map(site.map((e) => [e.agentId, e]));
  const resolved = agents.flatMap(({ boundTeamId, ...row }) => {
    const owner = (row.ownerUserId && owners.get(row.ownerUserId)) || GONE;
    const lending = lendingIn(
      teamId,
      { boundTeamId },
      teamBy.get(row.id) ?? null,
      siteBy.get(row.id) ?? null,
      owner,
    );
    if (!lending) return [];
    return [{ row, lending, shown: resolvedVersion(lending.entry, row.currentVersion) }];
  });
  const content = await versionContent(
    tx,
    resolved.flatMap((r) => (r.shown === null ? [] : [[r.row.id, r.shown] as const])),
  );
  return resolved.map(({ row, lending, shown }) => {
    const base = toRecord("personal", row);
    const version = content.get(row.id);
    const here = suspended.has(row.id) || lending.suspendedSiteWide;
    return {
      lending,
      record: {
        ...base,
        status: here && base.status === "active" ? "suspended" : base.status,
        currentVersion: lending.unavailable === null && version ? shown : null,
        frontmatter: version?.frontmatter ?? ({ name: row.slug } as AgentFrontmatter),
        prompt: version?.prompt ?? "",
      },
    };
  });
}

/**
 * A thread's pin to someone else's personal agent whose entry has since been removed, re-pinned
 * or whose owner left (D19, AR11: threads keep running their pinned version). Only for a pin the
 * thread already holds (written by `resolveAgentPin` through the roster), of an agent that has an
 * entry, in any state, on this team's roster or the site's. Not for an agent bound
 * to another team; suspended here (`team_agent_suspensions`, or a site-wide suspension of its
 * site entry) refuses runs as for any agent. Call inside `withTeam(db, viewer.teamId)`.
 */
export async function keptLentAgent(
  tx: KobeTx,
  viewer: { readonly teamId: string; readonly userId: string },
  pin: { readonly agentScope: string; readonly agentId: string; readonly agentVersion: number },
): Promise<AgentRecord | null> {
  if (pin.agentScope !== "personal") return null;
  const [row] = await tx
    .select(SITE)
    .from(siteAgents)
    .where(
      and(
        eq(siteAgents.id, pin.agentId),
        eq(siteAgents.scope, "personal"),
        ne(siteAgents.ownerUserId, viewer.userId),
        notBoundElsewhere(viewer.teamId),
      ),
    );
  if (!row) return null;
  // Only an agent this team ran through a roster: its entry stays (removed) as history (AR7).
  const site = await siteEntry(tx, row.id);
  if (site === null && (await teamEntry(tx, viewer.teamId, row.id)) === null) return null;
  const [here] = await tx
    .select({ id: teamAgentSuspensions.agentId })
    .from(teamAgentSuspensions)
    .where(
      and(eq(teamAgentSuspensions.teamId, viewer.teamId), eq(teamAgentSuspensions.agentId, row.id)),
    );
  const siteWide = site?.state === "suspended";
  const content = (await versionContent(tx, [[row.id, pin.agentVersion]])).get(row.id);
  const base = toRecord("personal", row);
  return {
    ...base,
    status: (here || siteWide) && base.status === "active" ? "suspended" : base.status,
    frontmatter: content?.frontmatter ?? ({ name: row.slug } as AgentFrontmatter),
    prompt: content?.prompt ?? "",
  };
}
