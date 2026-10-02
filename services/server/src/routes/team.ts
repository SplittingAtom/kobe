import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { teamPermissionsFor } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, membershipError, parseBody } from "../teams/http.js";
import { listMembers, removeMember, setMemberRole } from "../teams/members.js";
import { idSchema, memberRoleSchema } from "../teams/schemas.js";

/**
 * The active team (`/v1/team`, spec §6.1): who you are in it and its membership (D8). People join
 * through team invitations they accept (`/v1/team/invites`, KOBE-13), never by being added.
 */
export function teamRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", (c) => {
    const { id, slug, name, role } = c.get("team");
    return c.json({ team: { id, slug, name }, role, permissions: teamPermissionsFor(role) });
  });

  app.get("/members", requireTeamPermission("team.members.read"), async (c) =>
    c.json({ members: await listMembers(db, c.get("team").id) }),
  );

  app.patch("/members/:userId", requireTeamPermission("team.members.manage"), async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    const body = await parseBody(c, memberRoleSchema);
    if (!userId.success || !body) return invalidRequest(c);
    const result = await setMemberRole(db, c.get("team").id, userId.data, body.role);
    if (!result.ok) return membershipError(c, result.error);
    return c.json({ userId: userId.data, role: body.role });
  });

  app.delete("/members/:userId", requireTeamPermission("team.members.manage"), async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const result = await removeMember(db, c.get("team").id, userId.data);
    if (!result.ok) return membershipError(c, result.error);
    return c.body(null, 204);
  });

  return app;
}
