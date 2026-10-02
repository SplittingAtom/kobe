import { Hono } from "hono";
import { listTeamAuditEvents, withTeam } from "@kobe/db";
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

  app.get("/", async (c) => {
    const query = parseAuditQuery(c, { allowTeamFilter: false });
    if (!query.ok) return query.response;
    // The team comes from the withTeam transaction (kobe.team_id), not from a parameter.
    const page = await withTeam(db, c.get("team").id, (tx) => listTeamAuditEvents(tx, query.value));
    return c.json(auditPageBody(page));
  });

  return app;
}
