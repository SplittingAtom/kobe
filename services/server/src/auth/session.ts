import { createMiddleware } from "hono/factory";
import { eq, siteRoles, siteSettings, users, type KobeDb } from "@kobe/db";
import type { SiteRole } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { DELEGATED_SESSION_PREFIX, delegationOf } from "../kobe-mcp/delegation.js";
import { delegationBacked } from "../kobe-mcp/delegation-live.js";

export type { SiteRole } from "../authz/permissions.js";

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly twoFactorEnabled: boolean;
}

export interface AuthVariables {
  user: SessionUser;
  /** The Better Auth session row id (the active team hangs off it, spec D9). */
  sessionId: string;
  siteRole: SiteRole;
}

export const REQUIRE_TWO_FACTOR = "require_2fa";

export async function readRequireTwoFactor(deps: ServerDeps): Promise<boolean> {
  return readRequireTwoFactorIn(deps.database.db);
}

/** The site's `require_2fa` setting, for code that has only the database (the SSO plugin). */
export async function readRequireTwoFactorIn(db: KobeDb): Promise<boolean> {
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, REQUIRE_TWO_FACTOR));
  return row?.value === "true";
}

/**
 * Requires a live Better Auth session (looked up in Postgres on every request, so revocation is
 * immediate) and, when the site requires 2FA, an enrolled TOTP factor. Enrollment itself goes
 * through /api/auth/two-factor/*, which this middleware does not guard.
 */
export function requireSession(deps: ServerDeps) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    // A Kobe MCP admin tool's in-process call (KOBE-619, KA1): the person of the run, re-read
    // here exactly like a session's user (deactivation, site role, the site's 2FA requirement).
    // Only the executor can mint one (`kobe-mcp/delegation.ts`); nothing on the wire can.
    const delegation = delegationOf(c);
    if (delegation !== undefined) {
      const [person] = await deps.database.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          twoFactorEnabled: users.twoFactorEnabled,
          deactivatedAt: users.deactivatedAt,
          role: siteRoles.role,
        })
        .from(users)
        .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
        .where(eq(users.id, delegation.userId));
      if (!person || person.deactivatedAt !== null) {
        return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
      }
      // The run is still active and the person's sign-in from its start still live (review M1).
      if (!(await delegationBacked(deps.database.db, delegation))) {
        return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
      }
      if (!person.twoFactorEnabled && (await readRequireTwoFactor(deps))) {
        return c.json(
          {
            code: "two_factor_enrollment_required",
            message: "This site requires two-factor authentication.",
          },
          403,
        );
      }
      c.set("user", {
        id: person.id,
        email: person.email,
        name: person.name,
        twoFactorEnabled: person.twoFactorEnabled,
      });
      c.set("sessionId", `${DELEGATED_SESSION_PREFIX}${delegation.runId}`);
      c.set("siteRole", person.role ?? null);
      return next();
    }
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
    // Re-read per request: a deactivation or role change applies to the very next request.
    const [account] = await deps.database.db
      .select({ deactivatedAt: users.deactivatedAt, role: siteRoles.role })
      .from(users)
      .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
      .where(eq(users.id, session.user.id));
    if (!account || account.deactivatedAt !== null) {
      // Sessions are deleted on deactivation; this catches anything that slipped through.
      await deps.revokeAllSessions(session.user.id);
      return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
    }
    const user: SessionUser = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      twoFactorEnabled: session.user.twoFactorEnabled === true,
    };
    if (!user.twoFactorEnabled && (await readRequireTwoFactor(deps))) {
      return c.json(
        {
          code: "two_factor_enrollment_required",
          message: "This site requires two-factor authentication.",
        },
        403,
      );
    }
    c.set("user", user);
    c.set("sessionId", session.session.id);
    c.set("siteRole", account.role ?? null);
    await next();
  });
}
