import { Hono } from "hono";
import { annotate, honoTracing } from "@kobe/telemetry";
import { AuditBusyError } from "@kobe/db";
import { auditRequestContext, auditUserContext } from "./audit/context.js";
import { requireSession, type AuthVariables } from "./auth/session.js";
import type { ServerDeps } from "./deps.js";
import { logger } from "./logger.js";
import type { IsolationGate } from "./isolation/gate.js";
import type { EvalRunner } from "./agents/eval/service.js";
import { agentRoutes } from "./routes/agents.js";
import { teamEvalSettingsRoutes } from "./routes/team-eval-settings.js";
import { teamSettingsRoutes } from "./routes/team-settings.js";
import { siteBudgetRoutes, teamBudgetsRoutes } from "./routes/budgets.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { notificationRoutes } from "./routes/notifications.js";
import { fileRoutes } from "./routes/files.js";
import { memoryRoutes } from "./routes/memory.js";
import { memorySettingsRoutes } from "./routes/memory-settings.js";
import { uploadRoutes } from "./routes/uploads.js";
import { approvalRoutes } from "./routes/approvals.js";
import { egressRequestRoutes } from "./routes/egress-requests.js";
import { siteAuditRoutes } from "./routes/site-audit.js";
import { siteEgressRoutes } from "./routes/site-egress.js";
import { siteBreakGlassRoutes } from "./routes/site-break-glass.js";
import { siteGalleryRoutes } from "./routes/site-gallery.js";
import { siteInvitesRoutes } from "./routes/site-invites.js";
import { siteIsolationRoutes } from "./routes/site-isolation.js";
import { siteModelsRoutes } from "./routes/site-models.js";
import { siteLegalHoldRoutes } from "./routes/site-legal-hold.js";
import { sitePolicyRoutes } from "./routes/site-policy.js";
import { siteRetentionRoutes } from "./routes/site-retention.js";
import { connectorGrantRoutes } from "./routes/connector-grants.js";
import { connectorOauthRoutes } from "./routes/connector-oauth.js";
import { clientMetadataDocument, kobeOrigin } from "./connectors/oauth/client.js";
import { siteConnectorsRoutes } from "./routes/site-connectors.js";
import { siteSkillBlocklistRoutes } from "./routes/site-skill-blocklist.js";
import { siteSkillRescanRoutes } from "./routes/site-skill-rescans.js";
import { siteSkillTagRoutes } from "./routes/site-skill-tags.js";
import { siteRolesRoutes } from "./routes/site-roles.js";
import { siteSettingsRoutes } from "./routes/site-settings.js";
import { siteWebSearchRoutes } from "./routes/site-web-search.js";
import { teamWebSearchRoutes } from "./routes/team-web-search.js";
import { siteTeamsRoutes } from "./routes/site-teams.js";
import { siteUsersRoutes } from "./routes/site-users.js";
import { meRoutes } from "./routes/me.js";
import { meConnectorNoticesRoutes } from "./routes/me-connector-notices.js";
import { myInvitesRoutes } from "./routes/my-invites.js";
import { myTeamsRoutes } from "./routes/my-teams.js";
import { workspaceFileRoutes, type WorkspaceFilesOptions } from "./routes/workspace-files.js";
import { runEventsRoutes } from "./routes/run-events.js";
import { runRoutes, threadRunRoutes } from "./routes/runs.js";
import { setupRoutes } from "./routes/setup.js";
import { skillRoutes } from "./routes/skills.js";
import { skillDraftRoutes } from "./routes/skill-drafts.js";
import { skillEvalRoutes, type SkillEvalRouteOptions } from "./routes/skill-evals.js";
import { skillReachRoutes } from "./routes/skill-reach.js";
import { meSkillEnablementRoutes } from "./routes/me-skill-enablements.js";
import { teamAuditRoutes } from "./routes/team-audit.js";
import { teamEgressRoutes } from "./routes/team-egress.js";
import { teamBreakGlassRoutes } from "./routes/team-break-glass.js";
import { teamInvitesRoutes } from "./routes/team-invites.js";
import { teamConnectorsRoutes } from "./routes/team-connectors.js";
import { teamModelsRoutes } from "./routes/team-models.js";
import { teamPolicyRoutes } from "./routes/team-policy.js";
import { teamOffboardedRoutes } from "./routes/team-offboarded.js";
import { teamRetentionRoutes } from "./routes/team-retention.js";
import { teamSkillReviewRoutes } from "./routes/team-skill-review.js";
import { teamSkillInstallRoutes } from "./routes/team-skill-installs.js";
import { teamRoutes } from "./routes/team.js";
import { projectRoutes } from "./routes/projects.js";
import { threadPendingRoutes } from "./routes/thread-pending.js";
import { threadCompactRoutes } from "./routes/thread-compact.js";
import { threadMarkerRoutes } from "./routes/thread-markers.js";
import { threadRetentionRoutes } from "./routes/thread-retention.js";
import { threadRoutes } from "./routes/threads.js";
import { runFeedbackRoutes, threadFeedbackRoutes } from "./routes/feedback.js";
import { evalCaseRoutes, runEvalCaseRoutes } from "./eval-cases/routes.js";
import {
  siteUsageRoutes,
  runUsageRoutes,
  teamUsageRoutes,
  threadUsageRoutes,
} from "./routes/usage.js";

const SERVICE = "server";

export interface AppOptions {
  /** Isolation gate (spec D4): its state is shown in the site admin console only. */
  readonly isolation?: IsolationGate;
  /** Runs the pre-publish Orbit evals (KOBE-93); unset, an enabled gate blocks publishing. */
  readonly evals?: EvalRunner;
  /** Workspace file browser (KOBE-148); unset (no object storage), its routes answer 503. */
  readonly workspaceFiles?: WorkspaceFilesOptions;
  /** Skill evals (KOBE-325): the event hub and the runner's kick. */
  readonly skillEvals?: SkillEvalRouteOptions;
}

/** Health endpoints always; auth and the /v1 API when dependencies are provided. */
export function createApp(deps?: ServerDeps, options: AppOptions = {}): Hono {
  const { isolation } = options;
  const app = new Hono();
  // Never the caller's trace (KOBE-274): run trace ids are predictable, so joining would let anyone
  // who knows a run id write into that run's trace. Every request starts its own trace.
  app.use("*", honoTracing({ joinCallerTrace: false }));
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
    // answer itself is not disclosed here (unauthenticated): see /v1/site/isolation and logs.
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

  // Kobe's OAuth Client ID Metadata Document (KOBE-109): public, fetched by authorization servers.
  app.get("/v1/oauth/client-metadata.json", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(clientMetadataDocument(kobeOrigin(deps.publicUrl)));
  });

  const api = new Hono<{ Variables: AuthVariables }>();
  // CSRF: state-changing API calls must come from the site's own origin.
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
  api.use(async (c, next) => {
    annotate({ userId: c.get("user").id });
    await next();
  });
  api.route("/me/teams", myTeamsRoutes(deps));
  api.route("/me/invites", myInvitesRoutes(deps));
  api.route("/me/connector-notices", meConnectorNoticesRoutes(deps));
  api.route("/me/skills", meSkillEnablementRoutes(deps));
  api.route("/me", meRoutes(deps));
  api.route("/team/policy", teamPolicyRoutes(deps));
  api.route("/team/invites", teamInvitesRoutes(deps));
  api.route("/team/audit", teamAuditRoutes(deps));
  api.route("/team/egress", teamEgressRoutes(deps));
  api.route("/team/models", teamModelsRoutes(deps));
  api.route("/team/connectors", teamConnectorsRoutes(deps));
  api.route("/team/web-search", teamWebSearchRoutes(deps));
  api.route("/team/usage", teamUsageRoutes(deps));
  api.route("/team/budgets", teamBudgetsRoutes(deps));
  api.route("/team/break-glass", teamBreakGlassRoutes(deps));
  api.route("/team/retention", teamRetentionRoutes(deps));
  api.route("/team/eval-settings", teamEvalSettingsRoutes(deps));
  api.route("/team/settings", teamSettingsRoutes(deps));
  api.route("/team/skill-review", teamSkillReviewRoutes(deps));
  api.route("/team/skills", teamSkillInstallRoutes(deps));
  api.route("/team/offboarded", teamOffboardedRoutes(deps));
  api.route("/team", teamRoutes(deps));
  api.route("/runs", runEventsRoutes(deps));
  api.route("/runs", runRoutes(deps));
  api.route("/runs", runUsageRoutes(deps));
  api.route("/runs", runFeedbackRoutes(deps));
  api.route("/runs", runEvalCaseRoutes(deps));
  api.route("/eval-cases", evalCaseRoutes(deps));
  api.route("/projects", projectRoutes(deps));
  api.route("/threads", threadRunRoutes(deps));
  api.route("/threads", threadPendingRoutes(deps));
  api.route("/threads", threadCompactRoutes(deps));
  api.route("/threads", threadMarkerRoutes(deps));
  api.route("/threads", threadUsageRoutes(deps));
  api.route("/threads", threadFeedbackRoutes(deps));
  api.route("/threads", threadRetentionRoutes(deps));
  api.route("/threads", threadRoutes(deps));
  api.route("/artifacts", artifactRoutes(deps));
  api.route("/schedules", scheduleRoutes(deps));
  api.route("/notifications", notificationRoutes(deps));
  api.route("/memory/settings", memorySettingsRoutes(deps));
  api.route("/memory", memoryRoutes(deps));
  api.route("/uploads", uploadRoutes(deps));
  api.route("/files", fileRoutes(deps));
  api.route("/connector-grants", connectorOauthRoutes(deps));
  api.route("/connector-grants", connectorGrantRoutes(deps));
  api.route("/workspace", workspaceFileRoutes(deps, options.workspaceFiles));
  api.route("/agents", agentRoutes(deps, options.evals ? { runner: options.evals } : {}));
  // Skill evals (KOBE-325): full paths under /skills and /skill-evals, before /skills' `/:id`.
  api.route("/", skillEvalRoutes(deps, options.skillEvals));
  // Before /skills: its `/:id` would otherwise answer for `/skills/drafts`.
  api.route("/skills/drafts", skillDraftRoutes(deps, options.workspaceFiles?.sync));
  api.route("/skills", skillRoutes(deps));
  api.route("/skills", skillReachRoutes(deps));
  api.route("/approvals", approvalRoutes(deps));
  api.route("/egress/requests", egressRequestRoutes(deps));
  api.route("/site/settings", siteSettingsRoutes(deps));
  api.route("/site/web-search", siteWebSearchRoutes(deps));
  api.route("/site/teams", siteTeamsRoutes(deps));
  api.route("/site/roles", siteRolesRoutes(deps));
  api.route("/site/policy", sitePolicyRoutes(deps));
  api.route("/site/users", siteUsersRoutes(deps));
  api.route("/site/invites", siteInvitesRoutes(deps));
  api.route(
    "/site/gallery/agents",
    siteGalleryRoutes(deps, options.evals ? { runner: options.evals } : {}),
  );
  api.route("/site/audit", siteAuditRoutes(deps));
  api.route("/site/egress-ceiling", siteEgressRoutes(deps));
  api.route("/site/models", siteModelsRoutes(deps));
  api.route("/site/usage", siteUsageRoutes(deps));
  api.route("/site/budget", siteBudgetRoutes(deps));
  api.route("/site/break-glass", siteBreakGlassRoutes(deps));
  api.route("/site/legal-hold", siteLegalHoldRoutes(deps));
  api.route("/site/retention", siteRetentionRoutes(deps));
  api.route("/site/connectors", siteConnectorsRoutes(deps));
  api.route("/site/skill-blocklist", siteSkillBlocklistRoutes(deps));
  api.route("/site/skill-rescans", siteSkillRescanRoutes(deps));
  api.route("/site/skills", siteSkillTagRoutes(deps));
  if (isolation) api.route("/site/isolation", siteIsolationRoutes(isolation));
  app.route("/v1", api);
  return app;
}
