import type { Context, Hono } from "hono";
import type { KobeDb, TeamRole } from "@kobe/db";
import { teamRoleAllows } from "../authz/permissions.js";
import { FEEDBACK_DEFAULT_WINDOW_DAYS, feedbackTotalsQuerySchema } from "@kobe/protocol";
import { agentFeedbackTotals } from "../feedback/totals.js";
import { forbidden, invalidRequest, notFound } from "./http.js";
import type { ResolvedAgent } from "./version-routes.js";

export interface FeedbackTotalsRouteOptions {
  readonly db: KobeDb;
  /** The agent named by `:id` if the caller may see it; null → 404 (as for version reads). */
  readonly resolve: (c: Context) => Promise<ResolvedAgent | null>;
  readonly teamId: (c: Context) => string;
  readonly role: (c: Context) => TeamRole;
  readonly userId: (c: Context) => string;
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
 * `GET /v1/agents/{id}/feedback?window=7|30|90` (KOBE-275): the agent's per-version rating totals
 * in the active team over the last 7, 30 (default) or 90 finished UTC days. Any other query is a
 * 400 (no custom ranges). Counts only, each over at least `FEEDBACK_MIN_RATERS` other raters, no
 * content (D5/D10), so it needs no break-glass and is not audited.
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
    // One window, once: a repeated parameter would read as its first value.
    const repeated = Object.values(c.req.queries()).some((values) => values.length > 1);
    const query = feedbackTotalsQuerySchema.safeParse(c.req.query());
    if (repeated || !query.success) {
      return invalidRequest(c, "Pick a window of the last 7, 30 or 90 days (window=7, 30 or 90).");
    }
    return c.json(
      await agentFeedbackTotals(
        options.db,
        options.teamId(c),
        options.userId(c),
        { scope: found.agent.scope, id: found.agent.id },
        query.data.window ?? FEEDBACK_DEFAULT_WINDOW_DAYS,
      ),
    );
  });
}
