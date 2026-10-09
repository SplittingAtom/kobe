import { createHash } from "node:crypto";
import { Transform, type Readable, type TransformCallback } from "node:stream";

/**
 * The narrow object-store surface workspace sync needs (KOBE-27). Production: S3-compatible
 * storage (`s3.ts`, the chart's external endpoint, spec D4); tests: an in-memory store or a fake
 * S3 server. Keys are full object keys (prefix included), always derived server-side (`keys.ts`).
 */
export interface ObjectStore {
  /**
   * Stores exactly `size` bytes from `body` under `key`. Rejects, storing nothing, when the body
   * errors or ends short (a verifying stream withholds its last chunk on a hash mismatch).
   */
  put(key: string, body: Readable, size: number): Promise<void>;
  /**
   * Stores a body of unknown length (an upload being received, KOBE-143) under `key` without
   * holding it in memory (S3: multipart, a few MiB in flight). Rejects, storing nothing, when the
   * body errors.
   */
  putStream(key: string, body: Readable): Promise<void>;
  /** The object's bytes, or null when there is no such object. */
  get(key: string): Promise<{ readonly body: Readable; readonly size: number } | null>;
  /** Server-side copy within the bucket. */
  copy(from: string, to: string): Promise<void>;
  /** Deletes the objects (missing ones are fine). */
  delete(keys: readonly string[]): Promise<void>;
}

export class IntegrityError extends Error {
  constructor(readonly reason: "hash_mismatch" | "size_mismatch") {
    super(`uploaded bytes failed verification: ${reason}`);
    this.name = "IntegrityError";
  }
}

/**
 * Passes bytes through while hashing them, and **withholds the final chunk until the hash and size
 * check out**: on a mismatch the stream errors before the store has received `size` bytes, so a
 * store that requires an exact Content-Length never completes the object. More bytes than
 * `size` error at once.
 */
export function verifyingStream(sha256: string, size: number): Transform {
  const hash = createHash("sha256");
  let seen = 0;
  let held: Buffer | undefined;
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      seen += chunk.length;
      if (seen > size) {
        done(new IntegrityError("size_mismatch"));
        return;
      }
      hash.update(chunk);
      const previous = held;
      held = chunk;
      done(null, previous);
    },
    flush(done: TransformCallback) {
      if (seen !== size) {
        done(new IntegrityError("size_mismatch"));
        return;
      }
      if (hash.digest("hex") !== sha256) {
        done(new IntegrityError("hash_mismatch"));
        return;
      }
      done(null, held);
    },
  });
}
