import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { CATALOG_SORTS, browseCatalog, catalogDetail } from "../skills/catalog-browse.js";
import { invalidRequest } from "../teams/http.js";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  tag: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/)
    .optional(),
  sort: z.enum(CATALOG_SORTS).optional(),
});
const idSchema = z.uuid();

/**
 * The Catalog tab (`/v1/skills/catalog`, KOBE-336, SK25): any member browses and searches the
 * catalog from the active team and opens a skill's detail with this team's egress check.
 */
export function skillCatalogRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) => {
    const q = querySchema.safeParse(c.req.query());
    if (!q.success)
      return invalidRequest(c, "q (text), tag (a topic tag) and sort (name, updated, teams).");
    const who = { teamId: c.get("team").id, userId: c.get("user").id };
    return c.json(
      await browseCatalog(db, who, {
        q: q.data.q ?? "",
        tag: q.data.tag ?? null,
        sort: q.data.sort ?? "name",
      }),
    );
  });

  app.get("/:skillId", requireTeamPermission("team.read"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const notFound = { code: "not_found", message: "No such catalog skill." };
    if (!id.success) return c.json(notFound, 404);
    const who = { teamId: c.get("team").id, userId: c.get("user").id, role: c.get("team").role };
    const detail = await catalogDetail(db, deps.blobs ?? null, who, id.data);
    return detail ? c.json(detail) : c.json(notFound, 404);
  });

  return app;
}
