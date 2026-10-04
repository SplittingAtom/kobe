import { Readable } from "node:stream";
import { Zip, ZipDeflate, strToU8 } from "fflate";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { ownedKey, type BlobStore } from "./blobs.js";
import {
  activeBranch,
  entryMarkdown,
  threadHeader,
  type ThreadHeading,
} from "./export-markdown.js";
import { TRASH_RETENTION_DAYS } from "./periods.js";

/**
 * The user's export of their threads in the active team (spec D18): one zip with
 *  - `sessions/<thread_id>.jsonl`: Pi session format v3 (header line, then every entry in append
 *    order), so Pi can open it as a session file;
 *  - `transcripts/<date>-<title>-<id>.md`: the active branch as Markdown;
 *  - `threads.json` (index) and `README.md`.
 * Only threads the user owns in this team (Trash included while restorable) — never threads
 * shared with them, never another user's or team's data: every query names the team and the
 * owner. The zip is streamed: threads and entries are read page by page in short transactions, so
 * memory stays bounded whatever the size.
 */

const THREAD_PAGE = 100;
const ENTRY_PAGE = 200;
/** Largest offloaded entry body read back from object storage. */
const MAX_OFFLOADED_BYTES = 64 * 1024 * 1024;
const TRASH_INTERVAL = sql.raw(`interval '${TRASH_RETENTION_DAYS} days'`);

/** Raw queries return timestamps as text (or Date, depending on the driver's parsers). */
type Timestamp = Date | string;
const iso = (t: Timestamp): string => new Date(t).toISOString();

export interface ExportViewer {
  readonly teamId: string;
  readonly userId: string;
}

type ThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly leaf_entry_id: string | null;
  readonly created_at: Timestamp;
  readonly last_activity_at: Timestamp;
  readonly deleted_at: Timestamp | null;
};

type EntryRow = {
  readonly seq: number;
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly blob_ref: string | null;
  readonly created_at: Timestamp;
};

/** The viewer's own threads (alias `t`), live or restorable from Trash; add the team yourself. */
const OWN_THREADS = (viewer: ExportViewer) => sql`
  t.owner_user_id = ${viewer.userId}
  AND (t.deleted_at IS NULL OR t.deleted_at > now() - ${TRASH_INTERVAL})`;

export interface ExportSummary {
  readonly threads: number;
  readonly entries: number;
}

/** Counts what the export holds and audits it (`thread.exported`) before the download starts. */
export async function recordExport(db: KobeDb, viewer: ExportViewer): Promise<ExportSummary> {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<{ threads: string; entries: string | null }>(sql`
      SELECT count(*) AS threads, sum(t.last_entry_seq) AS entries
        FROM threads t WHERE t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}`);
    const summary = {
      threads: Number(res.rows[0]?.threads ?? 0),
      entries: Number(res.rows[0]?.entries ?? 0),
    };
    await recordAudit(tx, { action: "thread.exported", teamId: viewer.teamId, target: summary });
    return summary;
  });
}

function slug(title: string | null): string {
  const s = (title ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s === "" ? "conversation" : s;
}

export function transcriptName(thread: {
  readonly id: string;
  readonly title: string | null;
  readonly created_at: Timestamp;
}): string {
  const day = iso(thread.created_at).slice(0, 10);
  return `transcripts/${day}-${slug(thread.title)}-${thread.id.slice(0, 8)}.md`;
}

async function threadPage(db: KobeDb, viewer: ExportViewer, after: string | null) {
  const cursor = after === null ? sql.raw("") : sql`AND t.id > ${after}`;
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<ThreadRow>(sql`
      SELECT t.id, t.title, t.leaf_entry_id, t.created_at, t.last_activity_at, t.deleted_at
        FROM threads t
       WHERE t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)} ${cursor}
       ORDER BY t.id LIMIT ${THREAD_PAGE}`);
    return res.rows;
  });
}

async function entryPage(db: KobeDb, viewer: ExportViewer, threadId: string, after: number) {
  return withTeam(db, viewer.teamId, async (tx) => {
    // The join re-checks ownership on every page: a thread re-owned or purged meanwhile stops.
    const res = await tx.execute<EntryRow>(sql`
      SELECT e.seq, e.entry_id, e.parent_id, e.type, e.payload, e.blob_ref, e.created_at
        FROM thread_entries e
        JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id
       WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId} AND e.seq > ${after}
         AND t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}
       ORDER BY e.seq LIMIT ${ENTRY_PAGE}`);
    return res.rows;
  });
}

async function* entries(db: KobeDb, viewer: ExportViewer, threadId: string) {
  let after = 0;
  for (;;) {
    const rows = await entryPage(db, viewer, threadId, after);
    yield rows;
    if (rows.length < ENTRY_PAGE) return;
    after = rows.at(-1)?.seq ?? after;
  }
}

async function parentsOf(db: KobeDb, viewer: ExportViewer, threadId: string) {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<{ entry_id: string; parent_id: string | null }>(sql`
      SELECT e.entry_id, e.parent_id FROM thread_entries e
       WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId}`);
    return new Map(res.rows.map((r) => [r.entry_id, r.parent_id]));
  });
}

/** An offloaded entry body (D15), only from the viewer's own keys; undefined if unavailable. */
async function offloaded(
  blobs: BlobStore | undefined,
  viewer: ExportViewer,
  key: string,
): Promise<unknown> {
  if (!blobs || !ownedKey(blobs.prefix, viewer.teamId, viewer.userId, key)) return undefined;
  const object = await blobs.objects.get(key).catch(() => null);
  if (!object || object.size > MAX_OFFLOADED_BYTES) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** The stored Pi entry, or a stub that keeps the tree intact when its body is unavailable. */
async function piEntry(row: EntryRow, blobs: BlobStore | undefined, viewer: ExportViewer) {
  const body = row.blob_ref === null ? row.payload : await offloaded(blobs, viewer, row.blob_ref);
  const entry = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
  return {
    ...entry,
    type: row.type,
    id: row.entry_id,
    parentId: row.parent_id,
    timestamp:
      typeof (entry as { timestamp?: unknown }).timestamp === "string"
        ? (entry as { timestamp: string }).timestamp
        : iso(row.created_at),
    ...(row.blob_ref !== null && body === undefined ? { kobe_unavailable: true } : {}),
  };
}

const README = `# Your Kobe conversations

This archive holds the conversations you own in one Kobe team.

- \`sessions/<thread id>.jsonl\`: each conversation as a Pi session file (session format v3: a
  header line, then every entry, including other branches, in the order they were written).
- \`transcripts/\`: each conversation's active branch as Markdown.
- \`threads.json\`: an index (id, title, dates, file names).

Entries marked \`kobe_unavailable\` had a large body Kobe could not read back from storage.
`;

/**
 * The zip as a byte stream. Pull-driven: each page is read when the client has taken the previous
 * bytes, so a slow download holds no more than a page in memory.
 */
export async function* exportZip(
  db: KobeDb,
  viewer: ExportViewer,
  blobs: BlobStore | undefined,
): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else out.push(data);
  });
  const drain = function* () {
    if (failure) throw failure;
    while (out.length > 0) yield out.shift() as Uint8Array;
  };
  const file = (name: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    f.mtime = new Date();
    zip.add(f);
    return f;
  };
  const text = (name: string, content: string) => file(name).push(strToU8(content), true);

  text("README.md", README);
  const index: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (;;) {
    const threads = await threadPage(db, viewer, after);
    for (const thread of threads) {
      const session = `sessions/${thread.id}.jsonl`;
      const transcript = transcriptName(thread);
      const jsonl = file(session);
      jsonl.push(
        strToU8(
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: thread.id,
            timestamp: iso(thread.created_at),
            cwd: "/workspace",
          })}\n`,
        ),
      );
      for await (const rows of entries(db, viewer, thread.id)) {
        const lines: string[] = [];
        for (const row of rows) lines.push(JSON.stringify(await piEntry(row, blobs, viewer)));
        if (lines.length > 0) jsonl.push(strToU8(`${lines.join("\n")}\n`));
        yield* drain();
      }
      jsonl.push(new Uint8Array(0), true);

      const heading: ThreadHeading = {
        threadId: thread.id,
        title: thread.title,
        createdAt: iso(thread.created_at),
        lastActivityAt: iso(thread.last_activity_at),
        inTrash: thread.deleted_at !== null,
      };
      const md = file(transcript);
      md.push(strToU8(threadHeader(heading)));
      const branch = activeBranch(await parentsOf(db, viewer, thread.id), thread.leaf_entry_id);
      for await (const rows of entries(db, viewer, thread.id)) {
        const blocks: string[] = [];
        for (const row of rows) {
          if (!branch.has(row.entry_id)) continue;
          const block = entryMarkdown(await piEntry(row, blobs, viewer));
          if (block !== null) blocks.push(block);
        }
        if (blocks.length > 0) md.push(strToU8(`\n${blocks.join("\n\n")}\n`));
        yield* drain();
      }
      md.push(new Uint8Array(0), true);
      index.push({
        id: thread.id,
        title: thread.title,
        created_at: heading.createdAt,
        last_activity_at: heading.lastActivityAt,
        in_trash: heading.inTrash,
        session,
        transcript,
      });
      yield* drain();
    }
    if (threads.length < THREAD_PAGE) break;
    after = threads.at(-1)?.id ?? after;
  }
  text("threads.json", `${JSON.stringify({ threads: index }, null, 2)}\n`);
  zip.end();
  yield* drain();
}

/** The export as a web stream for a Response body. */
export function exportResponseBody(
  db: KobeDb,
  viewer: ExportViewer,
  blobs: BlobStore | undefined,
): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(exportZip(db, viewer, blobs))) as ReadableStream<Uint8Array>;
}
