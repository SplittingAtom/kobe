/**
 * Object key of one memory version (KOBE-154): `<prefix>teams/<team>/memory/<doc>/<version>`.
 * Derived here, never named by a client. Deliberately outside `…/threads/<thread>/`, so the
 * thread purge never deletes memory (and `threadKey` refuses these keys).
 */
export function memoryBlobKey(
  prefix: string,
  teamId: string,
  docId: string,
  version: number,
): string {
  return `${prefix}teams/${teamId}/memory/${docId}/${version}`;
}
