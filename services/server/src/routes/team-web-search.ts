import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { readTeamWebSearch, setTeamWebSearch } from "../web-search/store.js";

const bodySchema = z.strictObject({ enabled: z.boolean() });

/**
 * Team web search opt-in (`/v1/team/web-search`, KOBE-113). Members see whether the install offers
 * web search and whether the team turned it on; team admins turn it on or off. Off by default.
 * The `web_search` tool that honors it is KOBE-114.
 */
export function teamWebSearchRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json(await readTeamWebSearch(db, c.get("team").id)),
  );

  app.put("/", requireTeamPermission("team.connectors.manage"), async (c) => {
    const body = await parseBody(c, bodySchema);
    if (!body) return invalidRequest(c, "Send enabled (true or false).");
    const result = await setTeamWebSearch(db, c.get("team").id, body.enabled, c.get("user").id);
    return result.ok
      ? c.json(result.view)
      : c.json(
          {
            code: "web_search_unavailable",
            message: "The install admin has not enabled a web search provider.",
          },
          409,
        );
  });

  return app;
}
