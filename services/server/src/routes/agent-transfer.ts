import type { Context, Hono } from "hono";
import { transferAgentRequestSchema, type AgentRosterErrorCode } from "@kobe/protocol";
import type { RosterTarget } from "../agents/access.js";
import { entryView } from "../agents/roster.js";
import { adoptEntry, type AdoptError } from "../agents/roster-adopt.js";
import {
  acceptTransfer,
  cancelTransfer,
  listTransfers,
  requestTransfer,
} from "../agents/roster-transfer.js";
import { agentIdSchema } from "../agents/schemas.js";
import type { AuthVariables } from "../auth/session.js";
import type { TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { parseBody } from "../teams/http.js";
import { rosterError, teamActor, withinRate } from "./agent-roster.js";

/**
 * Transfer and adopt routes (KOBE-568, agents-roster AR10, AR16, §6.8). Transfers are mounted inside
 * the agent routes (`/v1/agents/transfers` before `/:id`); adopt on the team and site roster routers.
 * Every write counts against the roster write rate (`agent-roster:<userId>`).
 */

type TeamCtx = Context<{ Variables: TeamVariables }>;

/** `GET /transfers`, `POST /:id/transfer`, `POST /:id/transfer/accept`, `DELETE /:id/transfer`. */
export function mountAgentTransferRoutes(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
): void {
  const db = deps.database.db;

  app.get("/transfers", async (c) => c.json(await listTransfers(db, c.get("user").id)));

  /** The agent id from the path, then the rate budget: a Response when refused. */
  const begin = async (c: TeamCtx): Promise<string | Response> => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return rosterError(c, "agent_not_found");
    if (!(await withinRate(deps, c.get("user").id))) return rosterError(c, "rate_limited");
    return id.data;
  };

  app.post("/:id/transfer", async (c) => {
    const body = await parseBody(c, transferAgentRequestSchema);
    if (!body) return rosterError(c, "invalid_request", "Give toUserId: a member of this team.");
    const id = await begin(c);
    if (id instanceof Response) return id;
    const result = await requestTransfer(db, teamActor(c), id, body.toUserId);
    if (result.ok) return c.json({ transfer: result.value }, 201);
    return result.error === "invalid_transition"
      ? rosterError(
          c,
          result.error,
          "This agent has a pending transfer in another team. Cancel it first.",
        )
      : rosterError(c, result.error);
  });

  app.post("/:id/transfer/accept", async (c) => {
    const id = await begin(c);
    if (id instanceof Response) return id;
    const userId = c.get("user").id;
    const result = await acceptTransfer(db, userId, id);
    if (!result.ok) return rosterError(c, result.error);
    return c.json({ agentId: id, ownerUserId: userId, fromUserId: result.value.fromUserId });
  });

  app.delete("/:id/transfer", async (c) => {
    const id = await begin(c);
    if (id instanceof Response) return id;
    const result = await cancelTransfer(db, c.get("user").id, id);
    return result.ok ? c.body(null, 204) : rosterError(c, result.error);
  });
}

const ADOPT_ERRORS: Record<AdoptError, AgentRosterErrorCode> = {
  roster_entry_not_found: "roster_entry_not_found",
  invalid_transition: "invalid_transition",
  agent_bound_to_team: "agent_bound_to_team",
  agent_not_published: "agent_not_published",
  invalid_agent: "invalid_request",
  slug_taken: "slug_taken",
  limit_reached: "limit_reached",
};

const ADOPT_MESSAGES: Partial<Record<AdoptError, string>> = {
  invalid_transition:
    "Only an assigned entry is adopted (not a proposal, not one already removed).",
  agent_not_published: "This agent has no published version to adopt.",
  invalid_agent: "The published version is no longer a valid agent definition.",
  slug_taken: "An agent with that slug already exists here.",
  limit_reached: "This scope has reached its agent limit. Delete an agent first.",
};

async function adopt(
  c: Context,
  deps: ServerDeps,
  target: RosterTarget,
  userId: string,
  teamId: string | null,
) {
  const id = agentIdSchema.safeParse(c.req.param("agentId"));
  if (!id.success) return rosterError(c, "roster_entry_not_found");
  if (!(await withinRate(deps, userId))) return rosterError(c, "rate_limited");
  const result = await adoptEntry(deps.database.db, { agentId: id.data, userId, target, teamId });
  if (!result.ok) return rosterError(c, ADOPT_ERRORS[result.error], ADOPT_MESSAGES[result.error]);
  const { agent, entry } = result.value;
  return c.json(
    {
      agent: {
        id: agent.id,
        scope: agent.scope,
        slug: agent.slug,
        currentVersion: agent.currentVersion,
        forkedFrom: { agentId: id.data, version: agent.forkedFromVersion },
      },
      entry: entryView(entry),
    },
    201,
  );
}

/** `POST /v1/team/agent-roster/:agentId/adopt` (team admins): into a team-owned agent. */
export function mountTeamAdopt(app: Hono<{ Variables: TeamVariables }>, deps: ServerDeps): void {
  app.post("/:agentId/adopt", async (c) => {
    const actor = teamActor(c);
    if (!teamRoleAllows(actor.role, "team.agents.manage")) {
      return rosterError(c, "forbidden", "Only team admins adopt agents into the team.");
    }
    return adopt(c, deps, "team", actor.userId, actor.teamId);
  });
}

/** `POST /v1/site/agent-roster/:agentId/adopt` (site admins): into a site-owned gallery agent. */
export function mountSiteAdopt(app: Hono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  app.post("/:agentId/adopt", async (c) => adopt(c, deps, "site", c.get("user").id, null));
}
