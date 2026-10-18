import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { listSkillChoices, setEnablement } from "../skills/enablements.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const enablementSchema = z.strictObject({
  kind: z.enum(["personal", "team", "catalog"]),
  skillId: z.uuid(),
  enabled: z.boolean(),
});

/**
 * A member's own skill choices in the active team (`/v1/me/skills`, KOBE-316, SK25, SK27, D22):
 * `GET /enablements` lists their personal skills (on or off here), the team's skills and installs
 * with their access and whether they load for this member; `PUT /enablements` turns one on or off
 * for this member only, audited. Required and Hidden skills are not the member's to toggle (409).
 */
export function meSkillEnablementRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/enablements", requireTeamPermission("team.read"), async (c) =>
    c.json(await listSkillChoices(db, c.get("team").id, c.get("user").id)),
  );

  app.put("/enablements", requireTeamPermission("team.read"), async (c) => {
    const body = await parseBody(c, enablementSchema);
    if (!body) return invalidRequest(c, "Send kind, skillId and enabled: true or false.");
    const r = await setEnablement(db, {
      teamId: c.get("team").id,
      userId: c.get("user").id,
      ...body,
    });
    if (r.ok) return c.json({ enabled: r.enabled });
    return r.code === "not_found"
      ? c.json({ code: "not_found", message: "No such skill for you in this team." }, 404)
      : c.json(
          {
            code: "not_toggleable",
            message: "Required and Hidden skills are set by the team, not by each member.",
          },
          409,
        );
  });

  return app;
}
