import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import {
  effectiveStatus,
  listTeamGrants,
  scopeOf,
  type GrantDetail,
} from "../break-glass/store.js";
import type { ServerDeps } from "../deps.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * A grant as the team's admins see it. A legal hold hides the reason, the subject and the thread
 * (the subject may be a team admin, D10), but never that access happened or for how long.
 */
function teamGrantJson(detail: GrantDetail) {
  const { grant } = detail;
  const hidden = grant.legalHold;
  return {
    id: grant.id,
    status: effectiveStatus(grant),
    requestedBy: { id: detail.requestedBy.id, name: detail.requestedBy.name },
    approvedBy: detail.approvedBy
      ? { id: detail.approvedBy.id, name: detail.approvedBy.name }
      : null,
    selfApproved: grant.selfApproved,
    legalHold: grant.legalHold,
    scope: hidden ? "restricted" : scopeOf(grant),
    subject:
      hidden || !detail.subject ? null : { id: detail.subject.id, name: detail.subject.name },
    threadId: hidden ? null : grant.threadId,
    reason: hidden ? null : grant.reason,
    startsAt: iso(grant.startsAt),
    expiresAt: iso(grant.expiresAt),
    endedAt: iso(grant.endedAt),
  };
}

/**
 * Break-glass on the team (spec D10): the banner of the team's audit view. Team admins see every
 * grant that gave an install admin access to the team, active ones first; each read under a grant
 * is in `/v1/team/audit` as `governance.break_glass.read`.
 */
export function teamBreakGlassRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.audit.read"));

  app.get("/", async (c) => {
    const grants = (await listTeamGrants(deps.database.db, c.get("team").id)).map(teamGrantJson);
    return c.json({
      active: grants.filter((g) => g.status === "active"),
      recent: grants.filter((g) => g.status !== "active"),
    });
  });

  return app;
}
