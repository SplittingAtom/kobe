import type { Context, Hono } from "hono";
import type { KobeDb, TeamRole } from "@kobe/db";
import { teamRoleAllows } from "../authz/permissions.js";
import { agentFeedbackTotals } from "../feedback/totals.js";
import { parseUsageRange } from "../routes/usage.js";
import { forbidden, invalidRequest, notFound } from "./http.js";
import type { ResolvedAgent } from "./version-routes.js";

export interface FeedbackTotalsRouteOptions {
  readonly db: KobeDb;
  /** The agent named by `:id` if the caller may see it; null → 404 (as for version reads). */
  readonly resolve: (c: Context) => Promise<ResolvedAgent | null>;
  readonly teamId: (c: Context) => string;
  readonly role: (c: Context) => TeamRole;
}

/**
 * Who reads an agent's answer ratings (KOBE-275): its owners and the team's admins. A team agent:
 * whoever may edit it (its builder-owner, team admins). A personal agent: its owner (only they see
 * it at all). A gallery agent has no owner in the team: team admins.
 */
export function mayReadFeedbackTotals(found: ResolvedAgent, role: TeamRole): boolean {
  switch (found.agent.scope) {
    case "team":
      return found.access.edit || teamRoleAllows(role, "team.agents.manage");
    case "personal":
      return found.access.see;
    case "gallery":
      return teamRoleAllows(role, "team.agents.manage");
  }
}

/**
 * `GET /v1/agents/{id}/feedback?from&to&bucket` (KOBE-275): the agent's per-version rating totals
 * in the active team (`from`/`to`/`bucket` as for usage: ISO times, default the last 30 days).
 * Counts only, no content (D5/D10), so it needs no break-glass and is not audited.
 */
export function mountFeedbackTotals<E extends { Variables: object }>(
  app: Hono<E>,
  options: FeedbackTotalsRouteOptions,
): void {
  app.get("/:id/feedback", async (c) => {
    const found = await options.resolve(c);
    if (!found) return notFound(c);
    if (!mayReadFeedbackTotals(found, options.role(c))) {
      return forbidden(c, "Only the agent's owners and team admins see its ratings.");
    }
    const range = parseUsageRange(c.req.query());
    if (typeof range === "string") return invalidRequest(c, range);
    return c.json(
      await agentFeedbackTotals(
        options.db,
        options.teamId(c),
        { scope: found.agent.scope, id: found.agent.id },
        range,
      ),
    );
  });
}
