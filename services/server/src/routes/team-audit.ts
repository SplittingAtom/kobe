import { Hono } from "hono";
import { listTeamAuditEvents, withTeam } from "@kobe/db";
import { exportResponse, parseExportQuery } from "../audit/export/http.js";
import { EXPORT_PAGE_SIZE } from "../audit/export/stream.js";
import { hitRateLimit } from "../rate-limit.js";
import { auditPageBody, parseAuditQuery } from "../audit/http.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

/**
 * The active team's audit view (spec D6; §6.1 `/v1/team/audit`), team admins only: the events
 * recorded for this team (membership, invitations, team agents, and install-level actions on the
 * team such as break-glass), with the same paging and filters as the install log except `teamId`.
 */
export function teamAuditRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.audit.read"));

  /**
   * CSV or JSONL download of the team view for a date range (KOBE-19). Every page is read inside
   * `withTeam`, so RLS and the team match apply; the download holds no transaction open.
   */
  app.get("/export", async (c) => {
    const parsed = parseExportQuery(c, { allowTeamFilter: false });
    if (!parsed.ok) return parsed.response;
    const teamId = c.get("team").id;
    const actorId = c.get("user").id;
    const allowed = await hitRateLimit(db, `audit-export:${actorId}`, {
      windowMs: 60_000,
      max: 6,
    });
    if (!allowed) {
      return c.json({ code: "rate_limited", message: "Try the export again in a minute." }, 429);
    }
    const { since, until } = parsed.value;
    return exportResponse(c, {
      db,
      query: parsed.value,
      scope: "team",
      actorId,
      teamId,
      fetchPage: (after) =>
        withTeam(db, teamId, (tx) =>
          listTeamAuditEvents(tx, {
            after,
            limit: EXPORT_PAGE_SIZE,
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
          }),
        ),
    });
  });

  app.get("/", async (c) => {
    const query = parseAuditQuery(c, { allowTeamFilter: false });
    if (!query.ok) return query.response;
    // The team comes from the withTeam transaction (kobe.team_id), not from a parameter.
    const page = await withTeam(db, c.get("team").id, (tx) => listTeamAuditEvents(tx, query.value));
    return c.json(auditPageBody(page));
  });

  return app;
}
