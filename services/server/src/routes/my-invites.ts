import { Hono } from "hono";
import { listTeamInvitationsFor } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import {
  acceptTeamInvite,
  declineTeamInvite,
  verifiedEmailOf,
} from "../invitations/team-invites.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

const notFound = {
  code: "invitation_not_found",
  message: "You have no open invitation to that team.",
} as const;

/**
 * The signed-in user's team invitations (`/v1/me/invites`): list, accept (join the team with the
 * invited role), decline. Matched on the user's own email only while it is verified (an address an
 * identity provider did not vouch for sees no invitation: review finding 1); nothing here reveals
 * teams the user wasn't invited to (unknown team and no invitation answer alike).
 */
export function myInvitesRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;

  app.get("/", async (c) => {
    const email = await verifiedEmailOf(db, c.get("user").id);
    const invites = email === null ? [] : await listTeamInvitationsFor(db, email);
    return c.json({
      invitations: invites.map((i) => ({
        teamId: i.teamId,
        teamSlug: i.teamSlug,
        teamName: i.teamName,
        role: i.role,
        invitedByName: i.invitedByName,
        expiresAt: i.expiresAt.toISOString(),
      })),
    });
  });

  app.post("/:teamId/accept", async (c) => {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    if (!teamId.success) return invalidRequest(c);
    const { id } = c.get("user");
    const email = await verifiedEmailOf(db, id);
    if (email === null) return c.json(notFound, 404);
    const role = await acceptTeamInvite(db, teamId.data, { id, email });
    return role === null ? c.json(notFound, 404) : c.json({ teamId: teamId.data, role });
  });

  app.post("/:teamId/decline", async (c) => {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    if (!teamId.success) return invalidRequest(c);
    const email = await verifiedEmailOf(db, c.get("user").id);
    return email !== null && (await declineTeamInvite(db, teamId.data, email))
      ? c.body(null, 204)
      : c.json(notFound, 404);
  });

  return app;
}
