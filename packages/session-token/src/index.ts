import {
  acceptsAudience,
  sessionTokenClaimsSchema,
  type SessionTokenAudience,
  type SessionTokenClaims,
} from "@kobe/protocol";
import { SessionTokenError, signJws, verifyJws } from "./jws.js";
import type { SessionSigningKey, SessionVerifyKeys } from "./keys.js";

/**
 * Sandbox session tokens (packages/protocol session-token.ts; KOBE-22 settled its SPECULATIVE part).
 * Shared by the server (which mints them) and every service that verifies them (egress proxy, MCP
 * proxy, model gateway), so all apply exactly the same rules:
 *
 * - Encoding: compact JWS, **EdDSA (Ed25519) only** (KOBE-513). The header must be exactly
 *   {"alg":"EdDSA","typ":"JWT","kid":"<key id>"}: `none`, any other algorithm (HS256 included) and
 *   any other header field (jku, x5u, jwk, crit) are rejected; the algorithm is never taken from
 *   the token, and `kid` only picks one of the verifier's own public keys (rotation).
 * - One key pair per audience. The server holds the four private keys
 *   (KOBE_SESSION_SIGNING_KEY_*); each verifying service holds only its audience's public key(s)
 *   (KOBE_SESSION_VERIFY_KEY_*), so a service can verify but never mint a token, not even for its
 *   own audience (a compromised proxy cannot impersonate a sandbox).
 * - TTL 15 minutes, no refresh token: a sandbox re-trades its bootstrap token for fresh tokens.
 */
export const SESSION_TOKEN_TTL_SECONDS = 15 * 60;
export { MAX_SESSION_TOKEN_LENGTH, SESSION_TOKEN_ALG, SessionTokenError } from "./jws.js";
export * from "./keys.js";
export * from "./site.js";
export * from "./gateway-tokens.js";

export function signSessionToken(claims: SessionTokenClaims, key: SessionSigningKey): string {
  return signJws(sessionTokenClaimsSchema.parse(claims), key);
}

/**
 * Verifies integrity with the audience's public key(s), then the claims (schema, `aud`, `exp`, `iat`).
 * Liveness of `sub` for (team_id, user_id) is the caller's check (see the protocol contract).
 */
export function verifySessionToken(
  token: string,
  audience: SessionTokenAudience,
  keys: SessionVerifyKeys,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionTokenClaims {
  const payload = verifyJws(token, keys);
  const claims = sessionTokenClaimsSchema.safeParse(payload);
  if (!claims.success) throw new SessionTokenError("claims do not match the contract");
  if (!acceptsAudience(claims.data, audience, nowSeconds)) {
    throw new SessionTokenError("wrong audience, expired or issued in the future");
  }
  return claims.data;
}
