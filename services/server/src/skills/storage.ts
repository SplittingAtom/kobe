import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { logger } from "../logger.js";
import type { BlobStore } from "../retention/blobs.js";
import type { SkillLocation } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The object key of one upload attempt: derived from the verified owner, the content hash and a
 * fresh id, never from anything the uploader named, so one owner's keys can't name another's:
 *
 *   <prefix>skills/teams/<team_id>/<sha256>/<attempt uuid>   team skills
 *   <prefix>skills/users/<user_id>/<sha256>/<attempt uuid>   personal skills
 *
 * Unique per attempt, not content-addressed: cleanup after a failed upload only ever touches the
 * attempt's own key, so it can't delete a blob a committed version (or a concurrent upload of the
 * same bytes) uses. The hash lives in the version row (`content_hash`) and in the key for humans.
 */
export function skillBundleKey(
  prefix: string,
  location: SkillLocation,
  sha256: string,
  attempt: string = randomUUID(),
): string {
  const owner = location.scope === "team" ? location.teamId : location.ownerUserId;
  if (!UUID.test(owner) || !UUID.test(attempt) || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("skill keys: owner and attempt must be UUIDs and the hash a SHA-256");
  const kind = location.scope === "team" ? "teams" : "users";
  return `${prefix}skills/${kind}/${owner}/${sha256}/${attempt}`;
}

/** Stores the bundle bytes; rejects (storing nothing) if the object store fails. */
export function putSkillBundle(blobs: BlobStore, key: string, zip: Uint8Array): Promise<void> {
  return blobs.objects.put(key, Readable.from([Buffer.from(zip)]), zip.length);
}

/**
 * Best-effort removal of the bundle this attempt wrote for an upload that then failed. The key is
 * the attempt's own, so nothing committed can reference it. Never throws: a failure logs the key
 * (a hash and ids, no content) for a later sweep.
 */
export async function discardAttemptBundle(blobs: BlobStore, key: string): Promise<void> {
  try {
    await blobs.objects.delete([key]);
  } catch (err) {
    logger.error({ err, key }, "skills: could not delete a failed upload's bundle");
  }
}
