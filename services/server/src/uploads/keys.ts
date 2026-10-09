import { randomUUID } from "node:crypto";

/**
 * Object key of an upload (KOBE-143), derived here from verified ids, never from the file name.
 * With a thread it lies in the thread's own tree, so retention deletes it with the thread
 * (`threadKey`, retention/blobs.ts): `<prefix>teams/<team>/threads/<thread>/uploads/<file id>`.
 * Without one it lies in the uploader's tree until the file joins a thread or expires:
 * `<prefix>teams/<team>/users/<user>/uploads/<file id>`.
 */
export function uploadBlobKey(
  prefix: string,
  teamId: string,
  userId: string,
  threadId: string | undefined,
  fileId: string = randomUUID(),
): string {
  return threadId === undefined
    ? `${prefix}teams/${teamId}/users/${userId}/uploads/${fileId}`
    : `${prefix}teams/${teamId}/threads/${threadId}/uploads/${fileId}`;
}
