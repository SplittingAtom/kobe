import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Seals secrets stored in Postgres (KOBE-40: provider API keys, gateway virtual keys) with
 * AES-256-GCM. The key is derived from a configured secret per purpose (HKDF-SHA256), so one secret
 * never encrypts two kinds of value; the context (e.g. `provider:<id>:r<revision>`) is the
 * additional authenticated data, so a sealed value copied into another row (or an older revision)
 * does not open there.
 *
 * Rotation: a box holds the current secret first and optionally previous ones. Every sealed value
 * names the key it was sealed with (`kid`, derived from the key, not secret), so values sealed with
 * a previous secret still open; {@link SecretBox.isCurrent} tells callers to re-seal them.
 *
 * Format: `v2.<kid>.<nonce>.<ciphertext>.<tag>` (base64url). Errors never include the input.
 */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

const VERSION = "v2";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_SECRET_LENGTH = 32;
const SEGMENT = /^[A-Za-z0-9_-]*$/;

/** A 32-byte key derived from `secret` for one purpose (also used for non-sealing secrets). */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `kobe.${purpose}`, 32));
}

interface Key {
  readonly id: string;
  readonly key: Buffer;
}

export class SecretBox {
  readonly #keys: readonly Key[];

  /** `secrets`: the current secret first, then previous ones still accepted for opening. */
  constructor(secrets: string | readonly string[], purpose: string) {
    const list = (typeof secrets === "string" ? [secrets] : secrets).filter((s) => s !== "");
    if (list.length === 0 || list.some((s) => s.length < MIN_SECRET_LENGTH)) {
      throw new SecretBoxError(`every secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.#keys = list.map((secret) => {
      const key = deriveKey(secret, `secret-box.${purpose}`);
      const id = deriveKey(secret, `secret-box.${purpose}.kid`).subarray(0, 6).toString("hex");
      return { id, key };
    });
  }

  seal(plaintext: string, context: string): string {
    const current = this.#keys[0] as Key;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", current.key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const b64 = (b: Buffer) => b.toString("base64url");
    return `${VERSION}.${current.id}.${b64(nonce)}.${b64(body)}.${b64(cipher.getAuthTag())}`;
  }

  /** Whether `sealed` uses the current secret (false: re-seal it). */
  isCurrent(sealed: string): boolean {
    return sealed.split(".")[1] === this.#keys[0]?.id;
  }

  open(sealed: string, context: string): string {
    const parts = sealed.split(".");
    if (parts.length !== 5 || parts[0] !== VERSION || !parts.every((p) => SEGMENT.test(p))) {
      throw new SecretBoxError("not a sealed value");
    }
    const key = this.#keys.find((k) => k.id === parts[1]);
    if (!key) throw new SecretBoxError("sealed with a secret this box does not hold");
    const nonce = Buffer.from(parts[2] ?? "", "base64url");
    const body = Buffer.from(parts[3] ?? "", "base64url");
    const tag = Buffer.from(parts[4] ?? "", "base64url");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError("not a sealed value");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.key, nonce);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretBoxError("the sealed value does not open with this key and context");
    }
  }
}
