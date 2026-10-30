import { sign, verify } from "node:crypto";
import { KID_PATTERN, type SessionSigningKey, type SessionVerifyKeys } from "./keys.js";

/**
 * The compact JWS every Kobe session token uses (KOBE-513): **EdDSA (Ed25519) only**, header
 * exactly {"alg":"EdDSA","typ":"<typ>","kid":"<key id>"} with the verifier's expected `typ`. `none`, every other algorithm (HS256
 * included) and extra fields such as jku, x5u, jwk or crit are refused; the algorithm is never
 * read from the token, and `kid` only selects among the verifier's own public keys (an unknown
 * kid fails). Callers validate the payload themselves.
 */
export const MAX_SESSION_TOKEN_LENGTH = 4096;
export const SESSION_TOKEN_ALG = "EdDSA";
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;

export class SessionTokenError extends Error {
  constructor(reason: string) {
    super(`invalid session token: ${reason}`);
    this.name = "SessionTokenError";
  }
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * `typ` names the token kind and is signed: session and site tokens use `JWT`, run tokens `krt2`
 * and server-call tokens `ksc2` (KOBE-521), so a token of one kind never verifies as another even
 * under the same key.
 */
export function signJws(payload: unknown, key: SessionSigningKey, typ: string = "JWT"): string {
  const signingInput = `${b64({ alg: SESSION_TOKEN_ALG, typ, kid: key.kid })}.${b64(payload)}`;
  const signature = sign(null, Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function decodeJson(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new SessionTokenError(`${what} is not JSON`);
  }
}

function headerKid(header: unknown, typ: string): string {
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new SessionTokenError("header must be exactly EdDSA/typ/kid");
  }
  const h = header as Record<string, unknown>;
  if (
    Object.keys(h).length !== 3 ||
    h.alg !== SESSION_TOKEN_ALG ||
    h.typ !== typ ||
    typeof h.kid !== "string" ||
    !KID_PATTERN.test(h.kid)
  ) {
    throw new SessionTokenError("header must be exactly EdDSA/typ/kid");
  }
  return h.kid;
}

/** The payload of a token signed by a key in `keys`; throws {@link SessionTokenError} otherwise. */
export function verifyJws(token: string, keys: SessionVerifyKeys, typ: string = "JWT"): unknown {
  if (token.length > MAX_SESSION_TOKEN_LENGTH) throw new SessionTokenError("too long");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    throw new SessionTokenError("not a compact JWS");
  }
  const [encodedHeader, payload, signature] = parts as [string, string, string];
  const publicKey = keys.get(headerKid(decodeJson(encodedHeader, "header"), typ));
  if (!publicKey) throw new SessionTokenError("unknown key id");
  const sig = Buffer.from(signature, "base64url");
  // One encoding per signature: no trailing-bit variants of the same token.
  if (sig.length !== ED25519_SIGNATURE_BYTES || sig.toString("base64url") !== signature) {
    throw new SessionTokenError("bad signature");
  }
  if (!verify(null, Buffer.from(`${encodedHeader}.${payload}`), publicKey, sig)) {
    throw new SessionTokenError("bad signature");
  }
  return decodeJson(payload, "payload");
}
