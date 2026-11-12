import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import { listLinks, unlinkIdentity } from "../sso/linking.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

/**
 * The signed-in person's single sign-on links (`/v1/me/sso/links`, KOBE-630, spec sso-oidc-scim
 * §6, Me → Sign-in methods): list them and unlink one. Unlinking ends the sessions made through
 * that provider (this one too, when it is one of them) and is refused when the link is the only
 * way to sign in. With `auth.sso.enabled: false` every route answers 404.
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
