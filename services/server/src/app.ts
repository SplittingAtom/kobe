import { Hono } from "hono";
import { requireSession, type AuthVariables } from "./auth/session.js";
import type { ServerDeps } from "./deps.js";
import type { IsolationGate } from "./isolation/gate.js";
import { installIsolationRoutes } from "./routes/install-isolation.js";
import { installSettingsRoutes } from "./routes/install-settings.js";
import { meRoutes } from "./routes/me.js";
import { setupRoutes } from "./routes/setup.js";

const SERVICE = "server";

export interface AppOptions {
  /** Isolation gate (spec D4): reported by /readyz and the install admin console. */
  readonly isolation?: IsolationGate;
}

/** Health endpoints always; auth and the /v1 API when dependencies are provided. */
export function createApp(deps?: ServerDeps, options: AppOptions = {}): Hono {
  const { isolation } = options;
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok", service: SERVICE }));
  app.get("/readyz", (c) => {
    if (!isolation) return c.json({ status: "ready", service: SERVICE });
    // Ready once the startup check has an answer; a missing runtime keeps serving (D4).
    const { state } = isolation.status();
    return state === "checking"
      ? c.json({ status: "starting", service: SERVICE, isolation: state }, 503)
      : c.json({ status: "ready", service: SERVICE, isolation: state });
  });
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
  if (isolation) api.route("/install/isolation", installIsolationRoutes(isolation));
  app.route("/v1", api);
  return app;
}
