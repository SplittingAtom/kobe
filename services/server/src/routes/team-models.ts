import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { aliasSchema, teamModelSchema } from "../models/schemas.js";
import { listTeamModels, setTeamModel } from "../models/team-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Team models (`/v1/team/models`, spec D6, D8, D30). Every member sees the catalog and what the
 * team enabled (agents name these aliases); team admins enable a subset and choose the default.
 */
export function teamModelsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) => {
    const models = await listTeamModels(db, c.get("team").id);
    return c.json({ models, default: models.find((m) => m.is_default)?.alias ?? null });
  });

  app.put("/:alias", requireTeamPermission("team.models.manage"), async (c) => {
    const alias = aliasSchema.safeParse(c.req.param("alias"));
    const input = await parseBody(c, teamModelSchema);
    if (!input) return invalidRequest(c, 'Send {"enabled": true|false, "is_default"?: true}.');
    const result = alias.success
      ? await setTeamModel(db, c.get("team").id, alias.data, input, c.get("user").id)
      : "not_in_catalog";
    if (result === "not_in_catalog") {
      return c.json(
        { code: "model_not_found", message: "That model is not in the install's catalog." },
        404,
      );
    }
    if (result === "default_requires_enabled") {
      return invalidRequest(c, "Only an enabled model can be the team's default.");
    }
    const models = await listTeamModels(db, c.get("team").id);
    return c.json({ models, default: models.find((m) => m.is_default)?.alias ?? null });
  });

  return app;
}
