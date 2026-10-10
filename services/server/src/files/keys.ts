/**
 * Object key of a shared file (KOBE-150), derived from verified ids, never from a path or name.
 * It lies in the thread's own tree, so the retention purge and the thread export cover it
 * (`threadKey`, retention/blobs.ts): `<prefix>teams/<team>/threads/<thread>/shared/<file id>`.
 */
export function shareBlobKey(
  prefix: string,
  teamId: string,
  threadId: string,
  fileId: string,
): string {
  return `${prefix}teams/${teamId}/threads/${threadId}/shared/${fileId}`;
}
