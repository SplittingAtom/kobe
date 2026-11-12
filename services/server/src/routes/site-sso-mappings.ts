import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  createMapping,
  deleteMapping,
  listSiteMappings,
  parseCreateMapping,
} from "../sso/mappings.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

const NOT_FOUND = {
  provider_not_found: "No single sign-on provider with that id.",
  team_not_found: "No team with that id.",
  mapping_not_found: "No such mapping for this provider.",
} as const;

/**
 * Access mappings of the single sign-on providers (KOBE-627, spec sso-oidc-scim §7), under
 * `/v1/site/sso`: IdP value → team and team role, `site.users.manage` only. A mapping change
 * applies to each linked person at their next SSO sign-in (SCIM-known people once SCIM lands).
 * Provider configuration itself is KOBE-626's (`/v1/site/sso/providers`).
 */
export function siteSsoMappingRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  // Per route, not `app.use`: this app shares the `/site/sso` prefix with KOBE-626's routes.
  const manage = requireSitePermission("site.users.manage");

  app.get("/mappings", manage, async (c) => {
    const raw = c.req.query("providerId");
    const providerId = raw === undefined ? undefined : idSchema.safeParse(raw);
    if (providerId !== undefined && !providerId.success) return invalidRequest(c);
    return c.json({ ...(await listSiteMappings(db, providerId?.data)), appliesAt: "next_sign_in" });
  });

  app.post("/providers/:providerId/mappings", manage, async (c) => {
    const providerId = idSchema.safeParse(c.req.param("providerId"));
    if (!providerId.success) return invalidRequest(c);
    const body = parseCreateMapping(await c.req.json().catch(() => null));
    if (!body.ok) {
      return body.error === "site_role_not_mappable"
        ? c.json(
            {
              code: body.error,
              message:
                "Mappings grant team roles only (member, contributor, team admin). Site roles are given in Site roles.",
            },
            400,
          )
        : invalidRequest(c, "claimValue, teamId and a team role are required.");
    }
    const result = await createMapping(db, providerId.data, body.value, c.get("user").id);
    if (!result.ok) {
      return result.error === "mapping_exists"
        ? c.json({ code: result.error, message: "That value already maps to this team." }, 409)
        : c.json({ code: result.error, message: NOT_FOUND[result.error] }, 404);
    }
    return c.json({ mapping: result.mapping, appliesAt: "next_sign_in" }, 201);
  });

  app.delete("/providers/:providerId/mappings/:mappingId", manage, async (c) => {
    const providerId = idSchema.safeParse(c.req.param("providerId"));
    const mappingId = idSchema.safeParse(c.req.param("mappingId"));
    if (!providerId.success || !mappingId.success) return invalidRequest(c);
    if (!(await deleteMapping(db, providerId.data, mappingId.data))) {
      return c.json({ code: "mapping_not_found", message: NOT_FOUND.mapping_not_found }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
