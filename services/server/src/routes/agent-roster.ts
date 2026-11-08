import { Hono, type Context } from "hono";
import {
  AGENT_ROSTER_ERROR_STATUS,
  AGENT_ROSTER_WRITE_RATE,
  agentRosterQuerySchema,
  agentRosterTargetSchema,
  assignAgentRequestSchema,
  updateAgentRosterEntryRequestSchema,
  type AgentRosterErrorCode,
} from "@kobe/protocol";
import type { RosterActor, RosterTarget } from "../agents/access.js";
import { entryView } from "../agents/roster.js";
import { decodeCursor, listRoster } from "../agents/roster-list.js";
import {
  assignAgent,
  setSiteAgentSuspendedHere,
  updateEntry,
  withdrawAgent,
  type AdminUpdate,
} from "../agents/roster-writes.js";
import { agentIdSchema } from "../agents/schemas.js";
import { setAgentStatus, findAgent } from "../agents/store.js";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission, requireTeam, type TeamVariables } from "../authz/middleware.js";
import { siteRoleAllows, teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { parseBody } from "../teams/http.js";

/**
 * Agent roster routes (KOBE-566, spec agents-roster AR16 without fork, transfer and adopt):
 * `GET /v1/agents/roster`, `POST|DELETE /v1/agents/:id/assignments[/:target]` (mounted inside the
 * agent routes, after `requireTeam`), `PUT /v1/team/agent-roster/:agentId` (team admins) and
 * `PUT /v1/site/agent-roster/:agentId` (site admins). Writes are rate-limited per user
 * ({@link AGENT_ROSTER_WRITE_RATE}) and audited; the §5 matrix lives in `agents/access.ts`.
 */

type TeamCtx = Context<{ Variables: TeamVariables }>;

const MESSAGES: Record<AgentRosterErrorCode, string> = {
  invalid_request: "Check the request and try again.",
  forbidden: "You can't change this roster entry.",
  agent_not_found: "No such agent.",
  roster_entry_not_found: "This agent is not on that roster.",
  version_not_found: "This agent has no such published version.",
  agent_archived: "This agent is archived. Unarchive it first.",
  already_on_roster: "This agent is already on that roster (or proposed there).",
  invalid_transition: "That change isn't possible from the entry's current state.",
  roster_limit: "This roster is full (200 assigned agents, 200 proposals). Remove one first.",
  agent_rostered: "This agent is on a roster or proposed to one. Withdraw it first.",
  agent_bound_to_team: "This agent is bound to its team: it can't be assigned elsewhere.",
  agent_not_published: "Publish the agent before proposing it to the site.",
  rate_limited: "Too many roster changes. Try again in a few minutes.",
};

export function rosterError(c: Context, code: AgentRosterErrorCode, message?: string) {
  return c.json({ code, message: message ?? MESSAGES[code] }, AGENT_ROSTER_ERROR_STATUS[code]);
}

const siteAdmin = (c: TeamCtx) => siteRoleAllows(c.get("siteRole"), "site.gallery.manage");

const teamActor = (c: TeamCtx): RosterActor => ({
  userId: c.get("user").id,
  role: c.get("team").role,
  teamId: c.get("team").id,
  siteAdmin: siteAdmin(c),
});

/** One roster write per call against the user's budget; false once over it (429). */
const withinRate = (deps: ServerDeps, userId: string) =>
  hitRateLimit(deps.database.db, `agent-roster:${userId}`, AGENT_ROSTER_WRITE_RATE);

/** Roster reads and the owner's assignments, mounted inside `agentRoutes` before `/:id`. */
export function mountAgentRosterRoutes(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
): void {
  const db = deps.database.db;

  app.get("/roster", async (c) => {
    const query = agentRosterQuerySchema.safeParse(c.req.query());
    if (!query.success)
      return rosterError(c, "invalid_request", "tab must be personal, team or site.");
    const cursor = query.data.cursor === undefined ? null : decodeCursor(query.data.cursor);
    if (query.data.cursor !== undefined && cursor === null) {
      return rosterError(c, "invalid_request", "cursor must be a previous nextCursor.");
    }
    return c.json(
      await listRoster(db, teamActor(c), {
        tab: query.data.tab,
        cursor,
        ...(query.data.limit ? { limit: query.data.limit } : {}),
      }),
    );
  });

  app.post("/:id/assignments", async (c) => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, assignAgentRequestSchema);
    if (!body)
      return rosterError(
        c,
        "invalid_request",
        "Give target (team or site) and optionally versionRule.",
      );
    if (!id.success) return rosterError(c, "agent_not_found");
    if (!(await withinRate(deps, c.get("user").id))) return rosterError(c, "rate_limited");
    const result = await assignAgent(db, teamActor(c), {
      agentId: id.data,
      target: body.target,
      versionRule: body.versionRule,
    });
    if (!result.ok) return rosterError(c, result.error);
    return c.json(
      { entry: entryView(result.value.entry) },
      result.value.mode === "direct" ? 201 : 202,
    );
  });

  app.delete("/:id/assignments/:target", async (c) => {
    const id = agentIdSchema.safeParse(c.req.param("id"));
    const target = agentRosterTargetSchema.safeParse(c.req.param("target"));
    if (!target.success) return rosterError(c, "invalid_request", "target must be team or site.");
    if (!id.success) return rosterError(c, "agent_not_found");
    if (!(await withinRate(deps, c.get("user").id))) return rosterError(c, "rate_limited");
    const result = await withdrawAgent(db, teamActor(c), id.data, target.data);
    if (!result.ok) return rosterError(c, result.error);
    return c.json({ entry: entryView(result.value) });
  });
}

/** Parses an admin's PUT; a Response when it is refused before any work. */
async function readAdminUpdate(
  c: Context,
  deps: ServerDeps,
  target: RosterTarget,
): Promise<AdminUpdate | Response> {
  const id = agentIdSchema.safeParse(c.req.param("agentId"));
  const body = await parseBody(c, updateAgentRosterEntryRequestSchema);
  if (!body) {
    return rosterError(
      c,
      "invalid_request",
      "Give state (active, removed or suspended), and optionally versionRule and note.",
    );
  }
  if (!id.success) return rosterError(c, "agent_not_found");
  if (!(await withinRate(deps, (c as Context<{ Variables: AuthVariables }>).get("user").id))) {
    return rosterError(c, "rate_limited");
  }
  return {
    agentId: id.data,
    target,
    state: body.state,
    versionRule: body.versionRule,
    note: body.note,
  };
}

/**
 * `PUT /v1/team/agent-roster/:agentId` (team admins): approve, decline, pin, update, remove,
 * suspend and resume a team entry. Without a team entry, `suspended`/`active` suspends or resumes
 * for this team a team-owned agent (its status) or a site-wide one (`team_agent_suspensions`, AR9).
 */
export function teamAgentRosterRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.put("/:agentId", async (c) => {
    const actor = teamActor(c);
    if (!teamRoleAllows(actor.role, "team.agents.manage")) {
      return rosterError(c, "forbidden", "Only team admins change the team roster.");
    }
    const update = await readAdminUpdate(c, deps, "team");
    if (update instanceof Response) return update;
    const result = await updateEntry(db, actor, update);
    if (result)
      return result.ok ? c.json({ entry: entryView(result.value) }) : rosterError(c, result.error);
    if (update.state === "removed" || update.versionRule !== undefined) {
      return rosterError(c, "roster_entry_not_found");
    }
    const suspended = update.state === "suspended";
    const owned = await findAgent(db, { scope: "team", teamId: actor.teamId }, update.agentId);
    if (owned) {
      await setAgentStatus(
        db,
        { scope: "team", teamId: actor.teamId },
        owned.id,
        suspended ? "suspended" : "active",
      );
      return c.json({ agentId: owned.id, suspendedHere: suspended });
    }
    const here = await setSiteAgentSuspendedHere(db, actor, update.agentId, suspended);
    if (here.ok) return c.json(here.value);
    // Neither an entry of this roster nor a site-wide agent the team runs.
    return rosterError(c, here.error === "agent_not_found" ? "roster_entry_not_found" : here.error);
  });

  return app;
}

/** `PUT /v1/site/agent-roster/:agentId` (site admins): the same decisions for the site roster. */
export function siteAgentRosterRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.gallery.manage"));

  app.put("/:agentId", async (c) => {
    const update = await readAdminUpdate(c, deps, "site");
    if (update instanceof Response) return update;
    // The site roster has no team: the actor's team fields are unused on this path.
    const actor: RosterActor = {
      userId: c.get("user").id,
      role: "member",
      teamId: "",
      siteAdmin: true,
    };
    const result = await updateEntry(db, actor, update);
    if (!result) return rosterError(c, "roster_entry_not_found");
    return result.ok ? c.json({ entry: entryView(result.value) }) : rosterError(c, result.error);
  });

  return app;
}
