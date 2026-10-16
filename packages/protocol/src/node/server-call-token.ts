import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  SERVER_CALL_TOKEN_KDF_INFO,
  SERVER_CALL_TOKEN_MAX_CHARS,
  SERVER_CALL_TOKEN_PREFIX,
  SERVER_CALL_TOKEN_SKEW_SECONDS,
  serverCallClaimsSchema,
  type ServerCallClaims,
  type VerifyServerCallTokenResult,
} from "../server-call.js";
import { RUN_TOKEN_KEY_BYTES, RUN_TOKEN_MASTER_MIN_BYTES } from "../run-token.js";

/**
 * Reference sign/verify for server-call tokens (format in server-call.ts). Server and model gateway
 * only: never import into sandbox code. The stateful checks (replay, member, model, body, budget)
 * are the gateway's.
 */

const KEY_BYTES = RUN_TOKEN_KEY_BYTES;

/** Domain-separated HMAC key (HKDF-SHA256, info `kobe/server-call-token/v1`) from the gateway key. */
export function deriveServerCallTokenKey(master: Uint8Array): Uint8Array {
  if (master.byteLength < RUN_TOKEN_MASTER_MIN_BYTES) {
    throw new Error(
      `server call token master secret is shorter than ${RUN_TOKEN_MASTER_MIN_BYTES} bytes`,
    );
  }
  return new Uint8Array(
    hkdfSync("sha256", master, new Uint8Array(0), SERVER_CALL_TOKEN_KDF_INFO, KEY_BYTES),
  );
}

function mac(key: Uint8Array, signed: string): string {
  return createHmac("sha256", key).update(signed, "ascii").digest("base64url");
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) throw new Error("server call token key must be derived");
}

/** The token text (sent once, never stored). Throws on claims outside the contract. */
export function signServerCallToken(key: Uint8Array, claims: ServerCallClaims): string {
  assertKey(key);
  const parsed = serverCallClaimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  const signed = `${SERVER_CALL_TOKEN_PREFIX}.${payload}`;
  return `${signed}.${mac(key, signed)}`;
}

/** Integrity, claims shape and time window only. Fails closed; never throws on bad input. */
export function verifyServerCallToken(
  key: Uint8Array,
  token: unknown,
  nowSeconds: number,
): VerifyServerCallTokenResult {
  assertKey(key);
  if (typeof token !== "string" || token.length > SERVER_CALL_TOKEN_MAX_CHARS)
    return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  const [prefix, payload, given] = parts;
  if (parts.length !== 3 || prefix !== SERVER_CALL_TOKEN_PREFIX || !payload || !given)
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
  const claims = serverCallClaimsSchema.safeParse(json);
  if (!claims.success) return { ok: false, reason: "malformed" };
  if (!(nowSeconds < claims.data.exp)) return { ok: false, reason: "expired" };
  if (claims.data.iat > nowSeconds + SERVER_CALL_TOKEN_SKEW_SECONDS)
    return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: claims.data };
}
