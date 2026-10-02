import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Backups are encrypted and authenticated with an operator-held key (KOBE_BACKUP_KEY_FILE or
 * KOBE_BACKUP_KEY, never argv). Per backup, HKDF-SHA256 over a random salt derives one AES-256-GCM
 * key for the files and one HMAC-SHA256 key for the manifest; the manifest records each file's
 * ciphertext checksum, so the signature covers everything.
 */
export const MIN_KEY_BYTES = 32;
/** Random 32-byte keys have ~31 distinct byte values; fewer than this means a typed or patterned key. */
export const MIN_DISTINCT_KEY_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface BackupKeys {
  readonly enc: Buffer;
  readonly mac: Buffer;
}

/** Sealed-file header recorded in the (signed) manifest. */
export interface SealHeader {
  readonly iv: string;
  readonly tag: string;
}

export function parseKeyMaterial(text: string): Buffer {
  const trimmed = text.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) key = Buffer.from(trimmed, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) key = Buffer.from(trimmed, "base64");
  else throw new Error("The backup key must be base64 or hex (e.g. openssl rand -base64 32)");
  if (key.length < MIN_KEY_BYTES) {
    throw new Error(`The backup key must be at least ${MIN_KEY_BYTES} bytes of random data`);
  }
  if (new Set(key).size < MIN_DISTINCT_KEY_BYTES) {
    throw new Error(
      "The backup key does not look random (too few distinct bytes); generate one with openssl rand -base64 32",
    );
  }
  return key;
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

export function deriveKeys(master: Buffer, salt: Buffer): BackupKeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync("sha256", master, salt, info, KEY_BYTES));
  return { enc: derive("kobe-backup/v1/encryption"), mac: derive("kobe-backup/v1/manifest-mac") };
}

export function signManifest(mac: Buffer, body: Buffer): string {
  return createHmac("sha256", mac).update(body).digest("hex");
}

export function verifyManifestSignature(mac: Buffer, body: Buffer, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signManifest(mac, body), "hex"),
    Buffer.from(signature, "hex"),
  );
}

const decryptError = (name: string): Error =>
  new Error(`${name} could not be decrypted: wrong backup key, or the backup was modified`);

export function encryptBuffer(
  key: Buffer,
  name: string,
  plain: Buffer,
): SealHeader & { data: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data };
}

export function decryptBuffer(
  key: Buffer,
  name: string,
  sealed: SealHeader & { data: Buffer },
): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "hex"));
    decipher.setAAD(Buffer.from(name)).setAuthTag(Buffer.from(sealed.tag, "hex"));
    return Buffer.concat([decipher.update(sealed.data), decipher.final()]);
  } catch {
    throw decryptError(name);
  }
}

/** Encrypts a stream (e.g. pg_dump's stdout) straight into `dest`; plaintext never touches disk. */
export async function encryptStream(
  key: Buffer,
  name: string,
  source: Readable,
  dest: string,
): Promise<SealHeader> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(name));
  await pipeline(source, cipher, createWriteStream(dest, { mode: 0o600 }));
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

/**
 * Decrypts `src` into `dest` (0600) and verifies the GCM tag before returning; on failure `dest`
 * is deleted, so callers only ever see fully authenticated plaintext.
 */
export async function decryptFile(
  key: Buffer,
  name: string,
  src: string,
  header: SealHeader,
  dest: string,
): Promise<void> {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "hex"));
    decipher.setAAD(Buffer.from(name)).setAuthTag(Buffer.from(header.tag, "hex"));
    await pipeline(createReadStream(src), decipher, createWriteStream(dest, { mode: 0o600 }));
  } catch {
    await rm(dest, { force: true });
    throw decryptError(name);
  }
}
