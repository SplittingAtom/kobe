import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { BlobStore } from "../retention/blobs.js";
import type { SkillLocation } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The object key of a skill bundle: derived from the verified owner and the content hash, never
 * from anything the uploader named, so one owner's keys can't name another's:
 *
 *   <prefix>skills/teams/<team_id>/<sha256>   team skills
 *   <prefix>skills/users/<user_id>/<sha256>   personal skills
 *
 * Content-addressed: re-uploading the same bytes writes the same object, and a version row that
 * fails to commit leaves at most an unreferenced blob that the next identical upload reuses.
 */
export function skillBundleKey(prefix: string, location: SkillLocation, sha256: string): string {
  const owner = location.scope === "team" ? location.teamId : location.ownerUserId;
  if (!UUID.test(owner) || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("skill keys: owner must be a UUID and the hash a SHA-256");
  const kind = location.scope === "team" ? "teams" : "users";
  return `${prefix}skills/${kind}/${owner}/${sha256}`;
}

/** Stores the bundle bytes; rejects (storing nothing) if the object store fails. */
export function putSkillBundle(blobs: BlobStore, key: string, zip: Uint8Array): Promise<void> {
  return blobs.objects.put(key, Readable.from([Buffer.from(zip)]), zip.length);
}
