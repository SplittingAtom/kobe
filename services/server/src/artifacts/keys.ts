import { randomUUID } from "node:crypto";

/**
 * Object key of one artifact version's content (D-5 of KOBE-55): always derived here, never named
 * by a sandbox. It lies in the thread's own tree (`<prefix>teams/<team>/threads/<thread>/`), so
 * retention deletes it with the thread and export reads it back (`threadKey`, retention/blobs.ts).
 * The last segment is random: the version number is only known once the artifact row is locked,
 * after the bytes are uploaded.
 */
export function artifactBlobKey(
  prefix: string,
  teamId: string,
  threadId: string,
  artifactId: string,
): string {
  return `${prefix}teams/${teamId}/threads/${threadId}/artifacts/${artifactId}/${randomUUID()}`;
}
