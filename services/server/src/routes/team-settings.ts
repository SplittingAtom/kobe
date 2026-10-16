import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { readFollowupsEnabled, setFollowupsEnabled } from "../threads/followups.js";

const bodySchema = z.strictObject({ followups_enabled: z.boolean() });

/**
 * The team's chat settings (`/v1/team/settings`, KOBE-222): today the follow-up suggestions switch
 * (CE21, off by default). Every member can read it; team admins change it (`team.models.manage`:
 * follow-ups are model calls charged to the member), audited as `models.followups.changed`.
 */
export function teamSettingsRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json({ followups_enabled: await readFollowupsEnabled(db, c.get("team").id) }),
  );

  app.put("/", requireTeamPermission("team.models.manage"), async (c) => {
    const body = await parseBody(c, bodySchema);
    if (!body) return invalidRequest(c, "Send followups_enabled (true or false).");
    const enabled = await setFollowupsEnabled(db, c.get("team").id, body.followups_enabled);
    return c.json({ followups_enabled: enabled });
  });

  return app;
}
