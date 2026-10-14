import { and, eq, threadEntries, type KobeTx } from "@kobe/db";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";

/** Largest offloaded body the chat reads back (bytes); a tool output beyond it stays a preview. */
export const MAX_ENTRY_BODY_BYTES = 8 * 1024 * 1024;

/** An entry of the thread, or null when the thread has none with that id. */
export async function findEntry(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string,
): Promise<{ readonly payload: unknown; readonly blobRef: string | null } | null> {
  const [row] = await tx
    .select({ payload: threadEntries.payload, blobRef: threadEntries.blobRef })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, teamId),
        eq(threadEntries.threadId, threadId),
        eq(threadEntries.entryId, entryId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * An offloaded entry body (D15) read back for the chat (KOBE-208): only from the thread's own
 * object tree (`threadKey`), so a crafted reference can't reach another thread's, member's or
 * team's objects; read with a byte cap and parsed as JSON. Undefined when it can't be read: no
 * object store, a key outside the tree, a missing or oversized object, or a body that isn't JSON.
 */
export async function readEntryBody(
  blobs: BlobStore | undefined,
  teamId: string,
  threadId: string,
  key: string,
): Promise<unknown> {
  if (!blobs || !threadKey(blobs.prefix, teamId, threadId, key)) return undefined;
  try {
    const object = await blobs.objects.get(key);
    if (!object) return undefined;
    if (object.size > MAX_ENTRY_BODY_BYTES) {
      object.body.destroy();
      return undefined;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of object.body) {
      const b = Buffer.from(chunk as Uint8Array);
      bytes += b.length;
      if (bytes > MAX_ENTRY_BODY_BYTES) {
        object.body.destroy();
        return undefined;
      }
      chunks.push(b);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (err) {
    logger.warn({ err, teamId, threadId }, "offloaded entry body unreadable");
    return undefined;
  }
}
