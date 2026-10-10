import { createHash, randomBytes } from "node:crypto";

/** A PKCE code verifier (RFC 7636): 32 random bytes, 43 base64url characters. */
export const newVerifier = (): string => randomBytes(32).toString("base64url");

/** The S256 challenge for a verifier. Kobe never uses the `plain` method. */
export const challengeOf = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");
