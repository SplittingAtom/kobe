import {
  acceptsAudience,
  sessionTokenClaimsSchema,
  type SessionTokenAudience,
  type SessionTokenClaims,
} from "@kobe/protocol";
import { SessionTokenError, signJws, verifyJws } from "./jws.js";

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
export { MAX_SESSION_TOKEN_LENGTH, SessionTokenError } from "./jws.js";
export * from "./site.js";

export function signSessionToken(claims: SessionTokenClaims, key: string): string {
  return signJws(sessionTokenClaimsSchema.parse(claims), key);
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
  const payload = verifyJws(token, key);
  const claims = sessionTokenClaimsSchema.safeParse(payload);
  if (!claims.success) throw new SessionTokenError("claims do not match the contract");
  if (!acceptsAudience(claims.data, audience, nowSeconds)) {
    throw new SessionTokenError("wrong audience, expired or issued in the future");
  }
  return claims.data;
}
