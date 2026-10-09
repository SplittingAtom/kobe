import {
  and,
  asc,
  eq,
  gt,
  isNull,
  memoryDocVersions,
  memoryDocs,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { logger } from "../logger.js";
import { readVersionContent } from "./store.js";

const PAGE = 100;

export interface ExportedMemoryFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The user's personal memory in the active team (current version of every live file), for the
 * data export (D18/D24: memory follows the user's export). Always the caller's own docs and
 * regardless of the memory switches: it is the user's data. Project memory belongs to the project,
 * not to one member, and is not part of a personal export. A file whose object is gone is left out
 * (logged), as an unreadable artifact is.
 */
export async function* personalMemoryForExport(
  db: KobeDb,
  viewer: { readonly teamId: string; readonly userId: string },
  blobs: BlobStore,
): AsyncGenerator<ExportedMemoryFile> {
  let after = "";
  for (;;) {
    const rows = await withTeam(db, viewer.teamId, (tx) =>
      tx
        .select({ path: memoryDocs.path, blobRef: memoryDocVersions.blobRef })
        .from(memoryDocs)
        .innerJoin(
          memoryDocVersions,
          and(
            eq(memoryDocVersions.teamId, memoryDocs.teamId),
            eq(memoryDocVersions.docId, memoryDocs.id),
            eq(memoryDocVersions.version, memoryDocs.currentVersion),
          ),
        )
        .where(
          and(
            eq(memoryDocs.teamId, viewer.teamId),
            eq(memoryDocs.scope, "user"),
            eq(memoryDocs.ownerUserId, viewer.userId),
            isNull(memoryDocs.deletedAt),
            gt(memoryDocs.path, after),
          ),
        )
        .orderBy(asc(memoryDocs.path))
        .limit(PAGE),
    );
    for (const row of rows) {
      const content = await readVersionContent(blobs, row.blobRef).catch(() => null);
      if (content === null) {
        logger.warn({ teamId: viewer.teamId }, "export: memory file unreadable");
        continue;
      }
      yield { path: row.path, content };
    }
    const last = rows.at(-1);
    if (!last || rows.length < PAGE) return;
    after = last.path;
  }
}
