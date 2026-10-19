import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { APP_ID_PATTERN } from "../apps/app-id.js";
import { callApp, takeRateToken, type BrowserPrincipal } from "../apps/call.js";
import { appCallDepsFor } from "../apps/call-deps.js";
import { memberApp, memberAppHtml, memberApps, missingKeyApps, viewOf } from "../apps/catalog.js";
import { checkAppTool } from "../apps/decide.js";
import { appFrameDocument, mayLoadAppFrame } from "../connectors/app-frame.js";
import { uuidSchema } from "../threads/schemas.js";
import type { ServerDeps } from "../deps.js";
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
 * - `GET /v1/team/apps/:appId/frame?team=&sha256=` (KOBE-437, spec MA4 as amended): the
 *   document of the app's iframe, the only `text/html` here, with `APP_FRAME_HEADERS` (CSP
 *   `sandbox allow-scripts`: an opaque origin even top-level, no network). Only pinned and
 *   approved bytes (`servedTemplate`), only the bytes the page names, only into a frame of
 *   Kobe's own page, only for the team the page names (a frame cannot send `X-Kobe-Team`).
 *   Separate from the admin preview route, which may show unapproved bytes.
 * - `GET /v1/team/apps/:appId/tools`: the bridge's `tools/list` (spec §7): the tools of the
 *   app's connector that pass `checkAppTool`, in MCP's shape, under the calls' rate limit.
 * Frame documents start with `WEBRTC_GUARD` and the CSP carries `webrtc 'block'` (MEDIUM-2).
 */
export { APP_CALL_RATE } from "../apps/call-deps.js";
/** 64 KiB of arguments plus the JSON envelope (review MEDIUM-1). */
export const APP_CALL_BODY_MAX = 96 * 1024;

const principal = (c: Context<{ Variables: TeamVariables }>): BrowserPrincipal => ({
  kind: "browser",
  userId: c.get("user").id,
  teamId: c.get("team").id,
});

const callSchema = z.strictObject({
  tool: z.string().min(1).max(128),
  arguments: z.unknown().optional(),
});

/** Strict: the team the page believes is active, and the template bytes it was given. */
const frameQuerySchema = z.strictObject({
  team: uuidSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const NOT_FOUND = { code: "app_not_available", message: "This app is not available to you." };

export function teamAppsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const callDeps = appCallDepsFor(deps);
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  // The rail's Apps section (KOBE-440): the member's apps, and the ones a key of their own adds.
  app.get("/", async (c) => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const apps = await memberApps(db, teamId, userId);
    return c.json({
      apps: apps.map(viewOf),
      needsKey: await missingKeyApps(db, teamId, userId),
    });
  });

  app.get("/:appId/template", async (c) => {
    c.header("Content-Security-Policy", "default-src 'none'");
    const appId = c.req.param("appId");
    const found = APP_ID_PATTERN.test(appId)
      ? await memberApp(db, c.get("team").id, c.get("user").id, appId)
      : undefined;
    const html = found ? await memberAppHtml(db, found) : undefined;
    if (!found || html === undefined) return c.json(NOT_FOUND, 404);
    return c.json({
      html,
      sha256: found.sha256,
      connectorId: found.connector.id,
      uri: found.uri,
    });
  });

  app.get("/:appId/frame", async (c) => {
    if (!mayLoadAppFrame(c.req.raw.headers, deps.publicUrl)) {
      return c.json(
        { code: "forbidden_origin", message: "Only Kobe's own frames load this." },
        403,
      );
    }
    const query = frameQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) {
      return c.json({ code: "invalid_request", message: "Send team and sha256." }, 400);
    }
    const teamId = c.get("team").id;
    if (query.data.team !== teamId) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId: teamId,
        },
        409,
      );
    }
    const appId = c.req.param("appId");
    const found = APP_ID_PATTERN.test(appId)
      ? await memberApp(db, teamId, c.get("user").id, appId)
      : undefined;
    const html = found ? await memberAppHtml(db, found) : undefined;
    if (!found || html === undefined) return c.json(NOT_FOUND, 404);
    const document = appFrameDocument(html, query.data.sha256);
    if (document === "stale") {
      return c.json({ code: "stale", message: "This app changed. Reload to see it." }, 409);
    }
    return document;
  });

  app.get("/:appId/tools", async (c) => {
    const appId = c.req.param("appId");
    if (!APP_ID_PATTERN.test(appId)) return c.json(NOT_FOUND, 404);
    // Same per-member budget as calls (review LOW-8).
    const limited = await takeRateToken(callDeps, principal(c), appId);
    if (limited && !limited.ok) {
      return c.json({ error: { code: limited.code, message: limited.message } }, limited.status);
    }
    const found = APP_ID_PATTERN.test(appId)
      ? await memberApp(db, c.get("team").id, c.get("user").id, appId)
      : undefined;
    if (!found) return c.json(NOT_FOUND, 404);
    const tools = found.connector.tools
      .filter((tool) => checkAppTool(found.connector, tool.name).ok)
      .map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        inputSchema: tool.input_schema,
        ...(tool.output_schema === undefined ? {} : { outputSchema: tool.output_schema }),
        annotations: tool.annotations,
      }));
    return c.json({ tools });
  });

  // Review MEDIUM-1: the rate-limit token is taken before the body is read, and the body is
  // capped (64 KiB of arguments plus the envelope).
  app.post("/:appId/calls", async (c, next) => {
    const appId = c.req.param("appId");
    if (!APP_ID_PATTERN.test(appId)) return c.json({ error: NOT_FOUND }, 404);
    const limited = await takeRateToken(callDeps, principal(c), appId);
    if (limited && !limited.ok) {
      return c.json({ error: { code: limited.code, message: limited.message } }, limited.status);
    }
    await next();
  });
  app.post(
    "/:appId/calls",
    bodyLimit({
      maxSize: APP_CALL_BODY_MAX,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: "The call is too large." } }, 413),
    }),
  );
  app.post("/:appId/calls", async (c) => {
    const appId = c.req.param("appId");
    const body = await parseBody(c, callSchema);
    if (!body) {
      return c.json(
        { error: { code: "invalid_request", message: "Send {tool, arguments}." } },
        400,
      );
    }
    const outcome = await callApp(callDeps, principal(c), appId, body);
    if (outcome.ok) return c.json({ result: outcome.result });
    return c.json({ error: { code: outcome.code, message: outcome.message } }, outcome.status);
  });

  return app;
}
