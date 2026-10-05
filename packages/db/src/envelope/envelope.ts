import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MIN_SECRET_LENGTH, deriveKey } from "../models/secret-box.js";

/**
 * Envelope encryption for per-record secrets (KOBE-107: connector credentials and the like).
 *
 * Each record gets its own random 256-bit data key (DEK). The DEK encrypts the plaintext with
 * AES-256-GCM; the install's key-encryption key (KEK, derived with HKDF-SHA256 from the chart's
 * Kubernetes Secret) wraps the DEK with AES-256-GCM. Both layers authenticate the same
 * {@link EnvelopeContext} (team, record kind, record id; length-prefixed so fields can't be
 * shifted into each other), and the wrap also authenticates the key id, so a ciphertext moved to
 * another record, kind or team, or relabelled with another key id, does not open.
 *
 * Rotation-ready: a keyring holds the current secret first and previous ones; every ciphertext
 * names its KEK (`kid`, derived from the key, not secret). {@link Envelope.rewrap} swaps the
 * wrapped DEK to the current KEK without touching (or decrypting) the data.
 *
 * Format: `e1.<kid>.<wrapNonce>.<wrappedDek>.<wrapTag>.<nonce>.<ciphertext>.<tag>` (base64url).
 * Errors carry fixed messages only: never the input, the key or the context.
 */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** What a ciphertext is bound to. */
export interface EnvelopeContext {
  readonly teamId: string;
  /** The record type, e.g. `connector_grant`. */
  readonly kind: string;
  readonly recordId: string;
}

const VERSION = "e1";
const KEK_PURPOSE = "envelope.kek";
const KID_PURPOSE = "envelope.kid";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEGMENT = /^[A-Za-z0-9_-]*$/;
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const ID = /^[\x21-\x7e]{1,128}$/;

interface Kek {
  readonly id: string;
  readonly key: Buffer;
}

function aad(context: EnvelopeContext, ...extra: string[]): Buffer {
  const { teamId, kind, recordId } = context;
  if (!ID.test(teamId ?? "") || !KIND.test(kind ?? "") || !ID.test(recordId ?? "")) {
    throw new EnvelopeError("invalid envelope context");
  }
  const parts = [VERSION, ...extra, teamId, kind, recordId].map((p) => Buffer.from(p, "utf8"));
  return Buffer.concat(
    parts.map((p) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(p.length);
      return Buffer.concat([len, p]);
    }),
  );
}

function gcm(key: Buffer, nonce: Buffer, ad: Buffer, data: Uint8Array) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(ad);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return { body, tag: cipher.getAuthTag() };
}

function ungcm(key: Buffer, nonce: Buffer, ad: Buffer, body: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

interface Parsed {
  readonly kid: string;
  readonly wrapNonce: Buffer;
  readonly wrapped: Buffer;
  readonly wrapTag: Buffer;
  readonly rest: readonly [string, string, string];
}

function parse(sealed: string): Parsed {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 8 || parts[0] !== VERSION || !parts.slice(1).every((p) => SEGMENT.test(p))) {
    throw new EnvelopeError("not an envelope");
  }
  const [, kid, wn, wd, wt, n, c, t] = parts as [string, ...string[]] & string[];
  const wrapNonce = Buffer.from(wn as string, "base64url");
  const wrapped = Buffer.from(wd as string, "base64url");
  const wrapTag = Buffer.from(wt as string, "base64url");
  if (
    wrapNonce.length !== NONCE_BYTES ||
    wrapped.length !== DEK_BYTES ||
    wrapTag.length !== TAG_BYTES
  ) {
    throw new EnvelopeError("not an envelope");
  }
  return {
    kid: kid as string,
    wrapNonce,
    wrapped,
    wrapTag,
    rest: [n as string, c as string, t as string],
  };
}

export class Envelope {
  #keks: Kek[] | undefined;

  /** `secrets`: the current install secret first, then previous ones still accepted for opening. */
  constructor(secrets: string | readonly string[]) {
    const list = (typeof secrets === "string" ? [secrets] : secrets).filter((s) => s !== "");
    if (list.length === 0 || list.some((s) => s.length < MIN_SECRET_LENGTH)) {
      throw new EnvelopeError(`every secret must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    this.#keks = list.map((secret) => ({
      id: deriveKey(secret, KID_PURPOSE).subarray(0, 6).toString("hex"),
      key: deriveKey(secret, KEK_PURPOSE),
    }));
  }

  #live(): Kek[] {
    if (!this.#keks) throw new EnvelopeError("the envelope was destroyed");
    return this.#keks;
  }

  /** Id of the KEK new ciphertexts use (not secret). */
  get currentKeyId(): string {
    return (this.#live()[0] as Kek).id;
  }

  /** The key id a ciphertext names (for storage and rotation sweeps). */
  static keyIdOf(sealed: string): string {
    return parse(sealed).kid;
  }

  /** Whether `sealed` is wrapped by the current KEK (false: {@link rewrap} it). */
  isCurrent(sealed: string): boolean {
    return parse(sealed).kid === this.currentKeyId;
  }

  seal(plaintext: string | Uint8Array, context: EnvelopeContext): string {
    const kek = this.#live()[0] as Kek;
    const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const dek = randomBytes(DEK_BYTES);
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const sealedData = gcm(dek, nonce, aad(context), data);
      return this.#assemble(kek, dek, context, [nonce, sealedData.body, sealedData.tag]);
    } finally {
      dek.fill(0);
      if (typeof plaintext === "string") data.fill(0);
    }
  }

  /** Decrypts into a Buffer the caller should `fill(0)` when done. */
  open(sealed: string, context: EnvelopeContext): Buffer {
    const p = parse(sealed);
    const dek = this.#unwrap(p, context);
    try {
      const [n, c, t] = p.rest.map((s) => Buffer.from(s, "base64url")) as [Buffer, Buffer, Buffer];
      if (n.length !== NONCE_BYTES || t.length !== TAG_BYTES)
        throw new EnvelopeError("not an envelope");
      return ungcm(dek, n, aad(context), c, t);
    } catch (err) {
      if (err instanceof EnvelopeError) throw err;
      throw new EnvelopeError("the envelope does not open with this key and context");
    } finally {
      dek.fill(0);
    }
  }

  openString(sealed: string, context: EnvelopeContext): string {
    const buf = this.open(sealed, context);
    try {
      return buf.toString("utf8");
    } finally {
      buf.fill(0);
    }
  }

  /** Re-wraps the record's data key with the current KEK; the data ciphertext is unchanged. */
  rewrap(sealed: string, context: EnvelopeContext): string {
    const p = parse(sealed);
    const dek = this.#unwrap(p, context);
    try {
      const kek = this.#live()[0] as Kek;
      const [n, c, t] = p.rest.map((s) => Buffer.from(s, "base64url")) as [Buffer, Buffer, Buffer];
      return this.#assemble(kek, dek, context, [n, c, t]);
    } finally {
      dek.fill(0);
    }
  }

  /** Zeroizes the held keys; the envelope is unusable afterwards. */
  destroy(): void {
    for (const k of this.#keks ?? []) k.key.fill(0);
    this.#keks = undefined;
  }

  #assemble(
    kek: Kek,
    dek: Buffer,
    context: EnvelopeContext,
    data: [Buffer, Buffer, Buffer],
  ): string {
    const wrapNonce = randomBytes(NONCE_BYTES);
    const wrap = gcm(kek.key, wrapNonce, aad(context, kek.id), dek);
    return [VERSION, kek.id, ...[wrapNonce, wrap.body, wrap.tag, ...data].map(b64)].join(".");
  }

  #unwrap(p: Parsed, context: EnvelopeContext): Buffer {
    const kek = this.#live().find((k) => k.id === p.kid);
    if (!kek) throw new EnvelopeError("sealed with a key this envelope does not hold");
    try {
      return ungcm(kek.key, p.wrapNonce, aad(context, kek.id), p.wrapped, p.wrapTag);
    } catch (err) {
      if (err instanceof EnvelopeError) throw err;
      throw new EnvelopeError("the envelope does not open with this key and context");
    }
  }
}
