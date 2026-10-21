import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { threadContextResultSchema } from "../context-viewer.js";
import { SANDBOX_MAX_FRAME_BYTES, SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * `thread.context` (KOBE-470, context-viewer.ts): the server asks the member's own sandbox for the
 * context of a thread's latest model call, behind hello capability {@link CAPABILITY_THREAD_CONTEXT}.
 * Answered by `command.result` whose `data` is the sealed `ThreadContextResult` (untrusted: the
 * server opens and validates it). Never sent to a skill eval's sandbox.
 */
export const CAPABILITY_THREAD_CONTEXT = "thread_context";

/** Most UTF-8 bytes of section text one answer carries. */
export const THREAD_CONTEXT_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Most UTF-8 bytes of the answer's JSON before it is sealed: sealed and base64url-encoded it must
 * still fit one `command.result` frame (4 MiB) with room for the envelope.
 */
export const THREAD_CONTEXT_PLAINTEXT_MAX_BYTES = Math.floor(
  ((SANDBOX_MAX_FRAME_BYTES - 64 * 1024) * 3) / 4,
);

/** Sealed replies (node/sealed-reply.ts): X25519 + HKDF-SHA256 + AES-256-GCM. */
export const SEALED_REPLY_ALG = "x25519-hkdf-sha256-aes256gcm";
const b64url = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[A-Za-z0-9_-]*$/);
const X25519_PUBLIC_KEY = b64url(43).min(43);

/** The requesting server's one-use public key; only that process can open the answer. */
export const sealedReplyKeySchema = z.strictObject({
  alg: z.literal(SEALED_REPLY_ALG),
  public_key: X25519_PUBLIC_KEY,
});
export type SealedReplyKey = z.infer<typeof sealedReplyKeySchema>;

export const sealedReplySchema = z.strictObject({
  v: z.literal(1),
  /** The sandbox's ephemeral X25519 public key. */
  epk: X25519_PUBLIC_KEY,
  nonce: b64url(16).min(16),
  ciphertext: b64url(Math.ceil((THREAD_CONTEXT_PLAINTEXT_MAX_BYTES * 4) / 3) + 4),
  tag: b64url(22).min(22),
});
export type SealedReply = z.infer<typeof sealedReplySchema>;

export const threadContextFrameSchema = z.strictObject({
  v: z.literal(SANDBOX_WIRE_VERSION),
  type: z.literal("thread.context"),
  command_id: idSchema,
  thread_id: uuidSchema,
  /** Budget for the section texts, in UTF-8 bytes. */
  max_bytes: z.number().int().positive().max(THREAD_CONTEXT_MAX_BYTES),
  /** The answer is sealed to this key (CV8): the command row never holds plaintext. */
  reply_key: sealedReplyKeySchema,
});
export type ThreadContextFrame = z.infer<typeof threadContextFrameSchema>;

/**
 * What a successful `thread.context` returns in `command.result.data`: the `ThreadContextResult`
 * JSON sealed to `reply_key` with the thread id as context. Opened, it is validated again.
 */
export const threadContextCommandResultSchema = z.strictObject({ sealed: sealedReplySchema });
/** The plaintext inside the seal. */
export const threadContextPlaintextSchema = threadContextResultSchema;
