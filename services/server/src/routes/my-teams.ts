import { Hono } from "hono";
import { getMembership, listMemberships, sessionActiveTeams } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { readActiveTeamId } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { activeTeamSchema } from "../teams/schemas.js";

/**
 * The team switcher's API (spec D9): the caller's teams with their role, and the session's one
 * active team. Install roles add nothing: only memberships are listed or selectable.
 */
export function myTeamsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;

  app.get("/", async (c) => {
    const [memberships, activeId] = await Promise.all([
      listMemberships(db, c.get("user").id),
      readActiveTeamId(deps, c.get("sessionId")),
    ]);
    const teams = memberships.map((m) => ({
      id: m.teamId,
      slug: m.slug,
      name: m.name,
      role: m.role,
    }));
    // A pointer to a team the user has since left is reported as no active team.
    const activeTeamId = teams.some((t) => t.id === activeId) ? activeId : null;
    return c.json({ activeTeamId, teams });
  });

  app.put("/active", async (c) => {
    const body = await parseBody(c, activeTeamSchema);
    if (!body) return invalidRequest(c, "teamId must be a team id.");
    // Same answer for an unknown team and someone else's team: no existence oracle.
    const role = await getMembership(db, body.teamId, c.get("user").id);
    if (role === null) {
      return c.json(
        { code: "not_a_team_member", message: "You are not a member of that team." },
        403,
      );
    }
    const sessionId = c.get("sessionId");
    await db
      .insert(sessionActiveTeams)
      .values({ sessionId, teamId: body.teamId })
      .onConflictDoUpdate({
        target: sessionActiveTeams.sessionId,
        set: { teamId: body.teamId, updatedAt: new Date() },
      });
    return c.json({ activeTeamId: body.teamId, role });
  });

  return app;
}
