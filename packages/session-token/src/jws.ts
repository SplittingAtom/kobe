import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The compact JWS every Kobe token uses: HS256 only, header exactly {"alg":"HS256","typ":"JWT"}
 * (`none`, other algorithms and extra fields such as kid, jku, x5u, jwk or crit are refused; the
 * algorithm is never read from the token). Callers validate the payload themselves.
 */
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

export function signJws(payload: unknown, key: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${ENCODED_HEADER}.${encoded}`;
  return `${signingInput}.${mac(key, signingInput).toString("base64url")}`;
}

function decodeJson(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new SessionTokenError(`${what} is not JSON`);
  }
}

/** The payload of a token signed with `key`; throws {@link SessionTokenError} otherwise. */
export function verifyJws(token: string, key: string): unknown {
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
  return decodeJson(payload, "payload");
}
