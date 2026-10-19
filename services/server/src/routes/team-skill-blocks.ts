import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { dismissInstallRequests, listInstallRequests } from "../skills/install-requests.js";
import { listTeamMemberAdds } from "../skills/member-adds.js";
import { blockCatalogSkill, listTeamBlocks, unblockCatalogSkill } from "../skills/team-blocks.js";

const idSchema = z.uuid();
const NO_SKILL = { code: "not_found", message: "No catalog skill with that id." };

/**
 * The Team console's view of members and the Catalog (`/v1/team/skills`, KOBE-338, SK25), Team
 * admins only: the members' adds, the team's blocks (block removes the adds and refuses new ones;
 * an installed skill is uninstalled first), and members' Request for team, with Dismiss. Audited.
 */
export function teamSkillBlockRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  const manage = requireTeamPermission("team.skills.installs.manage");
  app.use(requireTeam(deps));

  app.get("/member-adds", manage, async (c) =>
    c.json({ adds: await listTeamMemberAdds(db, c.get("team").id) }),
  );

  app.get("/blocks", manage, async (c) =>
    c.json({ blocks: await listTeamBlocks(db, c.get("team").id) }),
  );

  app.put("/blocks/:skillId", manage, async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    if (!id.success) return c.json(NO_SKILL, 404);
    const r = await blockCatalogSkill(db, {
      teamId: c.get("team").id,
      skillId: id.data,
      userId: c.get("user").id,
    });
    if (r.ok) return c.json({ blocked: true, changed: r.changed, addsRemoved: r.addsRemoved });
    return r.code === "not_found"
      ? c.json(NO_SKILL, 404)
      : c.json(
          {
            code: "installed",
            message: "The team has this skill installed: uninstall it before blocking it.",
          },
          409,
        );
  });

  app.delete("/blocks/:skillId", manage, async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const done =
      id.success && (await unblockCatalogSkill(db, { teamId: c.get("team").id, skillId: id.data }));
    return done
      ? c.json({ blocked: false })
      : c.json({ code: "not_found", message: "The team doesn't block that skill." }, 404);
  });

  app.get("/install-requests", manage, async (c) =>
    c.json({ requests: await listInstallRequests(db, c.get("team").id) }),
  );

  app.post("/install-requests/:skillId/dismiss", manage, async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const done =
      id.success &&
      (await dismissInstallRequests(db, { teamId: c.get("team").id, skillId: id.data }));
    return done
      ? c.json({ dismissed: true })
      : c.json({ code: "not_found", message: "No open request for that skill." }, 404);
  });

  return app;
}
