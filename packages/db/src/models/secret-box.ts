import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Seals secrets stored in Postgres (KOBE-40: provider API keys, gateway virtual keys) with
 * AES-256-GCM. The key is derived from a configured secret per purpose (HKDF-SHA256), so one secret
 * never encrypts two kinds of value; the context (e.g. `provider:<id>`) is the additional
 * authenticated data, so a sealed value copied into another row does not open there.
 *
 * Format: `v1.<nonce>.<ciphertext>.<tag>` (base64url). Errors never include the input.
 */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_SECRET_LENGTH = 32;
const SEGMENT = /^[A-Za-z0-9_-]*$/;

export class SecretBox {
  readonly #key: Buffer;

  constructor(secret: string, purpose: string) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new SecretBoxError(`the secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.#key = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), `kobe.secret-box.${purpose}`, 32),
    );
  }

  seal(plaintext: string, context: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const b64 = (b: Buffer) => b.toString("base64url");
    return `${VERSION}.${b64(nonce)}.${b64(body)}.${b64(cipher.getAuthTag())}`;
  }

  open(sealed: string, context: string): string {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION || !parts.every((p) => SEGMENT.test(p))) {
      throw new SecretBoxError("not a sealed value");
    }
    const nonce = Buffer.from(parts[1] ?? "", "base64url");
    const body = Buffer.from(parts[2] ?? "", "base64url");
    const tag = Buffer.from(parts[3] ?? "", "base64url");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError("not a sealed value");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretBoxError("the sealed value does not open with this key and context");
    }
  }
}
