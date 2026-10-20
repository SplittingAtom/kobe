import { Readable } from "node:stream";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { BlobStore } from "./blobs.js";
import {
  OWN_THREADS,
  activeBranchIds,
  entries,
  iso,
  piEntry,
  transcriptName,
  type ExportViewer,
  type ThreadRow,
} from "./export.js";
import { entryMarkdown, threadHeader } from "./export-markdown.js";

/**
 * One conversation as Markdown (`/export`, KOBE-450; Pi's `/export` mapped to Kobe): the owner's
 * thread in the active team, its active branch rendered as in the full export's transcripts
 * (D18). Owner only, like the full export: a project reader or anyone else gets "not found", and
 * nothing is read or recorded for them. Streamed one entry at a time.
 */

export type ThreadToExport = ThreadRow & { readonly entries: number };

/**
 * The owner's thread, audited (`thread.transcript_exported`, a count only) before the download
 * starts; null when the viewer does not own such a thread in this team (nothing is recorded).
 */
export async function recordThreadExport(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
): Promise<ThreadToExport | null> {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<ThreadRow & { readonly last_entry_seq: number | string }>(sql`
      SELECT t.id, t.title, t.leaf_entry_id, t.created_at, t.last_activity_at, t.deleted_at,
             t.last_entry_seq
        FROM threads t
       WHERE t.team_id = ${viewer.teamId} AND t.id = ${threadId} AND ${OWN_THREADS(viewer)}`);
    const row = res.rows[0];
    if (row === undefined) return null;
    const { last_entry_seq: seq, ...thread } = row;
    const found = { ...thread, entries: Number(seq) };
    await recordAudit(tx, {
      action: "thread.transcript_exported",
      teamId: viewer.teamId,
      target: { threadId, entries: found.entries },
    });
    return found;
  });
}

/** The download's file name: the transcript's name in the full export, without its folder. */
export function threadExportFileName(thread: ThreadToExport): string {
  return transcriptName(thread).replace(/^transcripts\//u, "");
}

async function* transcript(
  db: KobeDb,
  viewer: ExportViewer,
  blobs: BlobStore | undefined,
  thread: ThreadToExport,
): AsyncGenerator<string> {
  yield threadHeader({
    threadId: thread.id,
    title: thread.title,
    createdAt: iso(thread.created_at),
    lastActivityAt: iso(thread.last_activity_at),
    inTrash: thread.deleted_at !== null,
  });
  const branch = await activeBranchIds(db, viewer, thread.id, thread.leaf_entry_id);
  for await (const rows of entries(db, viewer, thread.id)) {
    for (const row of rows) {
      if (!branch.has(row.entry_id)) continue;
      const block = entryMarkdown(await piEntry(row, blobs, viewer, thread.id));
      if (block !== null) yield `\n${block}\n`;
    }
  }
}

/** The transcript as a web stream for a Response body. */
export function threadExportBody(
  db: KobeDb,
  viewer: ExportViewer,
  blobs: BlobStore | undefined,
  thread: ThreadToExport,
): ReadableStream<Uint8Array> {
  const bytes = async function* () {
    const encoder = new TextEncoder();
    for await (const text of transcript(db, viewer, blobs, thread)) yield encoder.encode(text);
  };
  return Readable.toWeb(Readable.from(bytes())) as ReadableStream<Uint8Array>;
}
