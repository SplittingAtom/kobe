import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { jwt, twoFactor } from "better-auth/plugins";
import {
  accounts,
  jwks,
  passkeys,
  rateLimits,
  sessions,
  twoFactors,
  users,
  verifications,
  type KobeDb,
} from "@kobe/db";
import type { AuthAttemptAudit } from "../audit/attempts.js";
import { auditPlugin } from "../audit/auth-plugin.js";
import { recordAuditAfter } from "../audit/record.js";
import { logger } from "../logger.js";
import type { Mailer } from "../mail/mailer.js";
import { passwordResetMessage } from "../mail/messages.js";
import { isDeactivated } from "../users/deactivation.js";
import { invitationPlugin, PASSWORD_MAX, PASSWORD_MIN } from "./invitation-plugin.js";
import { recentResetLinkPending, recordResetLinkSent, revokeResetLinks } from "./reset-links.js";
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
}

/** Password-reset links work once, for 30 minutes. */
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

const ACCOUNT_DEACTIVATED = {
  code: "ACCOUNT_DEACTIVATED",
  message: "This account is deactivated. Ask an install admin to reactivate it.",
};

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
}: AuthOptions) {
  const origin = new URL(publicUrl);

  /**
   * Mails a reset link, off the request path: the response (and its timing) is the same whether or
   * not the address has an account. Deactivated accounts get nothing; while a link mailed in the last
   * few minutes is still valid no other is sent (mail bombing through many IPs). The token travels in the URL fragment, which browsers never send to
   * servers or proxies (no token in access logs).
   */
  async function mailResetLink(user: { id: string; email: string }, token: string) {
    if (await isDeactivated(db, user.id)) return;
    // Not awaited: the email must not wait on the audit write (it never throws). Aggregated:
    // anyone can request resets for an address in any number.
    void attempts.record({ action: "auth.password.reset_requested", userId: user.id });
    // A recent link is still usable: don't send another (soft; never blocks a later request).
    if (await recentResetLinkPending(db, user.id)) return;
    await mailer.send(
      passwordResetMessage({
        to: user.email,
        link: `${origin.origin}/reset-password#token=${token}`,
        expiresInMinutes: RESET_TOKEN_TTL_SECONDS / 60,
      }),
    );
    // Only a delivered email counts.
    await recordResetLinkSent(db, user.id, token);
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
        void mailResetLink(user, token).catch((err: unknown) =>
          logger.error({ err, userId: user.id }, "password reset email failed"),
        );
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
      twoFactor({ issuer: "Kobe" }),
      passkey({
        rpID: origin.hostname,
        rpName: "Kobe",
        origin: origin.origin,
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
      }),
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
