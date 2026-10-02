import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Invitation tokens: 256 random bits, base64url. Only the SHA-256 hash is ever stored. */
export function newToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Tokens we issued are 43 base64url characters; anything else is rejected before a lookup. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
