import { Hono } from "hono";
import { requireSession, type AuthVariables } from "./auth/session.js";
import type { ServerDeps } from "./deps.js";
import { installSettingsRoutes } from "./routes/install-settings.js";
import { meRoutes } from "./routes/me.js";
import { setupRoutes } from "./routes/setup.js";

const SERVICE = "server";

/** Health endpoints always; auth and the /v1 API when dependencies are provided. */
export function createApp(deps?: ServerDeps): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok", service: SERVICE }));
  app.get("/readyz", (c) => c.json({ status: "ready", service: SERVICE }));
  if (!deps) return app;

  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.route("/v1/setup", setupRoutes(deps));

  const api = new Hono<{ Variables: AuthVariables }>();
  // CSRF: state-changing API calls must come from the install's own origin.
  api.use(async (c, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("origin") !== deps.publicUrl
    ) {
      return c.json({ code: "forbidden_origin", message: "Cross-origin request rejected." }, 403);
    }
    await next();
  });
  api.use(requireSession(deps));
  api.route("/me", meRoutes());
  api.route("/install/settings", installSettingsRoutes(deps));
  app.route("/v1", api);
  return app;
}
