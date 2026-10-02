import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, twoFactor } from "better-auth/plugins";
import {
  accounts,
  jwks,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
  type KobeDb,
} from "@kobe/db";

export interface AuthOptions {
  readonly db: KobeDb;
  /** Public origin of the install, e.g. https://kobe.example.com (WebAuthn RP origin). */
  readonly publicUrl: string;
  /** Secret for cookie signing and encrypting JWT private keys (>= 32 chars). */
  readonly secret: string;
}

/**
 * Better Auth embedded in the server (spec D7): invite-only email + password (no sign-up),
 * WebAuthn passkeys, TOTP 2FA, and short-lived JWTs for API calls. Sessions live in Postgres and
 * are looked up on every request (no cookie cache), so revoking one takes effect immediately.
 */
export function createAuth({ db, publicUrl, secret }: AuthOptions) {
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
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: { cookieCache: { enabled: false } },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: origin.protocol === "https:",
    },
    telemetry: { enabled: false },
    plugins: [
      twoFactor({ issuer: "Kobe" }),
      passkey({ rpID: origin.hostname, rpName: "Kobe", origin: origin.origin }),
      jwt({ jwt: { expirationTime: "5m", issuer: origin.origin, audience: origin.origin } }),
    ],
  });
}

export type KobeAuth = ReturnType<typeof createAuth>;
