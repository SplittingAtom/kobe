import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * Sandbox session tokens (D13, D27, D28, D30). The server mints them per sandbox; they are the only
 * credentials inside a sandbox and grant nothing outside Kobe's own services.
 *
 * Audience binding is mandatory: the server issues **one token per audience**, and every service
 * rejects a token whose `aud` is not exactly its own (so a token lifted from the model gateway's
 * request log cannot open the sandbox wire or call the MCP proxy). Each service also checks `exp`,
 * that `sub` (sandbox) is still live for (`team_id`, `user_id`), and — for the wire — that
 * `hello.sandbox_id` equals `sub`.
 *
 * SPECULATIVE (KOBE-22/24 decide): encoding (signed JWT vs opaque + introspection), TTL and
 * rotation. The claims below are the contract either way. If signed (JWT/JWS), every verifier pins
 * the algorithm (e.g. EdDSA or HS256, configured, never read from the token header), rejects
 * `alg: "none"` and any other algorithm, and ignores `jku`/`x5u`/embedded keys.
 */
export const SESSION_TOKEN_AUDIENCES = [
  "kobe.sandbox-wire", // server WSS (`/v1/sandbox/connect`)
  "kobe.model-gateway", // Bifrost (D30)
  "kobe.mcp-proxy", // MCP proxy (D27)
  "kobe.egress-proxy", // egress proxy (D28)
] as const;
export const sessionTokenAudienceSchema = z.enum(SESSION_TOKEN_AUDIENCES);
export type SessionTokenAudience = z.infer<typeof sessionTokenAudienceSchema>;

export const sessionTokenClaimsSchema = z.strictObject({
  iss: z.literal("kobe-server"),
  aud: sessionTokenAudienceSchema,
  /** Sandbox id. */
  sub: uuidSchema,
  team_id: uuidSchema,
  user_id: uuidSchema,
  /** Seconds since the epoch. */
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  /** Unique token id (revocation lists, audit). */
  jti: z.string().min(16).max(128),
});
export type SessionTokenClaims = z.infer<typeof sessionTokenClaimsSchema>;

/** The audience check every service performs after verifying the token's integrity. */
export function acceptsAudience(
  claims: SessionTokenClaims,
  audience: SessionTokenAudience,
  nowSeconds: number,
): boolean {
  return claims.aud === audience && nowSeconds < claims.exp && claims.iat <= nowSeconds + 60;
}
