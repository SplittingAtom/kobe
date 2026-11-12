import { Hono, type Context } from "hono";
import { eq, siteRoles, users } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  expectLink,
  listExpectations,
  listLinks,
  unlinkIdentity,
  withdrawExpectation,
  type ExpectationFailure,
} from "../sso/linking.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

type Ctx = Context<{ Variables: AuthVariables }>;

const EXPECTATION_REFUSALS: Record<
  ExpectationFailure,
  { status: 404 | 409; code: string; message: string }
> = {
  user_not_found: { status: 404, code: "user_not_found", message: "No Kobe user with that id." },
  provider_not_found: {
    status: 404,
    code: "not_found",
    message: "No such single sign-on provider.",
  },
  deactivated: {
    status: 409,
    code: "deactivated",
    message: "This account is deactivated. Reactivate it first.",
  },
  protected_user: {
    status: 409,
    code: "protected_user",
    message:
      "The Owner and the setup Owner are never linked by an expectation: they link by signing in with their own password or passkey.",
  },
  already_linked: {
    status: 409,
    code: "already_linked",
    message: "This user is already linked to an identity at this provider.",
  },
  domain_not_verified: {
    status: 409,
    code: "domain_not_verified",
    message:
      "The user's email domain is not one of the provider's verified domains. Add it to the provider's allowed email domains first.",
  },
};

/**
 * Account links in the Site console (`/v1/site/sso/users/:userId/...`, KOBE-630, spec
 * sso-oidc-scim §6), for `site.users.manage`: the user's linked identities and pending
 * expectations; **Expect SSO link** (PUT, 14 days, single use; needs the user's domain among the
 * provider's verified domains); withdraw it; and unlink (ends that provider's sessions of the
 * user; refused when it is their only way to sign in). As with deactivation, only the Owner acts
 * on Admins and the Owner. With `auth.sso.enabled: false` every route answers 404.
 */
export function siteSsoLinkRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
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

  /** The target user's id, or a refusal: unknown user, or an Admin/Owner acted on by a non-Owner. */
  async function target(c: Ctx): Promise<{ userId: string } | Response> {
    const parsed = idSchema.safeParse(c.req.param("userId"));
    if (!parsed.success) return invalidRequest(c);
    const [row] = await db
      .select({ id: users.id, role: siteRoles.role })
      .from(users)
      .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
      .where(eq(users.id, parsed.data));
    if (!row) return c.json({ code: "user_not_found", message: "No Kobe user with that id." }, 404);
    if (row.role !== null && row.id !== c.get("user").id && c.get("siteRole") !== "owner") {
      return c.json(
        { code: "forbidden", message: "Only the Owner changes the sign-in of an Admin." },
        403,
      );
    }
    return { userId: row.id };
  }

  const providerParam = (c: Ctx) => idSchema.safeParse(c.req.param("providerId"));

  app.get("/users/:userId/links", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    return c.json({
      links: await listLinks(db, t.userId),
      expectations: await listExpectations(db, t.userId),
    });
  });

  app.put("/users/:userId/link-expectations/:providerId", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const providerId = providerParam(c);
    if (!providerId.success) return invalidRequest(c);
    const result = await expectLink(db, {
      providerId: providerId.data,
      userId: t.userId,
      actorId: c.get("user").id,
    });
    if (!result.ok) {
      const r = EXPECTATION_REFUSALS[result.failure];
      return c.json({ code: r.code, message: r.message }, r.status);
    }
    return c.json({ expectation: result.expectation });
  });

  app.delete("/users/:userId/link-expectations/:providerId", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const providerId = providerParam(c);
    if (!providerId.success) return invalidRequest(c);
    const done = await withdrawExpectation(db, { providerId: providerId.data, userId: t.userId });
    if (!done) {
      return c.json({ code: "not_found", message: "No expected link for this provider." }, 404);
    }
    return c.json({ withdrawn: true });
  });

  app.delete("/users/:userId/links/:providerId", async (c) => {
    const t = await target(c);
    if (t instanceof Response) return t;
    const providerId = providerParam(c);
    if (!providerId.success) return invalidRequest(c);
    const result = await unlinkIdentity(db, {
      userId: t.userId,
      providerId: providerId.data,
      by: "admin",
    });
    if (result.ok) return c.json({ unlinked: true, sessionsEnded: result.sessionsEnded });
    return result.failure === "not_linked"
      ? c.json({ code: "not_found", message: "Not linked to this provider." }, 404)
      : c.json(
          {
            code: "last_sign_in_method",
            message:
              "This link is the account's only way to sign in. Deactivate the account instead.",
          },
          409,
        );
  });

  return app;
}
