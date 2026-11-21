import { Hono } from "hono";
import type { MemoryStewardList } from "@kobe/protocol";
import type { AuthVariables } from "../auth/session.js";
import {
  requireSitePermission,
  requireTeam,
  requireTeamPermission,
  type TeamVariables,
} from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  grantWorkspaceSteward,
  listSiteStewards,
  listWorkspaceStewards,
  revokeWorkspaceSteward,
} from "../memory/stewards.js";
import { idSchema } from "../teams/schemas.js";
import { invalidRequest, notFound, param } from "../http/request.js";

/**
 * Workspace memory stewards (`/v1/team/memory/stewards`, KOBE-380, SM19): Team admins list, give
 * and take the grant on the Workspace Members page. Any member can be made a steward, whatever
 * their role. Audited `memory.steward.granted/revoked`.
 */
export function teamMemoryStewardRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps), requireTeamPermission("team.members.manage"));

  app.get("/", async (c) => {
    const body: MemoryStewardList = {
      level: "team",
      stewards: await listWorkspaceStewards(db, c.get("team").id),
    };
    return c.json(body);
  });

  app.put("/:userId", async (c) => {
    const userId = param(c, "userId", idSchema);
    if (!userId.success) return invalidRequest(c, "userId must be a user id.");
    const r = await grantWorkspaceSteward(db, c.get("team").id, userId.data, c.get("user").id);
    if (!r.ok && r.code === "user_deactivated")
      return c.json(
        { code: "user_deactivated", message: "Reactivate the account before granting." },
        409,
      );
    if (!r.ok) return notFound(c, "user_not_found", "Not a member of this workspace.");
    return c.json(r.steward);
  });

  app.delete("/:userId", async (c) => {
    const userId = param(c, "userId", idSchema);
    if (!userId.success) return invalidRequest(c, "userId must be a user id.");
    if (!(await revokeWorkspaceSteward(db, c.get("team").id, userId.data)))
      return notFound(c, "not_found", "That member is not a memory steward.");
    return c.body(null, 204);
  });

  return app;
}

/**
 * Site memory stewards (`/v1/site/memory/stewards`): the `memory_steward` site grant, read like
 * the other grants; given and taken with `PUT/DELETE /v1/site/roles/grants/{userId}/memory_steward`.
 */
export function siteMemoryStewardRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.get("/", requireSitePermission("site.users.manage"), async (c) => {
    const body: MemoryStewardList = {
      level: "site",
      stewards: await listSiteStewards(deps.database.db),
    };
    return c.json(body);
  });
  return app;
}
