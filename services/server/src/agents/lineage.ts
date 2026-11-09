import type { KobeDb } from "@kobe/db";
import type { AgentLineage, AgentRosterKind } from "@kobe/protocol";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ForkVia, RosterActor } from "./access.js";
import { findForkSource, forkDefinition } from "./fork.js";

/**
 * "Forked from <name> vN" on the Personal tab (KOBE-571, agents-roster §6.7, §7.5): the source of
 * each fork, named and linkable only when the viewer may read its definition from the active team
 * (the fork route's sources and §5's "View definition": `build` for team content, `use` for site
 * and gallery agents, the owner for their own). Anything else stays anonymous (no name, no kind),
 * so a fork of another team's agent never reveals it. Bounded by the personal agent cap.
 */

const KIND: Readonly<Record<ForkVia, AgentRosterKind>> = {
  own: "personal",
  team_owned: "team_owned",
  team_entry: "personal",
  site_entry: "personal",
  gallery: "gallery",
};

function readsDefinition(actor: RosterActor, via: ForkVia): boolean {
  if (via === "own") return true;
  if (via === "team_owned" || via === "team_entry") {
    return teamRoleAllows(actor.role, "team.agents.build");
  }
  return teamRoleAllows(actor.role, "team.agents.use");
}

/** The lineage of one source as the viewer may see it. */
async function lineageOne(
  db: KobeDb,
  actor: RosterActor,
  sourceId: string,
  version: number | null,
): Promise<AgentLineage> {
  const anonymous: AgentLineage = { agentId: sourceId, version, name: null, kind: null };
  const source = await findForkSource(db, { teamId: actor.teamId, userId: actor.userId }, sourceId);
  if (!source || !readsDefinition(actor, source.via)) return anonymous;
  const lent = source.via === "team_entry" || source.via === "site_entry";
  // Someone else's agent is named by its published version, never by the owner's draft.
  const name = lent
    ? ((await forkDefinition(db, source))?.definition.frontmatter.name ?? source.agent.slug)
    : source.agent.frontmatter.name;
  return { agentId: sourceId, version, name, kind: KIND[source.via] };
}

/** Lineage per fork (agent id → lineage) for the given own agents. */
export async function lineageOf(
  db: KobeDb,
  actor: RosterActor,
  agents: readonly {
    readonly id: string;
    readonly forkedFromAgentId: string | null;
    readonly forkedFromVersion: number | null;
  }[],
): Promise<ReadonlyMap<string, AgentLineage>> {
  const out = new Map<string, AgentLineage>();
  for (const a of agents) {
    if (a.forkedFromAgentId === null) continue;
    out.set(a.id, await lineageOne(db, actor, a.forkedFromAgentId, a.forkedFromVersion));
  }
  return out;
}
