import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
export function createAuth({ db, publicUrl, secret, trustedProxies }: AuthOptions) {
  const origin = new URL(publicUrl);

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
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database" },
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
    ],
  });
}

export type KobeAuth = ReturnType<typeof createAuth>;
