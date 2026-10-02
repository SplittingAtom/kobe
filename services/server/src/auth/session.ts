import { createMiddleware } from "hono/factory";
import { eq, installRoles, installSettings, users } from "@kobe/db";
import type { InstallRole } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";

export type { InstallRole } from "../authz/permissions.js";

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
  installRole: InstallRole;
}

export const REQUIRE_TWO_FACTOR = "require_2fa";

export async function readRequireTwoFactor(deps: ServerDeps): Promise<boolean> {
  const [row] = await deps.database.db
    .select({ value: installSettings.value })
    .from(installSettings)
    .where(eq(installSettings.key, REQUIRE_TWO_FACTOR));
  return row?.value === "true";
}

/**
 * Requires a live Better Auth session (looked up in Postgres on every request, so revocation is
 * immediate) and, when the install requires 2FA, an enrolled TOTP factor. Enrollment itself goes
 * through /api/auth/two-factor/*, which this middleware does not guard.
 */
export function requireSession(deps: ServerDeps) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
    // Re-read per request: a deactivation or role change applies to the very next request.
    const [account] = await deps.database.db
      .select({ deactivatedAt: users.deactivatedAt, role: installRoles.role })
      .from(users)
      .leftJoin(installRoles, eq(installRoles.userId, users.id))
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
          message: "This install requires two-factor authentication.",
        },
        403,
      );
    }
    c.set("user", user);
    c.set("sessionId", session.session.id);
    c.set("installRole", account.role ?? null);
    await next();
  });
}
