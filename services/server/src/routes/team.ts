import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { teamPermissionsFor } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, membershipError, parseBody } from "../teams/http.js";
import {
  addMember,
  findUserId,
  listMembers,
  removeMember,
  setMemberRole,
} from "../teams/members.js";
import { addMemberSchema, idSchema, memberRoleSchema } from "../teams/schemas.js";

/** The active team (`/v1/team`, spec §6.1): who you are in it and its membership (D8). */
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

  app.post("/members", requireTeamPermission("team.members.manage"), async (c) => {
    const body = await parseBody(c, addMemberSchema);
    if (!body) return invalidRequest(c, "Give an email and a role (team_admin, builder, member).");
    // Adds an existing Kobe user; new people arrive by invitation (KOBE-13).
    const userId = await findUserId(db, { email: body.email });
    if (!userId)
      return c.json({ code: "user_not_found", message: "No Kobe user has that email." }, 404);
    const result = await addMember(db, c.get("team").id, userId, body.role);
    if (!result.ok) return membershipError(c, result.error);
    return c.json({ userId, role: body.role }, 201);
  });

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
