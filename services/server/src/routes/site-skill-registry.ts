import { registrySettingsUpdateSchema, registryTeamCreateSchema } from "@kobe/protocol";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission, requireSkillReview } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  createRegistryTeam,
  readRegistrySettings,
  updateRegistrySettings,
} from "../skills/registry/settings.js";
import { invalidRequest, parseBody } from "../teams/http.js";

/**
 * Registry settings (`/v1/site/skills/registry/settings`, KOBE-330, SK20, SK21): Site Owner and
 * Admins read and change them; Skill reviewers can't (SK22). Each change is audited.
 */
export function siteSkillRegistryRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use("/settings", requireSitePermission("site.skills.catalog.manage"));
  app.use("/team", requireSitePermission("site.skills.catalog.manage"));

  // The dedicated Registry team (review H1): created here, never an existing team named.
  app.post("/team", async (c) => {
    const body = await parseBody(c, registryTeamCreateSchema);
    if (!body) return invalidRequest(c, "Send the team's name and slug.");
    const r = await createRegistryTeam(db, body, c.get("user").id);
    if (r.ok) return c.json(r.settings, 201);
    return c.json({ code: r.code, message: r.message }, 409);
  });

  app.get("/settings", async (c) => c.json(await readRegistrySettings(db)));

  // Whether the Registry is ready (SK21), for everyone who sees the queue (KOBE-331).
  app.get("/status", requireSkillReview(deps, "queue.read"), async (c) => {
    const s = await readRegistrySettings(db);
    return c.json({ ready: s.ready, registryTeam: s.registryTeam });
  });

  app.put("/settings", async (c) => {
    const body = await parseBody(c, registrySettingsUpdateSchema);
    if (!body) return invalidRequest(c, "Send at least one valid Registry setting.");
    const r = await updateRegistrySettings(db, body, c.get("user").id);
    if (r.ok) return c.json(r.settings);
    return c.json({ code: r.code, message: r.message }, 400);
  });

  return app;
}
