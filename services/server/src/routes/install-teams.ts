import { Hono } from "hono";
import { asc, eq, teams } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { createTeamWithAdmin, findTeam, findUserId, listMembers } from "../teams/members.js";
import { createTeamSchema, idSchema, renameTeamSchema } from "../teams/schemas.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === UNIQUE_VIOLATION || e?.cause?.code === UNIQUE_VIOLATION;
}

/**
 * Install admins create teams and name each team's first team admin (spec D8), rename teams and
 * read rosters (team metadata, not content). They cannot add, re-role or remove members of an
 * existing team: that belongs to the team's own admins, or an install admin could make an
 * accomplice team admin, get added, and read team content without break-glass.
 */
export function installTeamsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.teams.manage"));

  const teamNotFound = { code: "team_not_found", message: "No team with that id." } as const;
  const userNotFound = { code: "user_not_found", message: "No Kobe user with that id." } as const;

  app.get("/", async (c) => {
    const rows = await db
      .select({ id: teams.id, slug: teams.slug, name: teams.name, createdAt: teams.createdAt })
      .from(teams)
      .orderBy(asc(teams.name), asc(teams.slug));
    return c.json({ teams: rows.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })) });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, createTeamSchema);
    if (!body) return invalidRequest(c, "Give a slug, a name and the first team admin.");
    if (!(await findUserId(db, { id: body.adminUserId }))) return c.json(userNotFound, 404);
    try {
      const team = await createTeamWithAdmin(db, body, body.adminUserId);
      return c.json({ team }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ code: "slug_taken", message: "Another team already uses that slug." }, 409);
      }
      throw err;
    }
  });

  app.patch("/:teamId", async (c) => {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    const body = await parseBody(c, renameTeamSchema);
    if (!teamId.success || !body) return invalidRequest(c);
    // The slug is immutable: it names the team's sandbox namespace.
    const [team] = await db
      .update(teams)
      .set({ name: body.name })
      .where(eq(teams.id, teamId.data))
      .returning({ id: teams.id, slug: teams.slug, name: teams.name });
    return team ? c.json({ team }) : c.json(teamNotFound, 404);
  });

  app.get("/:teamId/members", async (c) => {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    if (!teamId.success) return invalidRequest(c);
    if (!(await findTeam(db, teamId.data))) return c.json(teamNotFound, 404);
    return c.json({ members: await listMembers(db, teamId.data) });
  });

  return app;
}
