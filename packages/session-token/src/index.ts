import { createHmac, timingSafeEqual } from "node:crypto";
import {
  acceptsAudience,
  sessionTokenClaimsSchema,
  type SessionTokenAudience,
  type SessionTokenClaims,
} from "@kobe/protocol";

/**
 * Sandbox session tokens (packages/protocol session-token.ts; KOBE-22 settled its SPECULATIVE part).
 * Shared by the server (which mints them) and every service that verifies them (egress proxy, MCP
 * proxy, model gateway), so all apply exactly the same rules:
 *
 * - Encoding: compact JWS, **HS256 only**. The header must be exactly {"alg":"HS256","typ":"JWT"}:
 *   `none`, any other algorithm and any extra header (kid, jku, x5u, jwk, crit) are rejected; the
 *   algorithm is never taken from the token.
 * - One key per audience (KOBE_SESSION_KEY_*). The server holds all four; each verifying service
 *   gets only its own, so a service can never mint a token another service accepts.
 * - TTL 15 minutes, no refresh token: a sandbox re-trades its bootstrap token for fresh tokens.
 */
export const SESSION_TOKEN_TTL_SECONDS = 15 * 60;
export const MAX_SESSION_TOKEN_LENGTH = 4096;
const HEADER = { alg: "HS256", typ: "JWT" } as const;
const ENCODED_HEADER = Buffer.from(JSON.stringify(HEADER)).toString("base64url");
const SEGMENT = /^[A-Za-z0-9_-]+$/;

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
  if (token.length > MAX_SESSION_TOKEN_LENGTH) throw new SessionTokenError("too long");
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
