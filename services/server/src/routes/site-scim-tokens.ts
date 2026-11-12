import { Hono, type Context } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { getProvider } from "../sso/providers.js";
import { scimBaseUrl } from "../sso/scim/resources.js";
import {
  createScimToken,
  listScimTokens,
  revokeScimToken,
  SCIM_MAX_LIVE_TOKENS,
} from "../sso/scim-tokens.js";
import { idSchema } from "../teams/schemas.js";

const notFound = (c: Context, what = "single sign-on provider") =>
  c.json({ code: "not_found", message: `No such ${what}.` }, 404);

const tooMany = (c: Context) =>
  c.json(
    {
      code: "too_many_tokens",
      message: `A provider has at most ${SCIM_MAX_LIVE_TOKENS} live SCIM tokens. Revoke the old one first.`,
    },
    409,
  );

/**
 * SCIM tokens of a provider (`/v1/site/sso/providers/:id/scim`, KOBE-631, spec sso-oidc-scim
 * §10), for `site.users.manage`: the SCIM base URL and the tokens (prefix, created, last used,
 * revoked; never the token or its hash); create (the token is in that one response, never again),
 * rotate (a second token while the first keeps working until revoked) and revoke. With
 * `auth.sso.enabled: false` every route answers 404.
 */
export function siteScimTokenRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(async (c, next) => {
    if (!deps.sso.settings.enabled) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(requireSitePermission("site.users.manage"));

  async function providerOf(c: Context) {
    const id = idSchema.safeParse(c.req.param("id"));
    return id.success ? getProvider(deps.sso.providers, id.data) : undefined;
  }

  app.get("/providers/:id/scim", async (c) => {
    const provider = await providerOf(c);
    if (!provider) return notFound(c);
    return c.json({
      baseUrl: scimBaseUrl(deps.publicUrl, provider.slug),
      tokens: await listScimTokens(db, provider.id),
    });
  });

  app.post("/providers/:id/scim/tokens", async (c) => {
    const provider = await providerOf(c);
    if (!provider) return notFound(c);
    const created = await createScimToken(db, provider.id, c.get("user").id);
    if (!created.ok) return created.failure === "not_found" ? notFound(c) : tooMany(c);
    return c.json(
      {
        token: created.token,
        credential: created.view,
        baseUrl: scimBaseUrl(deps.publicUrl, provider.slug),
      },
      201,
    );
  });

  /** Rotation: a new token beside the named live one, which keeps working until it is revoked. */
  app.post("/providers/:id/scim/tokens/:tokenId/rotate", async (c) => {
    const provider = await providerOf(c);
    if (!provider) return notFound(c);
    const tokenId = c.req.param("tokenId");
    const live = (await listScimTokens(db, provider.id)).find(
      (t) => t.id === tokenId && t.revokedAt === null,
    );
    if (!live) return notFound(c, "live SCIM token");
    const created = await createScimToken(db, provider.id, c.get("user").id);
    if (!created.ok) return created.failure === "not_found" ? notFound(c) : tooMany(c);
    return c.json(
      {
        token: created.token,
        credential: created.view,
        replaces: live.id,
        baseUrl: scimBaseUrl(deps.publicUrl, provider.slug),
      },
      201,
    );
  });

  app.post("/providers/:id/scim/tokens/:tokenId/revoke", async (c) => {
    const provider = await providerOf(c);
    if (!provider) return notFound(c);
    const tokenId = idSchema.safeParse(c.req.param("tokenId"));
    if (!tokenId.success) return notFound(c, "SCIM token");
    const revoked = await revokeScimToken(db, provider.id, tokenId.data);
    if (revoked.ok) return c.json({ credential: revoked.view });
    return revoked.failure === "not_found"
      ? notFound(c, "SCIM token")
      : c.json({ code: "already_revoked", message: "That token is already revoked." }, 409);
  });

  return app;
}
