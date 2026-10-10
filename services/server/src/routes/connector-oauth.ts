import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { kobeOrigin } from "../connectors/oauth/client.js";
import { finishFlow, startFlow, type OauthFlowDeps } from "../connectors/oauth/flow.js";
import { DEFAULT_TIMEOUT_MS } from "../connectors/oauth/http.js";
import type { ServerDeps } from "../deps.js";

const idSchema = z.uuid();
const MESSAGES = {
  oauth_unsupported: "This connector's authorization server cannot be used safely with Kobe.",
  oauth_unreachable: "Could not reach the connector's authorization server.",
  registration_failed: "The authorization server did not accept Kobe as a client.",
} as const;

function flowDeps(deps: ServerDeps): OauthFlowDeps | undefined {
  if (!deps.envelope) return undefined;
  return {
    db: deps.database.db,
    envelope: deps.envelope,
    io: { policy: deps.connectorUrlPolicy, timeoutMs: DEFAULT_TIMEOUT_MS },
    kobe: kobeOrigin(deps.publicUrl),
    now: () => new Date(),
  };
}

/**
 * Per-user OAuth connect flow (KOBE-109).
 *
 * POST /{connector_id}/oauth/start → 200 `{authorization_url}`: send the browser there. 404 not
 *   enabled; 422 `not_oauth` / `oauth_unsupported` / `registration_failed`; 502
 *   `oauth_unreachable`; 503 when the install has no envelope key.
 * GET /oauth/callback?code&state&iss → 303 to `/?connector_oauth=connected|failed&connector=<id>`
 *   (`reason` on failure). A state that does not open for this user and team is a 400
 *   `invalid_state` and reveals nothing else.
 */
export function connectorOauthRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.post("/:connectorId/oauth/start", async (c) => {
    const id = idSchema.safeParse(c.req.param("connectorId"));
    if (!id.success) return c.json({ code: "connector_not_available", message: "Not found." }, 404);
    const flow = flowDeps(deps);
    if (!flow) {
      return c.json(
        { code: "credentials_unavailable", message: "This install cannot store credentials yet." },
        503,
      );
    }
    const result = await startFlow(flow, {
      teamId: c.get("team").id,
      userId: c.get("user").id,
      connectorId: id.data,
    });
    if (result.ok) return c.json({ authorization_url: result.authorizationUrl });
    if (result.failure === "not_available") {
      return c.json(
        {
          code: "connector_not_available",
          message: "That connector is not enabled for your team.",
        },
        404,
      );
    }
    if (result.failure === "not_oauth") {
      return c.json({ code: "not_oauth", message: "That connector does not use OAuth." }, 422);
    }
    const status = result.failure === "oauth_unreachable" ? 502 : 422;
    const message = MESSAGES[result.failure as keyof typeof MESSAGES] ?? MESSAGES.oauth_unsupported;
    return c.json({ code: result.failure, message }, status);
  });

  app.get("/oauth/callback", async (c) => {
    const flow = flowDeps(deps);
    const state = c.req.query("state");
    if (!flow || !state) return c.json({ code: "invalid_state", message: "Invalid state." }, 400);
    const result = await finishFlow(
      flow,
      { userId: c.get("user").id, activeTeamId: c.get("team").id },
      {
        state,
        code: c.req.query("code"),
        iss: c.req.query("iss"),
        error: c.req.query("error"),
      },
    );
    if (!result.ok && result.connectorId === undefined) {
      return c.json({ code: "invalid_state", message: "Invalid state." }, 400);
    }
    const target = new URL("/", deps.publicUrl);
    target.searchParams.set("connector_oauth", result.ok ? "connected" : "failed");
    if (result.connectorId !== undefined) target.searchParams.set("connector", result.connectorId);
    if (!result.ok) target.searchParams.set("reason", result.failure);
    return c.redirect(target.toString(), 303);
  });

  return app;
}
