import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/**
 * Ed25519 keys of the sandbox session tokens (KOBE-513). The server holds one private key per
 * audience ({@link SessionSigningKey}); each verifying service holds only that audience's public
 * key(s) ({@link SessionVerifyKeys}), so a verifier can check tokens but never mint one.
 *
 * - A signing key is one PKCS#8 `PRIVATE KEY` PEM block.
 * - A verify set is a bundle of one to {@link MAX_VERIFY_KEYS} `PUBLIC KEY` (SPKI) or `CERTIFICATE`
 *   PEM blocks (the chart generates a self-signed certificate because Helm cannot derive a bare
 *   public key; only its key is used, never its dates or names). Two keys during a rotation.
 *   A `PRIVATE KEY` block in a verify set is refused: a verifier must never hold one.
 * - The key id (`kid`) is derived from the public key (SHA-256 of its SPKI DER, base64url, 16
 *   chars), never configured, so signer and verifiers always agree.
 */
export const MAX_VERIFY_KEYS = 4;
const KID_LENGTH = 16;
export const KID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

export interface SessionSigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

/** Public keys a verifier accepts, by key id. */
export type SessionVerifyKeys = ReadonlyMap<string, KeyObject>;

export class SessionKeyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionKeyError";
  }
}

export function keyId(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64url").slice(0, KID_LENGTH);
}

function pemBlocks(text: string): { type: string; pem: string }[] {
  return [...text.matchAll(PEM_BLOCK)].map((m) => ({ type: m[1] ?? "", pem: m[0] }));
}

/** One Ed25519 private key (PKCS#8 PEM). Never echoes the key in errors. */
export function loadSigningKey(pem: string, what = "signing key"): SessionSigningKey {
  const blocks = pemBlocks(pem);
  if (blocks.length !== 1 || blocks[0]?.type !== "PRIVATE KEY") {
    throw new SessionKeyError(`${what} must be exactly one PEM "PRIVATE KEY" block (Ed25519)`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(blocks[0].pem);
  } catch {
    throw new SessionKeyError(`${what} is not a readable private key`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new SessionKeyError(`${what} must be an Ed25519 key`);
  }
  return { kid: keyId(createPublicKey(privateKey)), privateKey };
}

/** A verify set from a PEM bundle (public keys or certificates, Ed25519 only). */
export function loadVerifyKeys(bundle: string, what = "verify key"): SessionVerifyKeys {
  const blocks = pemBlocks(bundle);
  if (blocks.some((b) => b.type.includes("PRIVATE KEY"))) {
    throw new SessionKeyError(`${what} holds a private key: verifiers get public keys only`);
  }
  if (blocks.length === 0) {
    throw new SessionKeyError(`${what} must hold PEM "PUBLIC KEY" or "CERTIFICATE" blocks`);
  }
  if (blocks.length > MAX_VERIFY_KEYS) {
    throw new SessionKeyError(`${what} holds more than ${MAX_VERIFY_KEYS} keys`);
  }
  const keys = new Map<string, KeyObject>();
  for (const block of blocks) {
    if (block.type !== "PUBLIC KEY" && block.type !== "CERTIFICATE") {
      throw new SessionKeyError(`${what}: unexpected PEM block "${block.type}"`);
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(block.pem);
    } catch {
      throw new SessionKeyError(`${what} is not a readable public key or certificate`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new SessionKeyError(`${what} must hold Ed25519 keys only`);
    }
    keys.set(keyId(publicKey), publicKey);
  }
  return keys;
}

/** The verify set of signing keys (the server checks the tokens it signed itself this way). */
export function verifyKeysOf(...signing: SessionSigningKey[]): SessionVerifyKeys {
  return new Map(signing.map((s) => [s.kid, createPublicKey(s.privateKey)]));
}

/** Union of verify sets (own key plus a rotation bundle). */
export function mergeVerifyKeys(...sets: SessionVerifyKeys[]): SessionVerifyKeys {
  const merged = new Map<string, KeyObject>();
  for (const set of sets) for (const [kid, key] of set) merged.set(kid, key);
  return merged;
}

export interface GeneratedSessionKeyPair {
  readonly signing: SessionSigningKey;
  readonly verify: SessionVerifyKeys;
  readonly privatePem: string;
  readonly publicPem: string;
}

/** A fresh Ed25519 pair (tests, local dev). Installs get theirs from the chart. */
export function generateSessionKeyPair(): GeneratedSessionKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    signing: loadSigningKey(privatePem),
    verify: loadVerifyKeys(publicPem),
    privatePem,
    publicPem,
  };
}
