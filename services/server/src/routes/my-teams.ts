import { Hono } from "hono";
import {
  getMembership,
  listTeamChoices,
  readLastTeam,
  rememberLastTeam,
  sessionActiveTeams,
} from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { readActiveTeamId } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { activeTeamSchema } from "../teams/schemas.js";

/**
 * The team switcher's API (spec D9): the caller's teams with their role, and the session's one
 * active team. Site roles add nothing: only memberships are listed or selectable.
 * A new session has no active team: the web picks one from the user's last active team
 * (remembered per user on every switch) and each team's `registry` and `chatReady` (KOBE-456).
 */
export function myTeamsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;

  app.get("/", async (c) => {
    const userId = c.get("user").id;
    const [choices, activeId, lastId] = await Promise.all([
      listTeamChoices(db, userId),
      readActiveTeamId(deps, c.get("sessionId")),
      readLastTeam(db, userId),
    ]);
    const teams = choices.map((m) => ({
      id: m.teamId,
      slug: m.slug,
      name: m.name,
      role: m.role,
      registry: m.registry,
      chatReady: m.chatReady,
    }));
    // A pointer to a team the user has since left is reported as no team.
    const member = (id: string | null) => (teams.some((t) => t.id === id) ? id : null);
    return c.json({ activeTeamId: member(activeId), lastTeamId: member(lastId), teams });
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
    await db.transaction(async (tx) => {
      await tx
        .insert(sessionActiveTeams)
        .values({ sessionId, teamId: body.teamId })
        .onConflictDoUpdate({
          target: sessionActiveTeams.sessionId,
          set: { teamId: body.teamId, updatedAt: new Date() },
        });
      await rememberLastTeam(tx, c.get("user").id, body.teamId);
    });
    return c.json({ activeTeamId: body.teamId, role });
  });

  return app;
}
