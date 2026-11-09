import { Hono } from "hono";
import {
  setTeamDefaultAgentRequestSchema,
  TEAM_DEFAULT_AGENT_ERROR_STATUS,
  type TeamDefaultAgentErrorCode,
} from "@kobe/protocol";
import type { Context } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { setTeamDefaultAgent, teamDefaultAgent } from "../agents/team-default.js";
import { parseBody } from "../teams/http.js";

const MESSAGES: Readonly<Record<TeamDefaultAgentErrorCode, string>> = {
  invalid_request: "Send agentId: an agent's id, or null for the site default.",
  forbidden: "Only team admins choose the team's default agent.",
  agent_not_eligible:
    "Choose an agent on the team's roster that is published and active here (Team or Site tab).",
};

const error = (c: Context, code: TeamDefaultAgentErrorCode) =>
  c.json({ code, message: MESSAGES[code] }, TEAM_DEFAULT_AGENT_ERROR_STATUS[code]);

/**
 * The team's default agent for new threads (`/v1/team/default-agent`, KOBE-571, agents-roster
 * §7.7): every member reads it with the roster's choices; team admins (`team.agents.manage`, who
 * curate the team roster) change it, audited as `team.default_agent_changed`.
 */
export function teamDefaultAgentRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json(await teamDefaultAgent(db, c.get("team").id)),
  );

  app.put("/", requireTeamPermission("team.agents.manage"), async (c) => {
    const body = await parseBody(c, setTeamDefaultAgentRequestSchema);
    if (!body) return error(c, "invalid_request");
    const result = await setTeamDefaultAgent(db, c.get("team").id, body.agentId);
    if (!result.ok) return error(c, result.error);
    return c.json(result.value);
  });

  return app;
}
