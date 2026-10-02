import { Hono } from "hono";
import { asc, eq, teams } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, membershipError, parseBody } from "../teams/http.js";
import {
  addMember,
  createTeamWithAdmin,
  findTeam,
  findUserId,
  listMembers,
  removeMember,
  setMemberRole,
} from "../teams/members.js";
import {
  createTeamSchema,
  idSchema,
  memberRoleSchema,
  renameTeamSchema,
} from "../teams/schemas.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === UNIQUE_VIOLATION || e?.cause?.code === UNIQUE_VIOLATION;
}

/**
 * Install admins create teams and place users in them (spec D7, D8). Membership and roles are
 * team metadata, not team content: nothing here reads threads, files, memory or artifacts.
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

  /** Adds the user with this role, or changes their role if they are already a member. */
  app.put("/:teamId/members/:userId", async (c) => {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    const userId = idSchema.safeParse(c.req.param("userId"));
    const body = await parseBody(c, memberRoleSchema);
    if (!teamId.success || !userId.success || !body) return invalidRequest(c);
    // An install role must not become a way into team content (D8: break-glass only), so install
    // admins can't add themselves or change their own team role here; a team admin must do it.
    if (userId.data === c.get("user").id) {
      return c.json(
        {
          code: "self_membership",
          message: "Install admins can't add themselves to a team. Ask one of its team admins.",
        },
        403,
      );
    }
    if (!(await findTeam(db, teamId.data))) return c.json(teamNotFound, 404);
    if (!(await findUserId(db, { id: userId.data }))) return c.json(userNotFound, 404);
    const added = await addMember(db, teamId.data, userId.data, body.role);
    if (added.ok) return c.json({ userId: userId.data, role: body.role }, 201);
    const changed = await setMemberRole(db, teamId.data, userId.data, body.role);
    if (!changed.ok) return membershipError(c, changed.error);
    return c.json({ userId: userId.data, role: body.role });
  });

  app.delete("/:teamId/members/:userId", async (c) => {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!teamId.success || !userId.success) return invalidRequest(c);
    if (!(await findTeam(db, teamId.data))) return c.json(teamNotFound, 404);
    const result = await removeMember(db, teamId.data, userId.data);
    if (!result.ok) return membershipError(c, result.error);
    return c.body(null, 204);
  });

  return app;
}
