import { createMiddleware } from "hono/factory";
import {
  eq,
  sessions,
  sessionSsoContexts,
  siteRoles,
  siteSettings,
  ssoProviders,
  users,
  type KobeDb,
} from "@kobe/db";
import type { SiteRole } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { DELEGATED_SESSION_PREFIX, delegationOf } from "../kobe-mcp/delegation.js";
import { delegationBacked } from "../kobe-mcp/delegation-live.js";
import { hasLocalPassword } from "./reset-links.js";

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

const TWO_FACTOR_ENROLLMENT_REQUIRED = {
  code: "two_factor_enrollment_required",
  message: "This site requires two-factor authentication.",
} as const;

/** An SSO session whose sign-in did not prove MFA, on a site that requires 2FA (SSO7). */
const SSO_MFA_MISSING = {
  code: "mfa_missing",
  message:
    "Your organization's sign-in did not include multi-factor authentication, which this site requires. Sign out and sign in again with multi-factor authentication, or ask your administrator about Conditional Access.",
} as const;

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
 * immediate) and, when the site requires 2FA, an enrolled TOTP factor (local sessions) or an IdP
 * MFA proof (SSO sessions, `session_sso_contexts.mfa_satisfied`). Enrollment itself goes through
 * /api/auth/two-factor/*, which this middleware does not guard; auth.ts refuses it from an SSO
 * session without MFA proof.
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
      if (
        !(await delegationBacked(deps.database.db, delegation, {
          ssoEnabled: deps.sso.settings.enabled,
        }))
      ) {
        return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
      }
      // require_2fa: a backing session must have passed 2FA as a cookie request would (KOBE-629,
      // review L1): local by enrolled TOTP, SSO only by its own MFA proof. The refusal code
      // follows the cookie path (review I2): enrolment for a person who can still enrol (a local
      // password, no TOTP yet), else the IdP's missing MFA.
      if (
        (await readRequireTwoFactor(deps)) &&
        !(await delegationBacked(deps.database.db, delegation, {
          ssoEnabled: deps.sso.settings.enabled,
          ssoMfaProof: true,
        }))
      ) {
        const canEnrol =
          !person.twoFactorEnabled && (await hasLocalPassword(deps.database.db, person.id));
        return c.json(canEnrol ? TWO_FACTOR_ENROLLMENT_REQUIRED : SSO_MFA_MISSING, 403);
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
    // Re-read per request: a deactivation or role change applies to the very next request. The
    // session's SSO context (if any) comes along: the kill switch and max_session_hours (§9).
    const [account] = await deps.database.db
      .select({
        deactivatedAt: users.deactivatedAt,
        role: siteRoles.role,
        ssoProviderId: sessionSsoContexts.providerId,
        ssoMfaSatisfied: sessionSsoContexts.mfaSatisfied,
        maxSessionHours: ssoProviders.maxSessionHours,
      })
      .from(users)
      .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
      .leftJoin(sessionSsoContexts, eq(sessionSsoContexts.sessionId, session.session.id))
      .leftJoin(ssoProviders, eq(ssoProviders.id, sessionSsoContexts.providerId))
      .where(eq(users.id, session.user.id));
    if (!account || account.deactivatedAt !== null) {
      // Sessions are deleted on deactivation; this catches anything that slipped through.
      await deps.revokeAllSessions(session.user.id);
      return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
    }
    if (account.ssoProviderId !== null) {
      // auth.sso.enabled: false refuses every SSO session; local sessions are the break-glass
      // path (review finding 6). Start-up deletes them as well (`endSsoSessionsWhenOff`).
      if (!deps.sso.settings.enabled) {
        return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
      }
      // max_session_hours counts from the sign-in, whatever Better Auth's refresh did to the
      // expiry (review finding 9a).
      const hours = account.maxSessionHours;
      const started = new Date(session.session.createdAt).getTime();
      if (hours !== null && Date.now() - started >= hours * 3_600_000) {
        await deps.database.db.delete(sessions).where(eq(sessions.id, session.session.id));
        return c.json({ code: "unauthenticated", message: "Sign in to continue." }, 401);
      }
    }
    const user: SessionUser = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      twoFactorEnabled: session.user.twoFactorEnabled === true,
    };
    if (await readRequireTwoFactor(deps)) {
      // An SSO session counts only by its own sign-in's MFA proof (§8, SSO3): a Kobe TOTP factor
      // never stands in for it, and it is never sent to TOTP enrolment (SSO7). A local session
      // needs the enrolled factor, which its sign-in had to pass.
      if (account.ssoProviderId !== null) {
        if (account.ssoMfaSatisfied !== true) return c.json(SSO_MFA_MISSING, 403);
      } else if (!user.twoFactorEnabled) {
        return c.json(TWO_FACTOR_ENROLLMENT_REQUIRED, 403);
      }
    }
    c.set("user", user);
    c.set("sessionId", session.session.id);
    c.set("siteRole", account.role ?? null);
    await next();
  });
}
