import { Hono } from "hono";
import { requireSession, type AuthVariables } from "./auth/session.js";
import type { ServerDeps } from "./deps.js";
import type { IsolationGate } from "./isolation/gate.js";
import { agentRoutes } from "./routes/agents.js";
import { installGalleryRoutes } from "./routes/install-gallery.js";
import { installInvitesRoutes } from "./routes/install-invites.js";
import { installIsolationRoutes } from "./routes/install-isolation.js";
import { installRolesRoutes } from "./routes/install-roles.js";
import { installSettingsRoutes } from "./routes/install-settings.js";
import { installTeamsRoutes } from "./routes/install-teams.js";
import { installUsersRoutes } from "./routes/install-users.js";
import { meRoutes } from "./routes/me.js";
import { myInvitesRoutes } from "./routes/my-invites.js";
import { myTeamsRoutes } from "./routes/my-teams.js";
import { runEventsRoutes } from "./routes/run-events.js";
import { setupRoutes } from "./routes/setup.js";
import { teamInvitesRoutes } from "./routes/team-invites.js";
import { teamRoutes } from "./routes/team.js";

const SERVICE = "server";

export interface AppOptions {
  /** Isolation gate (spec D4): its state is shown in the install admin console only. */
  readonly isolation?: IsolationGate;
}

/** Health endpoints always; auth and the /v1 API when dependencies are provided. */
export function createApp(deps?: ServerDeps, options: AppOptions = {}): Hono {
  const { isolation } = options;
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok", service: SERVICE }));
  app.get("/readyz", (c) => {
    if (!isolation) return c.json({ status: "ready", service: SERVICE });
    // Ready once the startup check has an answer; a missing runtime keeps serving (D4). The
    // answer itself is not disclosed here (unauthenticated): see /v1/install/isolation and logs.
    return isolation.status().state === "checking"
      ? c.json({ status: "starting", service: SERVICE }, 503)
      : c.json({ status: "ready", service: SERVICE });
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
  api.route("/me/teams", myTeamsRoutes(deps));
  api.route("/me/invites", myInvitesRoutes(deps));
  api.route("/me", meRoutes());
  api.route("/team/invites", teamInvitesRoutes(deps));
  api.route("/team", teamRoutes(deps));
  api.route("/runs", runEventsRoutes(deps));
  api.route("/agents", agentRoutes(deps));
  api.route("/install/settings", installSettingsRoutes(deps));
  api.route("/install/teams", installTeamsRoutes(deps));
  api.route("/install/roles", installRolesRoutes(deps));
  api.route("/install/users", installUsersRoutes(deps));
  api.route("/install/invites", installInvitesRoutes(deps));
  api.route("/install/gallery/agents", installGalleryRoutes(deps));
  if (isolation) api.route("/install/isolation", installIsolationRoutes(isolation));
  app.route("/v1", api);
  return app;
}
