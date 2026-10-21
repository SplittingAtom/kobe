import type { Readable } from "node:stream";
import { withTeam, type KobeDb } from "@kobe/db";
import { VIEWING_CONTENT_MAX_BYTES, type RunViewingContext } from "@kobe/protocol";
import { logger } from "../logger.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { currentEntry } from "../workspace-sync/store.js";
import { isInternalPath } from "./paths.js";

/**
 * The viewed-file context of a message (KOBE-462, spec FE6): the file the member has open, read
 * from their synced workspace when they send. Bounded to {@link VIEWING_CONTENT_MAX_BYTES}; text
 * only (valid UTF-8 without NUL, else no content). Nothing is read for agent-internal paths or a
 * file that is not synced; a storage error means no context (the message still goes).
 */
export type ViewingReader = (
  owner: WorkspaceOwner,
  path: string,
) => Promise<RunViewingContext | undefined>;

/** Reads at most `max` bytes of `body`, then stops the stream. */
async function headOf(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      length += buf.length;
      if (length >= max) break;
    }
  } finally {
    body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, max);
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * The text of `head`, or undefined when it is not text (NUL, or not UTF-8). When the file goes on
 * (`cut`), up to 3 bytes of a character split by the cut are dropped.
 */
export function textOf(head: Buffer, cut: boolean): string | undefined {
  if (head.includes(0)) return undefined;
  for (let drop = 0; drop <= (cut ? 3 : 0); drop += 1) {
    try {
      return DECODER.decode(head.subarray(0, head.length - drop));
    } catch {
      // try one byte shorter
    }
  }
  return undefined;
}

export function createViewingReader(
  db: KobeDb,
  sync: WorkspaceSync,
  maxBytes = VIEWING_CONTENT_MAX_BYTES,
): ViewingReader {
  return async (owner, path) => {
    if (isInternalPath(path)) return undefined;
    const entry = await withTeam(db, owner.teamId, (tx) => currentEntry(tx, owner, path));
    if (!entry || entry.deleted || entry.blobKey === null || entry.sha256 === undefined) {
      return undefined;
    }
    try {
      const object = await sync.objects.get(entry.blobKey);
      if (!object) return undefined;
      const head = await headOf(object.body, maxBytes);
      const truncated = entry.size > head.length;
      const content = textOf(head, truncated);
      return {
        path,
        sha256: entry.sha256,
        size: entry.size,
        ...(content === undefined ? {} : { content }),
        truncated: content !== undefined && truncated,
      };
    } catch (err) {
      logger.warn({ err, teamId: owner.teamId }, "viewed file unreadable; sent without it");
      return undefined;
    }
  };
}
