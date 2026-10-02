import { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  findOpenInviteEmail,
  issueInvite,
  listInvites,
  normalizeEmail,
  reissueInvite,
  revokeInvite,
} from "../invitations/install-invites.js";
import { mailInstallInvite } from "../invitations/notify.js";
import { hitRateLimit } from "../rate-limit.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

const inviteSchema = z.object({ email: z.email().max(254) }).strict();

/** Invitations (new or re-sent) one install admin may send per hour. */
export const INVITES_PER_ADMIN_PER_HOUR = 30;
/** Invitations (new or re-sent) one address may receive per hour, whoever sends them. */
export const INVITES_PER_ADDRESS_PER_HOUR = 5;
const HOUR = 3_600_000;

/**
 * Install invitations (spec D6/D7, §6.1 `/v1/install/invites`): install admins invite people into
 * the install by email. The link carries a single-use token (hashed at rest, 72 h); the invitee
 * sets a password and is signed in. Team membership then comes from each team's own admins (team
 * invitations the invitee accepts), never from install admins (D8, KOBE-14).
 */
export function installInvitesRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const notFound = { code: "invitation_not_found", message: "No open invitation with that id." };
  app.use(requireInstallPermission("install.users.manage"));

  /** Counts one invitation email against the sender's and the address's hourly caps. */
  async function withinCaps(adminId: string, email: string): Promise<boolean> {
    const byAdmin = await hitRateLimit(db, `invite-admin:${adminId}`, {
      windowMs: HOUR,
      max: INVITES_PER_ADMIN_PER_HOUR,
    });
    if (!byAdmin) return false;
    return hitRateLimit(db, `invite-address:${normalizeEmail(email)}`, {
      windowMs: HOUR,
      max: INVITES_PER_ADDRESS_PER_HOUR,
    });
  }
  const tooMany = { code: "rate_limited", message: "Too many invitations. Try again later." };

  app.get("/", async (c) => c.json({ invitations: await listInvites(db) }));

  app.post("/", async (c) => {
    const body = await parseBody(c, inviteSchema);
    if (!body) return invalidRequest(c, "Give the email address to invite.");
    const me = c.get("user");
    if (!(await withinCaps(me.id, body.email))) return c.json(tooMany, 429);
    const invite = await issueInvite(db, { email: body.email, invitedBy: me.id });
    if (invite === "user_exists") {
      return c.json(
        { code: "user_exists", message: "That address already has a Kobe account." },
        409,
      );
    }
    const emailSent = await mailInstallInvite(deps, invite, me.name);
    return c.json(
      {
        invitation: {
          id: invite.id,
          email: invite.email,
          expiresAt: invite.expiresAt.toISOString(),
        },
        emailSent,
      },
      201,
    );
  });

  app.post("/:id/resend", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const me = c.get("user");
    const email = await findOpenInviteEmail(db, id.data);
    if (email === null) return c.json(notFound, 404);
    if (!(await withinCaps(me.id, email))) return c.json(tooMany, 429);
    const invite = await reissueInvite(db, id.data, me.id);
    if (!invite) return c.json(notFound, 404);
    const emailSent = await mailInstallInvite(deps, invite, me.name);
    return c.json({
      invitation: { id: invite.id, email: invite.email, expiresAt: invite.expiresAt.toISOString() },
      emailSent,
    });
  });

  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return (await revokeInvite(db, id.data)) ? c.body(null, 204) : c.json(notFound, 404);
  });

  return app;
}
