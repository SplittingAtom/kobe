import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SESSION_TOKEN_AUDIENCES,
  acceptsAudience,
  sessionTokenClaimsSchema,
  type SessionTokenAudience,
  type SessionTokenClaims,
} from "@kobe/protocol";
import type { SessionKeys } from "./config.js";

/**
 * Sandbox session tokens (packages/protocol session-token.ts; settles its SPECULATIVE part):
 *
 * - Encoding: compact JWS, **HS256 only**. The header must be exactly {"alg":"HS256","typ":"JWT"}:
 *   `none`, any other algorithm and any extra header (kid, jku, x5u, jwk, crit) are rejected; the
 *   algorithm is never taken from the token.
 * - One key per audience (KOBE_SESSION_KEY_*). The server holds all four; each verifying service
 *   gets only its own, so a service can never mint a token another service accepts.
 * - TTL 15 minutes, no refresh token: a sandbox re-trades its bootstrap token (rotated by the
 *   kubelet, dead once the pod is gone) for fresh tokens before they expire.
 */
export const SESSION_TOKEN_TTL_SECONDS = 15 * 60;
const MAX_TOKEN_LENGTH = 4096;
const HEADER = { alg: "HS256", typ: "JWT" } as const;
const ENCODED_HEADER = Buffer.from(JSON.stringify(HEADER)).toString("base64url");
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface SandboxPrincipal {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
}

export type IssuedSessionTokens = {
  readonly expiresAt: Date;
  readonly tokens: Readonly<Record<SessionTokenAudience, string>>;
};

export class SessionTokenError extends Error {
  constructor(reason: string) {
    super(`invalid session token: ${reason}`);
    this.name = "SessionTokenError";
  }
}

const mac = (key: string, signingInput: string): Buffer =>
  createHmac("sha256", key).update(signingInput).digest();

export function signSessionToken(claims: SessionTokenClaims, key: string): string {
  const parsed = sessionTokenClaimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  const signingInput = `${ENCODED_HEADER}.${payload}`;
  return `${signingInput}.${mac(key, signingInput).toString("base64url")}`;
}

/** One token per audience for a sandbox, all expiring together. */
export function issueSessionTokens(
  principal: SandboxPrincipal,
  keys: SessionKeys,
  now: Date = new Date(),
): IssuedSessionTokens {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SESSION_TOKEN_TTL_SECONDS;
  const tokens = Object.fromEntries(
    SESSION_TOKEN_AUDIENCES.map((aud) => [
      aud,
      signSessionToken(
        {
          iss: "kobe-server",
          aud,
          sub: principal.sandboxId,
          team_id: principal.teamId,
          user_id: principal.userId,
          iat,
          exp,
          jti: randomBytes(18).toString("base64url"),
        },
        keys[aud],
      ),
    ]),
  ) as Record<SessionTokenAudience, string>;
  return { expiresAt: new Date(exp * 1000), tokens };
}

function decodeJson(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new SessionTokenError(`${what} is not JSON`);
  }
}

/**
 * Verifies integrity with the audience's own key, then the claims (schema, `aud`, `exp`, `iat`).
 * Liveness of `sub` for (team_id, user_id) is the caller's check (see the protocol contract).
 */
export function verifySessionToken(
  token: string,
  audience: SessionTokenAudience,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionTokenClaims {
  if (token.length > MAX_TOKEN_LENGTH) throw new SessionTokenError("too long");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    throw new SessionTokenError("not a compact JWS");
  }
  const [encodedHeader, payload, signature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader, "header");
  if (
    typeof header !== "object" ||
    header === null ||
    Array.isArray(header) ||
    Object.keys(header).length !== 2 ||
    (header as Record<string, unknown>).alg !== HEADER.alg ||
    (header as Record<string, unknown>).typ !== HEADER.typ
  ) {
    throw new SessionTokenError("header must be exactly HS256/JWT");
  }
  const expected = mac(key, `${encodedHeader}.${payload}`);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new SessionTokenError("bad signature");
  }
  const claims = sessionTokenClaimsSchema.safeParse(decodeJson(payload, "payload"));
  if (!claims.success) throw new SessionTokenError("claims do not match the contract");
  if (!acceptsAudience(claims.data, audience, nowSeconds)) {
    throw new SessionTokenError("wrong audience, expired or issued in the future");
  }
  return claims.data;
}
