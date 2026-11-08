import type { AgentFrontmatter } from "@kobe/agent-file";
import { and, eq, ne, siteAgents, withTeam, type KobeDb } from "@kobe/db";
import { teamRoleAllows } from "../authz/permissions.js";
import type { AgentAccess, AgentActor } from "./access.js";
import { resolvedVersion, siteEntry, teamEntry, type RosterEntryRecord } from "./roster.js";
import { versionContent } from "./roster-resolution.js";
import { SITE, toRecord, type AgentLocation, type AgentRecord } from "./store.js";

/**
 * View from a roster (KOBE-571, agents-roster AR14, §5 "View definition"): someone else's personal
 * agent read-only, for whoever may read its definition from the active team: `use` while it holds
 * an assigned entry on the site roster, `build` while it holds one on the active team's roster.
 * The definition shown is the roster's **version in effect**, never the owner's draft; its
 * published versions (history) read through the same check. Bound to another team, or on no
 * roster the caller reads: null (404, no oracle). Team reads run in `withTeam()` with `team_id`
 * explicit.
 */

/** Read-only: definition and versions, nothing else (AR4: only the owner edits). */
export const ROSTER_READ_ACCESS: AgentAccess = {
  see: true,
  readDefinition: true,
  edit: false,
  publish: false,
  setStatus: false,
};

export interface RosterRead {
  /** The agent with the version in effect as its definition; `currentVersion` is the latest. */
  readonly agent: AgentRecord;
  readonly location: AgentLocation;
  readonly versionInEffect: number;
}

/** An entry that lends the agent: assigned (active, or suspended site-wide). */
const lends = (e: RosterEntryRecord | null): e is RosterEntryRecord =>
  e !== null && (e.state === "active" || e.state === "suspended");

export async function rosterDefinitionRead(
  db: KobeDb,
  caller: AgentActor & { readonly teamId: string },
  agentId: string,
): Promise<RosterRead | null> {
  const { teamId } = caller;
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .select({ ...SITE, boundTeamId: siteAgents.boundTeamId })
      .from(siteAgents)
      .where(
        and(
          eq(siteAgents.id, agentId),
          eq(siteAgents.scope, "personal"),
          ne(siteAgents.ownerUserId, caller.userId),
        ),
      );
    if (!row?.ownerUserId) return null;
    const { boundTeamId, ...agentRow } = row;
    if (boundTeamId !== null && boundTeamId !== teamId) return null;
    const site = boundTeamId === null ? await siteEntry(tx, agentId) : null;
    const team = await teamEntry(tx, teamId, agentId);
    const entry =
      lends(site) && teamRoleAllows(caller.role, "team.agents.use")
        ? site
        : lends(team) && teamRoleAllows(caller.role, "team.agents.build")
          ? team
          : null;
    if (!entry) return null;
    const version = resolvedVersion(entry, agentRow.currentVersion);
    if (version === null) return null; // never published: nothing to read (AR4)
    const content = (await versionContent(tx, [[agentId, version]])).get(agentId);
    if (!content) return null;
    const base = toRecord("personal", agentRow);
    return {
      agent: {
        ...base,
        frontmatter: content.frontmatter as AgentFrontmatter,
        prompt: content.prompt,
      },
      location: { scope: "personal", ownerUserId: row.ownerUserId },
      versionInEffect: version,
    };
  });
}
