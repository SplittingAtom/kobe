import { MAX_HOST_LENGTH } from "@kobe/db";
import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { deliverEgressRequestNotifications } from "../egress/request-notify.js";
import {
  MAX_PENDING_PER_USER,
  MAX_REQUESTS_PER_HOUR,
  createEgressRequest,
  listMyEgressRequests,
} from "../egress/request-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const createBodySchema = z.strictObject({
  domain: z
    .string()
    .min(1)
    .max(MAX_HOST_LENGTH + 1),
  thread_id: z.uuid().optional(),
});

/**
 * Request access (`/v1/egress/requests`, spec D28, U12; KOBE-39): a member asks the active team's
 * admins to enable a host their sandbox was blocked from (the chat notice's "Request access"),
 * and reads back their own requests. Members can't allow anything themselves; admins decide in
 * `/v1/team/egress/requests`.
 */
export function egressRequestRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.post("/", requireTeamPermission("team.chat"), async (c) => {
    const body = await parseBody(c, createBodySchema);
    if (!body) return invalidRequest(c, 'Send {"domain": "<host>", "thread_id"?: "<uuid>"}.');
    const teamId = c.get("team").id;
    const result = await createEgressRequest(db, {
      teamId,
      userId: c.get("user").id,
      domain: body.domain,
      threadId: body.thread_id,
    });
    switch (result.kind) {
      case "invalid_domain":
        return invalidRequest(c, "domain must be a host name.");
      case "not_in_ceiling":
        return c.json(
          {
            code: "not_in_ceiling",
            message:
              "That domain is outside what this install allows; only an install admin can add it.",
          },
          409,
        );
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
            message: `You can have ${MAX_PENDING_PER_USER} open requests and make ${MAX_REQUESTS_PER_HOUR} per hour. Wait for your team admins to decide.`,
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

  return app;
}
