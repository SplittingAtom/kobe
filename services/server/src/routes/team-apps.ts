import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { APP_ID_PATTERN } from "../apps/app-id.js";
import { callApp, type AppCallDeps } from "../apps/call.js";
import { memberApp, memberApps, viewOf } from "../apps/catalog.js";
import type { ServerDeps } from "../deps.js";
import { createDbRuleSource } from "../policy/rule-store.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import { parseBody } from "../teams/http.js";

/**
 * MCP Apps for members (KOBE-436, spec §6), under the browser principal: the signed-in member
 * and the active team (`X-Kobe-Team` must match, re-verified on every request, so removal and
 * deactivation take effect at once), with `team.chat`. No thread, no run, no approvals.
 *
 * - `GET /v1/team/apps`: the member's live apps (MA8), never bytes or credentials.
 * - `GET /v1/team/apps/:appId/template`: `{html, sha256, connectorId, uri}` as **JSON only**
 *   (MA4: `no-store`, `nosniff`, `default-src 'none'`), never `text/html`.
 * - `POST /v1/team/apps/:appId/calls {tool, arguments}`: `{result}` or `{error: {code,
 *   message}}`, decided and audited by `callApp`.
 */
export const APP_CALL_RATE = { capacity: 30, refillPerSecond: 5 } as const;

const callSchema = z.strictObject({
  tool: z.string().min(1).max(128),
  arguments: z.unknown().optional(),
});

const NOT_FOUND = { code: "app_not_available", message: "This app is not available to you." };

export function teamAppsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const callDeps: AppCallDeps = {
    db,
    mcp: deps.mcp,
    rules: createDbRuleSource(db),
    caller: deps.appCaller,
    limiter: createRateLimiter(APP_CALL_RATE),
    limitedAudits: createRateLimiter({ capacity: 1, refillPerSecond: 1 / 60 }),
  };
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/", async (c) => {
    const apps = await memberApps(db, c.get("team").id, c.get("user").id);
    return c.json({ apps: apps.map(viewOf) });
  });

  app.get("/:appId/template", async (c) => {
    c.header("Content-Security-Policy", "default-src 'none'");
    const appId = c.req.param("appId");
    const found = APP_ID_PATTERN.test(appId)
      ? await memberApp(db, c.get("team").id, c.get("user").id, appId)
      : undefined;
    if (!found) return c.json(NOT_FOUND, 404);
    return c.json({
      html: found.html,
      sha256: found.sha256,
      connectorId: found.connector.id,
      uri: found.uri,
    });
  });

  app.post("/:appId/calls", async (c) => {
    const appId = c.req.param("appId");
    if (!APP_ID_PATTERN.test(appId)) return c.json({ error: NOT_FOUND }, 404);
    const body = await parseBody(c, callSchema);
    if (!body) {
      return c.json(
        { error: { code: "invalid_request", message: "Send {tool, arguments}." } },
        400,
      );
    }
    const outcome = await callApp(
      callDeps,
      { kind: "browser", userId: c.get("user").id, teamId: c.get("team").id },
      appId,
      body,
    );
    if (outcome.ok) return c.json({ result: outcome.result });
    return c.json({ error: { code: outcome.code, message: outcome.message } }, outcome.status);
  });

  return app;
}
