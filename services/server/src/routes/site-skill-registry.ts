import { registrySettingsUpdateSchema } from "@kobe/protocol";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { readRegistrySettings, updateRegistrySettings } from "../skills/registry/settings.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Registry settings (`/v1/site/skills/registry/settings`, KOBE-330, SK20, SK21): Site Owner and
 * Admins read and change them; Skill reviewers can't (SK22). Each change is audited.
 */
export function siteSkillRegistryRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use("/settings", requireSitePermission("site.skills.catalog.manage"));

  app.get("/settings", async (c) => c.json(await readRegistrySettings(db)));

  app.put("/settings", async (c) => {
    const body = await parseBody(c, registrySettingsUpdateSchema);
    if (!body) return invalidRequest(c, "Send at least one valid Registry setting.");
    const r = await updateRegistrySettings(db, body, c.get("user").id);
    if (r.ok) return c.json(r.settings);
    return c.json({ code: r.code, message: r.message }, 400);
  });

  return app;
}
