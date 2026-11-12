import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auditSystemContext, currentAuditContext } from "../audit/context.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { authenticateScim, bearerOf, type ScimCaller } from "../sso/scim-tokens.js";
import { scimError, scimJson } from "../sso/scim/errors.js";
import { parsePaging, parseUserFilter } from "../sso/scim/filter.js";
import {
  listResponse,
  scimBaseUrl,
  serviceProviderConfig,
  userResource,
  userResourceType,
  userSchema,
} from "../sso/scim/resources.js";
import {
  SCIM_AUTH_FAILURES_PER_MINUTE,
  SCIM_MAX_BODY_BYTES,
  SCIM_REQUESTS_PER_TOKEN_PER_MINUTE,
  USER_SCHEMA,
} from "../sso/scim/schemas.js";
import { parsePatch, parseUserResource } from "../sso/scim/user-input.js";
import {
  createScimUser,
  deleteScimUser,
  getScimUser,
  listScimUsers,
  updateScimUser,
  type ScimContext,
  type ScimFailure,
} from "../sso/scim/users.js";

type ScimEnv = { Variables: { scim: ScimCaller } };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BODY_TYPES = /^application\/(scim\+)?json\s*(;|$)/i;

function unauthorized(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="kobe-scim"');
  return scimError(c, 401, "A valid SCIM token for this provider is required.");
}

const sendFailure = (c: Context, f: ScimFailure) => scimError(c, f.status, f.detail, f.scimType);

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

/**
 * SCIM 2.0 for one provider at `/v1/scim/v2/<slug>` (KOBE-631, spec sso-oidc-scim §10, SSO5):
 * discovery (`ServiceProviderConfig`, `ResourceTypes`, `Schemas`) and `Users`. Groups are SSO-8
 * (KOBE-632). Mounted outside the session API: only the provider's SCIM bearer token authenticates
 * (cookies are never read, so there is no CSRF surface), every response is `application/scim+json`,
 * every error RFC 7644 shaped. The kill switch (`auth.sso.enabled: false`) answers 404 for all of
 * it; a turned-off provider answers 403. Each token may make 600 requests a minute; failed
 * authentications are limited per client address. Audited as the system with the token row's id.
 */
export function scimRoutes(deps: ServerDeps): Hono<ScimEnv> {
  const db = deps.database.db;
  const app = new Hono<ScimEnv>();

  app.use(async (c, next) => {
    if (!deps.sso.settings.enabled) return scimError(c, 404, "Not found.");
    await next();
  });
  app.use(auditSystemContext(deps));
  app.use(
    bodyLimit({
      maxSize: SCIM_MAX_BODY_BYTES,
      onError: (c) => scimError(c, 413, "The request body is too large.", "tooMany"),
    }),
  );

  // Authentication: the bearer token of this slug's provider, nothing else.
  app.use("/:slug/*", async (c, next) => {
    const slug = c.req.param("slug");
    const token = bearerOf(c.req.header("authorization"));
    const caller = SLUG.test(slug) ? await authenticateScim(db, slug, token) : undefined;
    if (!caller) {
      const ip = currentAuditContext()?.ip ?? "unknown";
      const allowed = await hitRateLimit(db, `scim-auth-fail:${ip}`, {
        windowMs: 60_000,
        max: SCIM_AUTH_FAILURES_PER_MINUTE,
      });
      return allowed ? unauthorized(c) : scimError(c, 429, "Too many failed attempts.");
    }
    if (!caller.provider.enabled) {
      return scimError(
        c,
        403,
        "This provider is turned off in Kobe (Site console → Single sign-on).",
      );
    }
    const allowed = await hitRateLimit(db, `scim:${caller.credentialId}`, {
      windowMs: 60_000,
      max: SCIM_REQUESTS_PER_TOKEN_PER_MINUTE,
    });
    if (!allowed) {
      c.header("Retry-After", "60");
      return scimError(c, 429, "Too many requests for this token. Try again in a minute.");
    }
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      if (!BODY_TYPES.test(c.req.header("content-type") ?? "")) {
        return scimError(c, 415, "Send the body as application/scim+json.");
      }
    }
    c.set("scim", caller);
    await next();
  });

  const baseOf = (c: Context<ScimEnv>) => scimBaseUrl(deps.publicUrl, c.get("scim").provider.slug);
  const contextOf = (c: Context<ScimEnv>): ScimContext => ({
    db,
    lifecycle: deps.lifecycle,
    provider: c.get("scim").provider,
    credentialId: c.get("scim").credentialId,
  });

  app.get("/:slug/ServiceProviderConfig", (c) => scimJson(c, serviceProviderConfig(baseOf(c))));
  app.get("/:slug/ResourceTypes", (c) =>
    scimJson(c, listResponse([userResourceType(baseOf(c))], 1, 1)),
  );
  app.get("/:slug/ResourceTypes/:id", (c) =>
    c.req.param("id") === "User"
      ? scimJson(c, userResourceType(baseOf(c)))
      : scimError(c, 404, "No such resource type."),
  );
  app.get("/:slug/Schemas", (c) => scimJson(c, listResponse([userSchema(baseOf(c))], 1, 1)));
  app.get("/:slug/Schemas/:id", (c) =>
    c.req.param("id") === USER_SCHEMA
      ? scimJson(c, userSchema(baseOf(c)))
      : scimError(c, 404, "No such schema."),
  );

  app.get("/:slug/Users", async (c) => {
    const filter = parseUserFilter(c.req.query("filter"));
    if (!filter.ok) return scimError(c, 400, filter.detail, "invalidFilter");
    const paging = parsePaging(c.req.query("startIndex"), c.req.query("count"));
    const page = await listScimUsers(
      db,
      c.get("scim").provider.id,
      filter.filter,
      paging.startIndex,
      paging.count,
    );
    const base = baseOf(c);
    return scimJson(
      c,
      listResponse(
        page.rows.map((r) => userResource(r, base)),
        page.total,
        paging.startIndex,
      ),
    );
  });

  app.get("/:slug/Users/:id", async (c) => {
    const row = await getScimUser(db, c.get("scim").provider.id, c.req.param("id"));
    return row
      ? scimJson(c, userResource(row, baseOf(c)))
      : scimError(c, 404, "No such User for this provider.");
  });

  app.post("/:slug/Users", async (c) => {
    const input = parseUserResource(await jsonBody(c));
    if (!input.ok) return scimError(c, 400, input.detail, input.scimType);
    const created = await createScimUser(contextOf(c), input.value);
    if (!created.ok) return sendFailure(c, created);
    const resource = userResource(created.value, baseOf(c));
    c.header("Location", resource.meta.location);
    return scimJson(c, resource, 201);
  });

  app.put("/:slug/Users/:id", async (c) => {
    const input = parseUserResource(await jsonBody(c));
    if (!input.ok) return scimError(c, 400, input.detail, input.scimType);
    const updated = await updateScimUser(contextOf(c), c.req.param("id"), input.value, "put");
    return updated.ok
      ? scimJson(c, userResource(updated.value, baseOf(c)))
      : sendFailure(c, updated);
  });

  app.patch("/:slug/Users/:id", async (c) => {
    const changes = parsePatch(await jsonBody(c));
    if (!changes.ok) return scimError(c, 400, changes.detail, changes.scimType);
    const updated = await updateScimUser(contextOf(c), c.req.param("id"), changes.value, "patch");
    return updated.ok
      ? scimJson(c, userResource(updated.value, baseOf(c)))
      : sendFailure(c, updated);
  });

  app.delete("/:slug/Users/:id", async (c) => {
    const deleted = await deleteScimUser(contextOf(c), c.req.param("id"));
    return deleted.ok ? c.body(null, 204) : sendFailure(c, deleted);
  });

  // Anything else under the SCIM base (Groups until SSO-8, /Me, /Bulk): a SCIM 404, never the
  // session API behind it.
  app.all("*", (c) => scimError(c, 404, "Not found."));
  return app;
}
