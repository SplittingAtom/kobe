import { Hono } from "hono";
import { AuditBusyError } from "@kobe/db";
import { auditRequestContext, auditUserContext } from "./audit/context.js";
import { requireSession, type AuthVariables } from "./auth/session.js";
import type { ServerDeps } from "./deps.js";
import { logger } from "./logger.js";
import type { IsolationGate } from "./isolation/gate.js";
import { agentRoutes } from "./routes/agents.js";
import { installAuditRoutes } from "./routes/install-audit.js";
import { installEgressRoutes } from "./routes/install-egress.js";
import { installGalleryRoutes } from "./routes/install-gallery.js";
import { installInvitesRoutes } from "./routes/install-invites.js";
import { installIsolationRoutes } from "./routes/install-isolation.js";
import { installPolicyRoutes } from "./routes/install-policy.js";
import { installRolesRoutes } from "./routes/install-roles.js";
import { installSettingsRoutes } from "./routes/install-settings.js";
import { installTeamsRoutes } from "./routes/install-teams.js";
import { installUsersRoutes } from "./routes/install-users.js";
import { meRoutes } from "./routes/me.js";
import { myInvitesRoutes } from "./routes/my-invites.js";
import { myTeamsRoutes } from "./routes/my-teams.js";
import { runEventsRoutes } from "./routes/run-events.js";
import { setupRoutes } from "./routes/setup.js";
import { teamAuditRoutes } from "./routes/team-audit.js";
import { teamEgressRoutes } from "./routes/team-egress.js";
import { teamInvitesRoutes } from "./routes/team-invites.js";
import { teamPolicyRoutes } from "./routes/team-policy.js";
import { teamRoutes } from "./routes/team.js";
import { threadRoutes } from "./routes/threads.js";

const SERVICE = "server";

export interface AppOptions {
  /** Isolation gate (spec D4): its state is shown in the install admin console only. */
  readonly isolation?: IsolationGate;
}

/** Health endpoints always; auth and the /v1 API when dependencies are provided. */
export function createApp(deps?: ServerDeps, options: AppOptions = {}): Hono {
  const { isolation } = options;
  const app = new Hono();
  // An audited action that couldn't get the audit chain lock in time rolled back: retryable.
  app.onError((err, c) => {
    if (err instanceof AuditBusyError) {
      return c.json({ code: err.code, message: err.message }, 503);
    }
    // Hono's default handling for everything else.
    if ("getResponse" in err && typeof err.getResponse === "function") {
      return err.getResponse() as Response;
    }
    logger.error({ err }, "unhandled error");
    return c.text("Internal Server Error", 500);
  });
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

  // Request metadata (client IP, user agent) for audit events of unauthenticated routes (KOBE-15).
  app.use("/api/auth/*", auditRequestContext(deps));
  app.use("/v1/setup/*", auditRequestContext(deps));
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
  // The signed-in user is the actor of everything audited in the request (KOBE-15).
  api.use(auditUserContext(deps));
  api.route("/me/teams", myTeamsRoutes(deps));
  api.route("/me/invites", myInvitesRoutes(deps));
  api.route("/me", meRoutes());
  api.route("/team/policy", teamPolicyRoutes(deps));
  api.route("/team/invites", teamInvitesRoutes(deps));
  api.route("/team/audit", teamAuditRoutes(deps));
  api.route("/team/egress", teamEgressRoutes(deps));
  api.route("/team", teamRoutes(deps));
  api.route("/runs", runEventsRoutes(deps));
  api.route("/threads", threadRoutes(deps));
  api.route("/agents", agentRoutes(deps));
  api.route("/install/settings", installSettingsRoutes(deps));
  api.route("/install/teams", installTeamsRoutes(deps));
  api.route("/install/roles", installRolesRoutes(deps));
  api.route("/install/policy", installPolicyRoutes(deps));
  api.route("/install/users", installUsersRoutes(deps));
  api.route("/install/invites", installInvitesRoutes(deps));
  api.route("/install/gallery/agents", installGalleryRoutes(deps));
  api.route("/install/audit", installAuditRoutes(deps));
  api.route("/install/egress-ceiling", installEgressRoutes(deps));
  if (isolation) api.route("/install/isolation", installIsolationRoutes(isolation));
  app.route("/v1", api);
  return app;
}
