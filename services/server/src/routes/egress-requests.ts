import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { siteRoleAllows, teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import {
  DECISION_BODY_HINT,
  decideAndRespond,
  decisionWithPatternBodySchema,
} from "../egress/decision-http.js";
import { deliverEgressRequestNotifications } from "../egress/request-notify.js";
import {
  MAX_PENDING_PER_USER,
  MAX_REQUESTS_PER_HOUR,
  createEgressRequest,
  listMyEgressRequests,
} from "../egress/request-store.js";
import { egressRequestCreateBodySchema as createBodySchema } from "../egress/schemas.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Request access (`/v1/egress/requests`, spec D28, U12; KOBE-39): a member asks the active team's
 * admins to enable a host their sandbox was blocked from (the chat notice's "Request access"),
 * and reads back their own requests. Members can't allow anything themselves; admins decide in
 * `/v1/team/egress/requests` or from the card (`/:id/decision`). KOBE-602 (EA1): a host outside
 * the ceiling, or an internal address, makes a site-scope request the site admins decide.
 */
export function egressRequestRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.post("/", requireTeamPermission("team.chat"), async (c) => {
    const body = await parseBody(c, createBodySchema);
    if (!body) {
      return invalidRequest(
        c,
        'Send {"domain": "<host>", "thread_id"?: "<uuid>", "reason"?: "not_enabled" | "not_in_ceiling" | "forbidden_address"}.',
      );
    }
    const teamId = c.get("team").id;
    const result = await createEgressRequest(db, {
      teamId,
      userId: c.get("user").id,
      domain: body.domain,
      threadId: body.thread_id,
      reason: body.reason,
    });
    switch (result.kind) {
      case "invalid_domain":
        return invalidRequest(c, "domain must be a host name.");
      case "already_enabled":
        return c.json(
          {
            code: "already_enabled",
            message: `${result.pattern} is already enabled for your team. Try again.`,
            pattern: result.pattern,
          },
          409,
        );
      case "thread_not_found":
        return c.json({ code: "thread_not_found", message: "That thread does not exist." }, 404);
      case "too_many":
        return c.json(
          {
            code: "too_many_requests",
            message: `You can have ${MAX_PENDING_PER_USER} open requests and make ${MAX_REQUESTS_PER_HOUR} per hour. Wait for your admins to decide.`,
          },
          429,
        );
      case "exists":
        return c.json({ request: result.request }, 200);
      case "created":
        deps.background.run(
          "egress request notification failed",
          () => deliverEgressRequestNotifications(deps, teamId),
          { team: teamId },
        );
        return c.json({ request: result.request }, 201);
    }
  });

  app.get("/", requireTeamPermission("team.chat"), async (c) => {
    const domain = c.req.query("domain");
    return c.json({
      requests: await listMyEgressRequests(db, c.get("team").id, c.get("user").id, {
        ...(domain ? { domain } : {}),
      }),
    });
  });

  /**
   * A decision from the blocked card (KOBE-602, EA2, EA3): a site admin (`site.egress.manage`)
   * decides any request of the active team, putting the pattern in the ceiling (and marking it
   * internal when asked) and enabling it for the team; a team admin (`team.egress.manage`) only a
   * team-scope request, within the ceiling, never internal. Everyone else is refused.
   */
  app.post("/:id/decision", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const body = await parseBody(c, decisionWithPatternBodySchema);
    if (!body) return invalidRequest(c, DECISION_BODY_HINT);
    const siteAdmin = siteRoleAllows(c.get("siteRole"), "site.egress.manage");
    if (!siteAdmin && !teamRoleAllows(c.get("team").role, "team.egress.manage")) {
      return c.json(
        { code: "forbidden", message: "Only an admin can decide access requests." },
        403,
      );
    }
    if (!id.success) {
      return c.json({ code: "request_not_found", message: "That request does not exist." }, 404);
    }
    return decideAndRespond(c, deps, {
      teamId: c.get("team").id,
      requestId: id.data,
      adminId: c.get("user").id,
      decision: body.decision,
      role: siteAdmin ? "site_admin" : "team_admin",
      pattern: body.pattern,
      internal: body.internal,
    });
  });

  return app;
}
