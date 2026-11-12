import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { teamPermissionsFor } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { listTeamMappings } from "../sso/mappings.js";
import { afterMemberRemoved, afterMemberRoleChanged } from "../teams/after-change.js";
import { invalidRequest, membershipError, parseBody } from "../teams/http.js";
import { listMembers, removeMember, setMemberRole, takeOverMember } from "../teams/members.js";
import { idSchema, memberRoleSchema, teamRoleSchema } from "../teams/schemas.js";

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
    const result = await setMemberRole(
      db,
      c.get("team").id,
      userId.data,
      body.role,
      body.expectedRole,
    );
    if (!result.ok) return membershipError(c, result.error);
    await afterMemberRoleChanged(deps, c.get("team").id, userId.data);
    return c.json({ userId: userId.data, role: body.role });
  });

  app.delete("/members/:userId", requireTeamPermission("team.members.manage"), async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    // `?expectedRole=` (KOBE-621): remove only while the member still has this role (the before-state
    // a Kobe MCP removal was approved with), checked under the change's row lock.
    const expectedRaw = c.req.query("expectedRole");
    const expected = expectedRaw === undefined ? undefined : teamRoleSchema.safeParse(expectedRaw);
    if (!userId.success || (expected !== undefined && !expected.success)) return invalidRequest(c);
    const teamId = c.get("team").id;
    const result = await removeMember(db, teamId, userId.data, expected?.data);
    if (!result.ok) return membershipError(c, result.error);
    await afterMemberRemoved(deps, teamId, userId.data);
    return c.body(null, 204);
  });

  // Take over (KOBE-627, SSO10): the membership becomes the team's own; the identity provider's
  // mappings never touch it again. Audited `identity.member.taken_over`.
  app.post(
    "/members/:userId/take-over",
    requireTeamPermission("team.members.manage"),
    async (c) => {
      const userId = idSchema.safeParse(c.req.param("userId"));
      if (!userId.success) return invalidRequest(c);
      // A mapped team admin can't free their own row from the IdP (review finding 4): another team
      // admin takes it over, or the IdP removes the mapping.
      if (userId.data === c.get("user").id) {
        return c.json(
          {
            code: "cannot_take_over_self",
            message: "Another team admin has to take over your own membership.",
          },
          403,
        );
      }
      const result = await takeOverMember(db, c.get("team").id, userId.data);
      if (!result.ok) return membershipError(c, result.error);
      return c.json({ userId: userId.data, managedBy: null });
    },
  );

  // The access mappings that target this team, read-only (spec sso §7): site admins edit them.
  // The kill switch hides them like every other SSO route (review finding 7).
  app.get("/sso-mappings", requireTeamPermission("team.members.manage"), async (c) =>
    deps.sso.settings.enabled
      ? c.json({ mappings: await listTeamMappings(db, c.get("team").id) })
      : c.json({ code: "not_found", message: "Not found." }, 404),
  );

  return app;
}
