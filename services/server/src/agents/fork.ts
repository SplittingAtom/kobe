import type { AgentDefinition } from "@kobe/agent-file";
import { and, eq, siteAgents, withTeam, type KobeDb } from "@kobe/db";
import type { ForkVia } from "./access.js";
import { siteEntry, teamEntry } from "./roster.js";
import { findAgent, SITE, toRecord, type AgentLocation, type AgentRecord } from "./store.js";
import { getVersion } from "./versions.js";

/**
 * Where a fork copies from (KOBE-568, agents-roster AR8, §5, §6.7). The source is anything the
 * caller sees from the active team: the team's own agent, their own personal agent, a gallery
 * agent, or someone else's personal agent while it holds an assigned entry on the active team's
 * roster or on the site roster. Anything else is not found (no oracle).
 */

export interface ForkSource {
  readonly agent: AgentRecord;
  readonly location: AgentLocation;
  readonly via: ForkVia;
  /** `site_agents.bound_team_id` of a personal source; null otherwise. */
  readonly boundTeamId: string | null;
}

/** An entry that lends the agent to its roster: assigned (active, or suspended site-wide). */
const lends = (state: string | undefined) => state === "active" || state === "suspended";

async function boundTeamOf(db: KobeDb, agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ boundTeamId: siteAgents.boundTeamId })
    .from(siteAgents)
    .where(and(eq(siteAgents.id, agentId), eq(siteAgents.scope, "personal")));
  return row?.boundTeamId ?? null;
}

export async function findForkSource(
  db: KobeDb,
  caller: { readonly teamId: string; readonly userId: string },
  agentId: string,
): Promise<ForkSource | null> {
  const teamLocation: AgentLocation = { scope: "team", teamId: caller.teamId };
  const owned = await findAgent(db, teamLocation, agentId);
  if (owned) return { agent: owned, location: teamLocation, via: "team_owned", boundTeamId: null };
  const ownLocation: AgentLocation = { scope: "personal", ownerUserId: caller.userId };
  const own = await findAgent(db, ownLocation, agentId);
  if (own) {
    const boundTeamId = await boundTeamOf(db, agentId);
    return { agent: own, location: ownLocation, via: "own", boundTeamId };
  }
  const gallery = await findAgent(db, { scope: "gallery" }, agentId);
  if (gallery) {
    return { agent: gallery, location: { scope: "gallery" }, via: "gallery", boundTeamId: null };
  }
  return lentPersonalAgent(db, caller.teamId, agentId);
}

/** Someone else's personal agent lent to the site roster (unbound fork) or the team's (bound). */
async function lentPersonalAgent(
  db: KobeDb,
  teamId: string,
  agentId: string,
): Promise<ForkSource | null> {
  const [row] = await db
    .select({ ...SITE, boundTeamId: siteAgents.boundTeamId })
    .from(siteAgents)
    .where(and(eq(siteAgents.id, agentId), eq(siteAgents.scope, "personal")));
  if (!row?.ownerUserId) return null;
  const { boundTeamId, ...agentRow } = row;
  const agent = toRecord("personal", agentRow);
  const location: AgentLocation = { scope: "personal", ownerUserId: row.ownerUserId };
  if (lends((await siteEntry(db, agentId))?.state)) {
    return { agent, location, via: "site_entry", boundTeamId };
  }
  const entry = await withTeam(db, teamId, (tx) => teamEntry(tx, teamId, agentId));
  if (lends(entry?.state)) return { agent, location, via: "team_entry", boundTeamId };
  return null;
}

/**
 * What the fork copies (AR8): the source's published version, or its draft when nothing is
 * published and the caller may read the draft (their own agent, the team's own agent, a gallery
 * agent). Someone else's never-published agent has nothing to copy: null.
 */
export async function forkDefinition(
  db: KobeDb,
  source: ForkSource,
): Promise<{ definition: AgentDefinition; version: number | null } | null> {
  const { agent } = source;
  if (agent.currentVersion !== null) {
    const published = await getVersion(db, source.location, agent.id, agent.currentVersion);
    if (published) return { definition: published.definition, version: published.version };
  }
  if (source.via === "team_entry" || source.via === "site_entry") return null;
  return { definition: { frontmatter: agent.frontmatter, prompt: agent.prompt }, version: null };
}
