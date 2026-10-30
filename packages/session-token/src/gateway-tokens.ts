import {
  RUN_TOKEN_MAX_CHARS,
  RUN_TOKEN_SKEW_SECONDS,
  RUN_TOKEN_TYP,
  SERVER_CALL_TOKEN_MAX_CHARS,
  SERVER_CALL_TOKEN_SKEW_SECONDS,
  SERVER_CALL_TOKEN_TYP,
  runTokenClaimsSchema,
  serverCallClaimsSchema,
  type RunTokenClaims,
  type RunTokenGrant,
  type ServerCallClaims,
  type VerifyRunTokenResult,
  type VerifyServerCallTokenResult,
} from "@kobe/protocol";
import { signJws, verifyJws } from "./jws.js";
import type { SessionSigningKey, SessionVerifyKeys } from "./keys.js";

/**
 * Run tokens (KOBE-117/118) and server-call tokens (KOBE-234), both server → model gateway, signed
 * **EdDSA (Ed25519)** since KOBE-521 with the `kobe.model-gateway` key pair of the session tokens:
 * the server holds the private key, the gateway only the public key(s) (`kid` + rotation, as
 * KOBE-513), so a compromised gateway can verify these tokens but never mint one. The JWS `typ`
 * (`krt2`, `ksc2`; session tokens `JWT`) is signed, so no token kind verifies as another. Formats,
 * claims, size caps and skew rules are the contracts in `@kobe/protocol` (run-token.ts,
 * server-call.ts); the stateful checks (run still active, replay, member, budget) stay the
 * gateway's. Verification fails closed and never throws on bad input.
 */

const isoOf = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

export function signRunToken(key: SessionSigningKey, claims: RunTokenClaims): RunTokenGrant {
  const parsed = runTokenClaimsSchema.parse(claims);
  const token = signJws(parsed, key, RUN_TOKEN_TYP);
  if (token.length > RUN_TOKEN_MAX_CHARS) throw new Error("run token exceeds RUN_TOKEN_MAX_CHARS");
  return { token, expires_at: isoOf(parsed.exp) };
}

/** Integrity, claims shape and time window only (the gateway adds the stateful checks). */
export function verifyRunToken(
  keys: SessionVerifyKeys,
  token: unknown,
  nowSeconds: number,
): VerifyRunTokenResult {
  if (typeof token !== "string" || token.length > RUN_TOKEN_MAX_CHARS)
    return { ok: false, reason: "malformed" };
  let payload: unknown;
  try {
    payload = verifyJws(token, keys, RUN_TOKEN_TYP);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const claims = runTokenClaimsSchema.safeParse(payload);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (!(nowSeconds < claims.data.exp)) return { ok: false, reason: "expired" };
  if (claims.data.iat > nowSeconds + RUN_TOKEN_SKEW_SECONDS)
    return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: claims.data };
}

/** The token text (sent once, never stored). Throws on claims outside the contract. */
export function signServerCallToken(key: SessionSigningKey, claims: ServerCallClaims): string {
  const token = signJws(serverCallClaimsSchema.parse(claims), key, SERVER_CALL_TOKEN_TYP);
  if (token.length > SERVER_CALL_TOKEN_MAX_CHARS) {
    throw new Error("server call token exceeds SERVER_CALL_TOKEN_MAX_CHARS");
  }
  return token;
}

/** Integrity, claims shape and time window only (replay, member and budget are the gateway's). */
export function verifyServerCallToken(
  keys: SessionVerifyKeys,
  token: unknown,
  nowSeconds: number,
): VerifyServerCallTokenResult {
  if (typeof token !== "string" || token.length > SERVER_CALL_TOKEN_MAX_CHARS)
    return { ok: false, reason: "malformed" };
  let payload: unknown;
  try {
    payload = verifyJws(token, keys, SERVER_CALL_TOKEN_TYP);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const claims = serverCallClaimsSchema.safeParse(payload);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (!(nowSeconds < claims.data.exp)) return { ok: false, reason: "expired" };
  if (claims.data.iat > nowSeconds + SERVER_CALL_TOKEN_SKEW_SECONDS)
    return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: claims.data };
}
