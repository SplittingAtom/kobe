import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  RUN_TOKEN_KDF_INFO,
  RUN_TOKEN_KEY_BYTES,
  RUN_TOKEN_MASTER_MIN_BYTES,
  RUN_TOKEN_MAX_CHARS,
  RUN_TOKEN_PREFIX,
  RUN_TOKEN_SKEW_SECONDS,
  runTokenClaimsSchema,
  type RunTokenClaims,
  type RunTokenGrant,
  type VerifyRunTokenResult,
} from "../run-token.js";

/**
 * Reference sign/verify for run tokens (format in run-token.ts). Server side only: never import
 * into sandbox code. The stateful checks (run still active, sandbox/team match the session token)
 * are the gateway's (KOBE-118).
 */

/** Domain-separated HMAC key from the server master secret (HKDF-SHA256, info `kobe/run-token/v1`). */
export function deriveRunTokenKey(master: Uint8Array): Uint8Array {
  if (master.byteLength < RUN_TOKEN_MASTER_MIN_BYTES) {
    throw new Error(`run token master secret is shorter than ${RUN_TOKEN_MASTER_MIN_BYTES} bytes`);
  }
  const key = hkdfSync(
    "sha256",
    master,
    new Uint8Array(0),
    RUN_TOKEN_KDF_INFO,
    RUN_TOKEN_KEY_BYTES,
  );
  return new Uint8Array(key);
}

function mac(key: Uint8Array, signed: string): string {
  return createHmac("sha256", key).update(signed, "ascii").digest("base64url");
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== RUN_TOKEN_KEY_BYTES) throw new Error("run token key must be derived");
}

export function signRunToken(key: Uint8Array, claims: RunTokenClaims): RunTokenGrant {
  assertKey(key);
  const parsed = runTokenClaimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  const signed = `${RUN_TOKEN_PREFIX}.${payload}`;
  return {
    token: `${signed}.${mac(key, signed)}`,
    expires_at: new Date(parsed.exp * 1000).toISOString(),
  };
}

/** Integrity, claims shape and time window only. Fails closed; never throws on bad input. */
export function verifyRunToken(
  key: Uint8Array,
  token: unknown,
  nowSeconds: number,
): VerifyRunTokenResult {
  assertKey(key);
  if (typeof token !== "string" || token.length > RUN_TOKEN_MAX_CHARS)
    return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  const [prefix, payload, given] = parts;
  if (parts.length !== 3 || prefix !== RUN_TOKEN_PREFIX || !payload || !given)
    return { ok: false, reason: "malformed" };
  const want = Buffer.from(mac(key, `${prefix}.${payload}`), "utf8");
  const have = Buffer.from(given, "utf8");
  if (want.length !== have.length || !timingSafeEqual(want, have))
    return { ok: false, reason: "bad_mac" };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const claims = runTokenClaimsSchema.safeParse(json);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (!(nowSeconds < claims.data.exp)) return { ok: false, reason: "expired" };
  if (claims.data.iat > nowSeconds + RUN_TOKEN_SKEW_SECONDS)
    return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: claims.data };
}
