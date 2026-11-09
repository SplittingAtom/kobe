import {
  eq,
  siteAgents,
  sql,
  teamAgents,
  teamAgentSuspensions,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { TeamDefaultAgent, TeamDefaultAgentOption } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { lentAgents } from "./roster-resolution.js";
import { SITE, TEAM, toRecord, type AgentRecord } from "./store.js";
import { canPinAgent } from "./versions.js";

/**
 * The team's default agent for new threads (KOBE-571, agents-roster §7.7): a `teams.settings` key
 * (jsonb, no migration), chosen by a team admin from the team's roster: a team-owned agent, an
 * active team roster entry, a site roster entry or a gallery agent, published, active here and not
 * archived. `defaultNewThreadPin` (default-agent.ts) reads it and still resolves it per member, so
 * a choice that stops being runnable falls back to the site default (Kobe).
 */

/** The `teams.settings` key. */
export const TEAM_DEFAULT_AGENT_SETTING = "default_agent_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Lent agents for the team as a whole: no member's own agents are excluded. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** The chosen agent id, or null (none, or a malformed value). `teams` is a site table: by id. */
export async function readTeamDefaultAgent(
  db: KobeDb | KobeTx,
  teamId: string,
): Promise<string | null> {
  const res = await db.execute<{ id: string | null }>(sql`
    SELECT settings ->> ${TEAM_DEFAULT_AGENT_SETTING} AS id FROM teams WHERE id = ${teamId}`);
  const value = res.rows[0]?.id ?? null;
  return value !== null && UUID.test(value) ? value : null;
}

const option = (
  agent: AgentRecord,
  group: TeamDefaultAgentOption["group"],
): TeamDefaultAgentOption[] =>
  canPinAgent(agent) && agent.currentVersion !== null
    ? [
        {
          agentId: agent.id,
          name: agent.frontmatter.name,
          slug: agent.slug,
          group,
          versionInEffect: agent.currentVersion,
        },
      ]
    : [];

/** What a team admin may choose, by name. Inside `withTeam(teamId)`; `team_id` explicit. */
export async function defaultAgentOptions(
  tx: KobeTx,
  teamId: string,
): Promise<TeamDefaultAgentOption[]> {
  const suspended = new Set(
    (
      await tx
        .select({ id: teamAgentSuspensions.agentId })
        .from(teamAgentSuspensions)
        .where(eq(teamAgentSuspensions.teamId, teamId))
    ).map((r) => r.id),
  );
  const here = (a: AgentRecord): AgentRecord =>
    suspended.has(a.id) ? { ...a, status: "suspended" } : a;
  const owned = await tx.select(TEAM).from(teamAgents).where(eq(teamAgents.teamId, teamId));
  const gallery = await tx.select(SITE).from(siteAgents).where(eq(siteAgents.scope, "gallery"));
  const lent = await lentAgents(tx, { teamId, userId: NOBODY });
  return [
    ...owned.flatMap((r) => option(toRecord("team", r), "team")),
    ...lent.flatMap((l) => option(l.record, l.lending.entry.target)),
    ...gallery.flatMap((r) => option(here(toRecord("gallery", r)), "site")),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId));
}

/** The setting with the choices, for `GET /v1/team/default-agent`. */
export async function teamDefaultAgent(db: KobeDb, teamId: string): Promise<TeamDefaultAgent> {
  return withTeam(db, teamId, async (tx) => {
    const agentId = await readTeamDefaultAgent(tx, teamId);
    const options = await defaultAgentOptions(tx, teamId);
    return {
      agentId,
      unavailable: agentId !== null && !options.some((o) => o.agentId === agentId),
      options,
    };
  });
}

/**
 * Sets (or with null clears) the team's default agent: refused unless the agent is one of the
 * options now; audited `team.default_agent_changed` (ids only) when it changed.
 */
export async function setTeamDefaultAgent(
  db: KobeDb,
  teamId: string,
  agentId: string | null,
): Promise<{ ok: true; value: TeamDefaultAgent } | { ok: false; error: "agent_not_eligible" }> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM teams WHERE id = ${teamId} FOR NO KEY UPDATE`);
    const previous = await readTeamDefaultAgent(tx, teamId);
    const options = await defaultAgentOptions(tx, teamId);
    if (agentId !== null && !options.some((o) => o.agentId === agentId)) {
      return { ok: false as const, error: "agent_not_eligible" as const };
    }
    if (previous !== agentId) {
      await tx.execute(
        agentId === null
          ? sql`UPDATE teams SET settings = settings - ${TEAM_DEFAULT_AGENT_SETTING}
                 WHERE id = ${teamId} AND jsonb_typeof(settings) = 'object'`
          : sql`UPDATE teams
                   SET settings = jsonb_set(
                         CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
                         ${`{${TEAM_DEFAULT_AGENT_SETTING}}`}::text[], to_jsonb(${agentId}::text))
                 WHERE id = ${teamId}`,
      );
      await recordAudit(tx, {
        action: "team.default_agent_changed",
        teamId,
        target: { agentId, previousAgentId: previous },
      });
    }
    return { ok: true as const, value: { agentId, unavailable: false, options } };
  });
}
