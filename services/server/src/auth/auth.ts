import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { jwt, twoFactor } from "better-auth/plugins";
import {
  accounts,
  jwks,
  passkeys,
  rateLimits,
  eq,
  sessions,
  sessionSsoContexts,
  twoFactors,
  users,
  verifications,
  type KobeDb,
} from "@kobe/db";
import type { AuthAttemptAudit } from "../audit/attempts.js";
import { auditPlugin } from "../audit/auth-plugin.js";
import { recordAuditAfter } from "../audit/record.js";
import type { BackgroundTasks } from "../background.js";
import type { Mailer } from "../mail/mailer.js";
import { passwordResetMessage } from "../mail/messages.js";
import { readAppName } from "../branding/settings.js";
import { isDeactivated } from "../users/deactivation.js";
import { invitationPlugin, PASSWORD_MAX, PASSWORD_MIN } from "./invitation-plugin.js";
import {
  claimResetLinkSend,
  hasLocalPassword,
  releaseResetLinkClaim,
  revokeResetLinks,
} from "./reset-links.js";
import { ssoLinkPlugin } from "./sso-link-plugin.js";
import { ssoPlugin, SSO_RATE_LIMITS, type SsoRuntime } from "./sso-plugin.js";
import { isUserVerified } from "./webauthn-flags.js";

export interface AuthOptions {
  readonly db: KobeDb;
  /** Public origin of the install, e.g. https://kobe.example.com (WebAuthn RP origin). */
  readonly publicUrl: string;
  /**
   * Signs cookies and encrypts TOTP secrets, backup codes and JWT signing keys (>= 32 chars).
   * Rotating it without Better Auth's `secrets` versioning makes enrolled 2FA unusable.
   */
  readonly secret: string;
  /** Proxy CIDRs whose X-Forwarded-For entries are trusted (Traefik/LB); used for rate limits. */
  readonly trustedProxies: readonly string[];
  /** Sends password-reset emails (SMTP in production, in memory in tests). */
  readonly mailer: Mailer;
  /** Audit of unauthenticated attempts, aggregated per window (KOBE-15). */
  readonly attempts: AuthAttemptAudit;
  /** Runs the reset email and its audit off the request path. */
  readonly background: BackgroundTasks;
  /** OIDC single sign-on (KOBE-628); unset: no SSO routes at all. */
  readonly sso?: SsoRuntime;
}

/** Password-reset links work once, for 30 minutes. */
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

const ACCOUNT_DEACTIVATED = {
  code: "ACCOUNT_DEACTIVATED",
  message: "This account is deactivated. Ask a site admin to reactivate it.",
};

/**
 * Endpoints that add a local credential or factor to the signed-in account (SSO9, review finding 3):
 * refused for a user with no `credential` account (made by SSO JIT or SCIM), who signs in only
 * through the identity provider, so an IdP-side disable can never be outlived by a local passkey
 * or password. TOTP enrolment is refused too (it would be a Kobe factor the IdP doesn't govern).
 */
const LOCAL_CREDENTIAL_PATHS = new Set([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/register",
  "/change-password",
  "/two-factor/enable",
]);

const SSO_ONLY_ACCOUNT = {
  code: "SSO_ONLY_ACCOUNT",
  message:
    "This account signs in through your organization's identity provider and can't have a Kobe password, passkey or authenticator app.",
};

/**
 * Endpoints that add a credential or second factor (TOTP secret, its confirmation, backup codes,
 * a passkey, a new password): refused from an SSO session whose sign-in did not prove MFA (spec
 * sso-oidc-scim §8, SSO7, KOBE-629 and its review M1), so a stolen IdP password can never mint a
 * factor that later passes `require_2fa` through a local sign-in. A local session, or an SSO
 * session that proved MFA, is unaffected; the TOTP sign-in challenge carries no session.
 */
const MFA_GUARDED_PATHS = new Set([
  ...LOCAL_CREDENTIAL_PATHS,
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/generate-backup-codes",
]);

const SSO_MFA_REQUIRED = {
  code: "SSO_MFA_REQUIRED",
  message:
    "Your organization's sign-in did not include multi-factor authentication, so this session can't add a passkey, password or authenticator app. Sign in again with multi-factor authentication (your administrator sets it up with Conditional Access).",
};

/** The session is a single sign-on session whose sign-in did not prove MFA. */
async function ssoSessionWithoutMfa(db: KobeDb, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ mfaSatisfied: sessionSsoContexts.mfaSatisfied })
    .from(sessionSsoContexts)
    .where(eq(sessionSsoContexts.sessionId, sessionId));
  return row !== undefined && !row.mfaSatisfied;
}

/**
 * Endpoints that remove a local credential: refused from an SSO session of the setup Owner
 * (SSO10, KOBE-630), so no single sign-on path can take away the break-glass identity's password
 * or passkey. From a local session the Owner manages them as before.
 */
const LOCAL_CREDENTIAL_REMOVAL_PATHS = new Set(["/passkey/delete-passkey", "/unlink-account"]);

const SETUP_OWNER_LOCAL_ONLY = {
  code: "SETUP_OWNER_LOCAL_ONLY",
  message:
    "The setup Owner's password and passkeys can only be removed from a session signed in with them, not through single sign-on.",
};

/** The session is an SSO session of the setup Owner. */
async function setupOwnerSsoSession(
  db: KobeDb,
  session: { readonly id: string; readonly userId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ setupOwner: users.setupOwner })
    .from(sessionSsoContexts)
    .innerJoin(users, eq(users.id, session.userId))
    .where(eq(sessionSsoContexts.sessionId, session.id));
  return row?.setupOwner === true;
}

const PASSKEY_VERIFY_PATHS = new Set([
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
]);

/**
 * Better Auth embedded in the server (spec D7): invite-only email + password (no sign-up),
 * WebAuthn passkeys with required user verification, TOTP 2FA, and short-lived JWTs. Sessions live
 * in Postgres and are looked up on every request (no cookie cache), so revocation is immediate.
 * Rate limits are stored in Postgres so every replica shares them.
 */
export function createAuth({
  db,
  publicUrl,
  secret,
  trustedProxies,
  mailer,
  attempts,
  background,
  sso,
}: AuthOptions) {
  const origin = new URL(publicUrl);

  /**
   * Mails a reset link, off the request path: the response (and its timing) is the same whether or
   * not the address has an account. Deactivated accounts get nothing; while a link mailed in the last
   * few minutes is still valid no other is sent (mail bombing through many IPs). The token travels in the URL fragment, which browsers never send to
   * servers or proxies (no token in access logs). An account without a local password (provisioned
   * by SCIM or SSO, SSO9) gets nothing, and the unsent token is dropped: resetting would create a
   * password and get round the identity provider.
   */
  async function mailResetLink(user: { id: string; email: string }, token: string) {
    if (await isDeactivated(db, user.id)) return;
    // A user made by SSO (JIT) or SCIM has no password: a reset must not give them one, or the
    // mailbox could outlive the identity provider's disable (spec sso-oidc-scim §6, SSO9).
    if (!(await hasLocalPassword(db, user.id))) {
      await revokeResetLinks(db, user.id);
      return;
    }
    // Not awaited: the email must not wait on the audit write. Aggregated: anyone can request
    // resets for an address in any number.
    background.run("password reset audit failed", () =>
      attempts.record({ action: "auth.password.reset_requested", userId: user.id }),
    );
    // A recent link is still usable: don't send another (soft; never blocks a later request).
    if (!(await claimResetLinkSend(db, user.id, token))) return;
    try {
      await mailer.send(
        passwordResetMessage({
          appName: await readAppName(db),
          to: user.email,
          link: `${origin.origin}/reset-password#token=${token}`,
          expiresInMinutes: RESET_TOKEN_TTL_SECONDS / 60,
        }),
      );
    } catch (err) {
      // Only a delivered email counts.
      await releaseResetLinkClaim(db, user.id, token);
      throw err;
    }
  }

  return betterAuth({
    appName: "Kobe",
    baseURL: origin.origin,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [origin.origin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
        passkey: passkeys,
        jwks,
        rateLimit: rateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      // Single-use (consumed atomically), short-lived, and a reset ends every session.
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // The used link is consumed; any other mailed link dies with it.
      onPasswordReset: async ({ user }) => {
        await revokeResetLinks(db, user.id);
        await recordAuditAfter(db, {
          action: "auth.password.reset",
          actor: { kind: "user", id: user.id },
          target: { userId: user.id },
        });
      },
      sendResetPassword: async ({ user, token }) => {
        background.run("password reset email failed", () => mailResetLink(user, token), {
          userId: user.id,
        });
      },
    },
    // Reset tokens, 2FA and passkey challenges are stored as SHA-256 hashes, never in plain text.
    verification: { storeIdentifier: "hashed" },
    session: { cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/invitation/lookup": { window: 60, max: 10 },
        "/invitation/accept": { window: 60, max: 5 },
        ...SSO_RATE_LIMITS,
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Every sign-in method (password, TOTP, passkey, invitation) ends in a new session: refuse
          // it for deactivated users. A trigger on `sessions` backs this up against races.
          before: async (session) => {
            if (await isDeactivated(db, session.userId)) {
              throw new APIError("FORBIDDEN", ACCOUNT_DEACTIVATED);
            }
            return undefined;
          },
        },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: origin.protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: [...trustedProxies] },
    },
    telemetry: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (LOCAL_CREDENTIAL_PATHS.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx).catch(() => null);
          if (current && !(await hasLocalPassword(db, current.user.id))) {
            throw new APIError("FORBIDDEN", SSO_ONLY_ACCOUNT);
          }
        }
        if (MFA_GUARDED_PATHS.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx).catch(() => null);
          if (current && (await ssoSessionWithoutMfa(db, current.session.id))) {
            throw new APIError("FORBIDDEN", SSO_MFA_REQUIRED);
          }
        }
        if (LOCAL_CREDENTIAL_REMOVAL_PATHS.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx).catch(() => null);
          if (current && (await setupOwnerSsoSession(db, current.session))) {
            throw new APIError("FORBIDDEN", SETUP_OWNER_LOCAL_ONLY);
          }
        }
        // A passkey counts as a strong factor only with user verification (PIN/biometric).
        if (
          PASSKEY_VERIFY_PATHS.has(ctx.path) &&
          !isUserVerified((ctx.body as { response?: unknown })?.response)
        ) {
          throw new APIError("FORBIDDEN", {
            message: "Passkeys must use user verification (PIN or biometric).",
          });
        }
        // A changed password ends every other session (a stolen cookie must not survive it).
        if (ctx.path === "/change-password") {
          return {
            context: { ...ctx, body: { ...(ctx.body as object), revokeOtherSessions: true } },
          };
        }
        return undefined;
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A changed password also kills any reset link still in a mailbox.
        if (
          ctx.path === "/change-password" &&
          ctx.context.session &&
          !isAPIError(ctx.context.returned)
        ) {
          await revokeResetLinks(db, ctx.context.session.user.id);
        }
        // Turning 2FA off also ends every other session.
        if (ctx.path === "/two-factor/disable" && ctx.context.session) {
          const { user, session } = ctx.context.session;
          const others = (await ctx.context.internalAdapter.listSessions(user.id))
            .map((s) => s.token)
            .filter((t) => t !== session.token);
          if (others.length > 0) await ctx.context.internalAdapter.deleteSessions(others);
        }
      }),
    },
    plugins: [
      invitationPlugin({ db, publicOrigin: origin.origin }),
      ssoPlugin({ db, publicOrigin: origin.origin, secret, attempts, sso }),
      twoFactor({ issuer: "Kobe" }),
      passkey({
        rpID: origin.hostname,
        rpName: "Kobe",
        origin: origin.origin,
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
      }),
      // After the two-factor and passkey plugins: it must see whether a sign-in completed.
      ssoLinkPlugin({ db, publicOrigin: origin.origin, secret, settings: sso?.settings }),
      jwt({
        jwt: {
          expirationTime: "5m",
          issuer: origin.origin,
          audience: origin.origin,
          // Minimal claims; `sid` lets a verifier check the session still exists (revocation).
          definePayload: ({ user, session }) => ({
            sid: session.id,
            twoFactor: (user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true,
          }),
          getSubject: ({ user }) => user.id,
        },
      }),
      // Last: its after hook must see the session state the other plugins leave (KOBE-15).
      auditPlugin({ db, attempts }),
    ],
  });
}

export type KobeAuth = ReturnType<typeof createAuth>;
