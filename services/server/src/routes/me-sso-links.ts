import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import { DELEGATED_SESSION_PREFIX } from "../kobe-mcp/delegation.js";
import { linkByLocalProof, listLinks, unlinkIdentity } from "../sso/linking.js";
import { readPendingLink, takePendingLink } from "../sso/pending-link.js";
import { eq, ssoProviders } from "@kobe/db";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

/**
 * The signed-in person's single sign-on links (`/v1/me/sso/links`, KOBE-630, spec sso-oidc-scim
 * §6, Me → Sign-in methods): list them and unlink one. Unlinking ends the sessions made through
 * that provider (this one too, when it is one of them) and is refused when the link is the only
 * way to sign in. `/v1/me/sso/pending-link` is the confirmation step of a local proof (review
 * M1): GET names the provider and address staged for this session, POST `/confirm` links it,
 * DELETE drops it. State changes are same-origin only (the API's CSRF check); a delegated (Kobe
 * MCP) session never sees or confirms one. With `auth.sso.enabled: false` every route answers 404.
 */
export function meSsoLinkRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(async (c, next) => {
    if (!deps.sso.settings.enabled) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/links", async (c) => c.json({ links: await listLinks(db, c.get("user").id) }));

  /** The browser session's own id; undefined for a delegated (Kobe MCP) session. */
  const browserSession = (c: { get(key: "sessionId"): string }) => {
    const id = c.get("sessionId");
    return id.startsWith(DELEGATED_SESSION_PREFIX) ? undefined : id;
  };
  const noPending = { code: "not_found", message: "No link is waiting for confirmation." };

  app.get("/pending-link", async (c) => {
    const sessionId = browserSession(c);
    const pending = sessionId ? await readPendingLink(db, sessionId, c.get("user").id) : undefined;
    if (!pending) return c.json({ pending: null });
    const [provider] = await db
      .select({ name: ssoProviders.displayName })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, pending.providerId));
    if (!provider) return c.json({ pending: null });
    return c.json({
      pending: {
        providerId: pending.providerId,
        providerName: provider.name,
        email: pending.email,
      },
    });
  });

  app.post("/pending-link/confirm", async (c) => {
    const sessionId = browserSession(c);
    const userId = c.get("user").id;
    const pending = sessionId ? await takePendingLink(db, sessionId, userId) : undefined;
    if (!pending) return c.json(noPending, 404);
    const outcome = await linkByLocalProof(db, pending, userId, { commit: true });
    if (outcome !== "linked") {
      return c.json(
        {
          code: "link_not_possible",
          message: "This sign-in can no longer be linked. Start again from the sign-in page.",
        },
        409,
      );
    }
    return c.json({ linked: true, providerId: pending.providerId });
  });

  app.delete("/pending-link", async (c) => {
    const sessionId = browserSession(c);
    const pending = sessionId ? await takePendingLink(db, sessionId, c.get("user").id) : undefined;
    if (!pending) return c.json(noPending, 404);
    return c.json({ discarded: true });
  });

  app.delete("/links/:providerId", async (c) => {
    const providerId = idSchema.safeParse(c.req.param("providerId"));
    if (!providerId.success) return invalidRequest(c);
    const result = await unlinkIdentity(db, {
      userId: c.get("user").id,
      providerId: providerId.data,
      by: "user",
    });
    if (result.ok) return c.json({ unlinked: true, sessionsEnded: result.sessionsEnded });
    return result.failure === "not_linked"
      ? c.json({ code: "not_found", message: "Not linked to this provider." }, 404)
      : c.json(
          {
            code: "last_sign_in_method",
            message:
              "This is your only way to sign in to Kobe, so it can't be unlinked. Ask a site admin.",
          },
          409,
        );
  });

  return app;
}
