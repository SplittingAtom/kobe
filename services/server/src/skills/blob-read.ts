import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { BlobStore } from "../retention/blobs.js";
import { IntegrityError, verifyingStream } from "../workspace-sync/object-store.js";

/**
 * Reading skill bytes back from the object store (KOBE-310): by key, always verified against the
 * hash and size the version row records. A corrupted or truncated object is never served: the
 * buffered read throws {@link IntegrityError}, the stream errors before its last chunk.
 */

export { IntegrityError };

/**
 * A verified stream of the object and its size, or null when the object is missing or not
 * `size` bytes. `size` is null for a package zip (its row records only its hash): the object's
 * own size is used, and the hash still decides.
 */
export async function openVerified(
  blobs: BlobStore,
  key: string,
  sha256: string,
  size: number | null,
): Promise<{ readonly body: Readable; readonly size: number } | null> {
  const object = await blobs.objects.get(key);
  if (!object) return null;
  if (size !== null && object.size !== size) {
    object.body.destroy();
    return null;
  }
  const verified = object.body.pipe(verifyingStream(sha256, object.size));
  object.body.on("error", (err) => verified.destroy(err));
  return { body: verified, size: object.size };
}

/**
 * The object's bytes once verified; null when it is missing, IntegrityError when corrupt. `size`
 * is null for a package zip (its row records only its hash).
 */
export async function readVerified(
  blobs: BlobStore,
  key: string,
  sha256: string,
  size: number | null,
): Promise<Uint8Array | null> {
  const object = await blobs.objects.get(key);
  if (!object) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
  const bytes = Buffer.concat(chunks);
  if (size !== null && bytes.length !== size) throw new IntegrityError("size_mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new IntegrityError("hash_mismatch");
  return new Uint8Array(bytes);
}
