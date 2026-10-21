import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  SEALED_REPLY_ALG,
  sealedReplySchema,
  type SealedReply,
  type SealedReplyKey,
} from "../sandbox-wire/context-frames.js";

/**
 * Sealed command replies (KOBE-470, docs/specs/context-viewer.md CV8): the requesting server
 * process makes an ephemeral X25519 key pair per request and sends only the public key; the
 * sandbox seals its answer to it (its own ephemeral X25519 key, ECDH, HKDF-SHA256, AES-256-GCM),
 * so the `sandbox_commands` row that carries the answer between replicas holds ciphertext only.
 * The private key never leaves the requesting process's memory and is dropped after one use.
 *
 * Key: HKDF-SHA256(ikm = X25519 shared secret, salt = sender public || recipient public,
 * info = `kobe.sealed-reply.v1` || 0x00 || `context`). AAD = `context` (the command's thread id),
 * so an answer for one thread cannot be passed off as another's.
 */
const INFO = "kobe.sealed-reply.v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const b64url = (b: Buffer): string => b.toString("base64url");
const raw = (k: KeyObject): Buffer => Buffer.from(k.export({ format: "jwk" }).x ?? "", "base64url");
const publicOf = (x: string): KeyObject =>
  createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });

function deriveKey(secret: Buffer, senderPub: Buffer, recipientPub: Buffer, context: string) {
  const info = Buffer.concat([Buffer.from(INFO), Buffer.from([0]), Buffer.from(context, "utf8")]);
  return Buffer.from(
    hkdfSync("sha256", secret, Buffer.concat([senderPub, recipientPub]), info, 32),
  );
}

/** The requester's side: a fresh key pair; send `key`, keep `open` (and drop it after use). */
export function sealedReplyKeyPair(): {
  readonly key: SealedReplyKey;
  readonly open: (sealed: unknown, context: string) => string | undefined;
} {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const recipientPub = raw(publicKey);
  let used = false;
  return {
    key: { alg: SEALED_REPLY_ALG, public_key: b64url(recipientPub) },
    open(sealed, context) {
      if (used) return undefined;
      used = true;
      const parsed = sealedReplySchema.safeParse(sealed);
      if (!parsed.success) return undefined;
      try {
        const senderPub = Buffer.from(parsed.data.epk, "base64url");
        const secret = diffieHellman({ privateKey, publicKey: publicOf(parsed.data.epk) });
        const key = deriveKey(secret, senderPub, recipientPub, context);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(parsed.data.nonce, "base64url"),
        );
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(Buffer.from(parsed.data.tag, "base64url"));
        const ciphertext = Buffer.from(parsed.data.ciphertext, "base64url");
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** The sandbox's side: `plaintext` sealed to the requester's public key. */
export function sealReply(key: SealedReplyKey, plaintext: string, context: string): SealedReply {
  const recipient = publicOf(key.public_key);
  const recipientPub = Buffer.from(key.public_key, "base64url");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const senderPub = raw(publicKey);
  const secret = diffieHellman({ privateKey, publicKey: recipient });
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveKey(secret, senderPub, recipientPub, context),
    nonce,
  );
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) throw new Error("unexpected tag length");
  return {
    v: 1,
    epk: b64url(senderPub),
    nonce: b64url(nonce),
    ciphertext: b64url(ciphertext),
    tag: b64url(tag),
  };
}
