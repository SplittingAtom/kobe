import { Hono, type Context } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { domainPatternSchema } from "../egress/schemas.js";
import { disableTeamDomain, enableTeamDomain, listTeamEgress } from "../egress/team-store.js";

const notFound = (c: Context) =>
  c.json({ code: "domain_not_found", message: "That domain is not enabled." }, 404);

/**
 * Team egress (`/v1/team/egress`, spec D6, D8, D28). Every member can see what the team's sandboxes
 * may reach (it explains blocked requests); only team admins enable or disable domains, and only
 * within the install ceiling. Members never self-allow (D28); access requests are KOBE-39.
 */
export function teamEgressRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json({ domains: await listTeamEgress(db, c.get("team").id) }),
  );

  app.put("/domains/:domain", requireTeamPermission("team.egress.manage"), async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) {
      return c.json(
        { code: "not_in_ceiling", message: "That domain is not in the install's egress ceiling." },
        409,
      );
    }
    const result = await enableTeamDomain(db, c.get("team").id, domain.data, c.get("user").id);
    if (result === "not_in_ceiling") {
      return c.json(
        {
          code: "not_in_ceiling",
          message: "That domain is not in the install's egress ceiling. Ask an install admin.",
        },
        409,
      );
    }
    return c.json({ domain: domain.data, enabled: true }, result === "enabled" ? 201 : 200);
  });

  app.delete("/domains/:domain", requireTeamPermission("team.egress.manage"), async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    return (await disableTeamDomain(db, c.get("team").id, domain.data))
      ? c.body(null, 204)
      : notFound(c);
  });

  return app;
}
