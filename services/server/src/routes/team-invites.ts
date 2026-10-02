import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { notifyTeamInvite } from "../invitations/notify.js";
import { inviteToTeam, listTeamInvites, revokeTeamInvite } from "../invitations/team-invites.js";
import { hitRateLimit } from "../rate-limit.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { idSchema, teamRoleSchema } from "../teams/schemas.js";

const inviteSchema = z.object({ email: z.email().max(254), role: teamRoleSchema }).strict();
const INVITES_PER_HOUR = 50;

/**
 * Team invitations (`/v1/team/invites`, KOBE-13): the way a team admin brings someone into the
 * active team. The person must accept while signed in as the invited address, so nobody joins a
 * team without consent, and the answer is the same whether or not the address is a Kobe user (no
 * account-existence oracle). People without an account need an install invitation too.
 */
export function teamInvitesRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.members.manage"));

  app.get("/", async (c) => c.json({ invitations: await listTeamInvites(db, c.get("team").id) }));

  app.post("/", async (c) => {
    const body = await parseBody(c, inviteSchema);
    if (!body) return invalidRequest(c, "Give an email and a role (team_admin, builder, member).");
    const me = c.get("user");
    const team = c.get("team");
    if (
      !(await hitRateLimit(db, `team-invite:${me.id}`, {
        windowMs: 3_600_000,
        max: INVITES_PER_HOUR,
      }))
    ) {
      return c.json(
        { code: "rate_limited", message: "Too many invitations. Try again later." },
        429,
      );
    }
    const invite = await inviteToTeam(db, team.id, { ...body, invitedBy: me.id });
    if (invite === "already_member") {
      return c.json({ code: "already_member", message: "That person is already a member." }, 409);
    }
    notifyTeamInvite(deps, {
      email: invite.email,
      teamName: team.name,
      role: invite.role,
      inviterName: me.name,
    });
    return c.json({ invitation: invite }, 202);
  });

  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return (await revokeTeamInvite(db, c.get("team").id, id.data))
      ? c.body(null, 204)
      : c.json({ code: "invitation_not_found", message: "No invitation with that id." }, 404);
  });

  return app;
}
