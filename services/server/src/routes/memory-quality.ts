import { Hono } from "hono";
import { z } from "zod";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { listItemSignals, QUALITY_FILTERS } from "../memory/quality/items.js";
import { sitePassSignals, workspacePassSignals } from "../memory/quality/passes.js";
import { siteQueueHealth, workspaceQueueHealth } from "../memory/quality/queues.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";
import { invalidRequest } from "../http/request.js";

const workspaceItemsQuery = z.strictObject({
  scope: z.enum(["user", "team"]).default("team"),
  filter: z.enum(QUALITY_FILTERS).default("all"),
});
const siteItemsQuery = z.strictObject({ filter: z.enum(QUALITY_FILTERS).default("all") });

/**
 * Memory quality, Workspace side (`/v1/memory/quality`, KOBE-411): computed on read, never acted
 * on (nothing is archived by a flag).
 *
 * - `GET /items` `?scope=user|team&filter=all|check_this|unused`: runs received, last received,
 *   thumbs-down runs and flags per active item; `user` = the caller's own, `team` = curators
 * - `GET /queues`: pending, oldest pending and median time to decision (curators)
 * - `GET /passes`: Learn's numbers over the last 30 days (curators)
 */
export function memoryQualityRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer } = memoryRouteKit(deps);

  app.get("/items", (c) => {
    const q = workspaceItemsQuery.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, issueText(q.error));
    return answer(c, q.data.scope, (who) => listItemSignals(db, who, q.data.scope, q.data.filter));
  });
  app.get("/queues", (c) => answer(c, "team", (who) => workspaceQueueHealth(db, who)));
  app.get("/passes", (c) => answer(c, "team", (who) => workspacePassSignals(db, who)));
  return app;
}

/**
 * Memory quality, Site side (`/v1/site/memory/quality`, KOBE-411): Site admins and Site memory
 * stewards. Numbers only cross the wall: Site items' use is summed over every Workspace, and
 * Learn's numbers are per Workspace without any thread-derived text.
 *
 * - `GET /items` `?filter=`: Site items (Policy included)
 * - `GET /queues`: Site proposals waiting for the Site
 * - `GET /passes`: totals and per Workspace
 */
export function siteMemoryQualityRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer } = memoryRouteKit(deps);

  app.get("/items", (c) => {
    const q = siteItemsQuery.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, issueText(q.error));
    return answer(c, "site", (who) => listItemSignals(db, who, "site", q.data.filter));
  });
  app.get("/queues", (c) => answer(c, "site", (who) => siteQueueHealth(db, who)));
  app.get("/passes", (c) => answer(c, "site", (who) => sitePassSignals(db, who)));
  return app;
}
