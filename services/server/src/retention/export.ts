import { Readable } from "node:stream";
import { Zip, ZipDeflate, strToU8 } from "fflate";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { threadKey, type BlobStore } from "./blobs.js";
import { logger } from "../logger.js";
import { personalMemoryForExport } from "../memory/export.js";
import { entryMarkdown, threadHeader, type ThreadHeading } from "./export-markdown.js";
import { TRASH_RETENTION_DAYS } from "./periods.js";
import { artifactExtension, readArtifactBytes } from "../artifacts/serve.js";

/**
 * The user's export of their threads in the active team (spec D18): one zip with
 *  - `sessions/<thread_id>.jsonl`: Pi session format v3 (header line, then every entry in append
 *    order), so Pi can open it as a session file;
 *  - `transcripts/<date>-<title>-<id>.md`: the active branch as Markdown;
 *  - `artifacts/<artifact id>/v<n>.<ext>`: every version of the thread's artifacts (KOBE-129);
 *  - `files/<file id>/<name>`: the thread's uploaded and shared files (KOBE-143), streamed;
 *  - `memory/<path>`: the user's personal memory files, current versions (KOBE-155);
 *  - `threads.json` (index) and `README.md`.
 * Only threads the user owns in this team (Trash included while restorable) — never threads
 * shared with them, never another user's or team's data: every query names the team and the
 * owner. The zip is streamed: threads and entries are read page by page in short transactions, so
 * memory stays bounded whatever the size: one entry (offloaded bodies capped at 8 MiB) and the
 * active branch's ids per thread.
 */

const THREAD_PAGE = 100;
const ENTRY_PAGE = 50;
/** Largest offloaded entry body read back from object storage (counted as it is read). */
const MAX_OFFLOADED_BYTES = 8 * 1024 * 1024;
/** Longest active branch followed for the Markdown transcript. */
const MAX_BRANCH_DEPTH = 100_000;
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

/** The entry ids on the active branch (leaf to root), walked in Postgres. */
async function activeBranchIds(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  leaf: string | null,
): Promise<Set<string>> {
  if (leaf === null) return new Set();
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<{ entry_id: string }>(sql`
      WITH RECURSIVE b (entry_id, parent_id, depth) AS (
        SELECT e.entry_id, e.parent_id, 1 FROM thread_entries e
         WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId} AND e.entry_id = ${leaf}
        UNION ALL
        SELECT p.entry_id, p.parent_id, b.depth + 1 FROM b
          JOIN thread_entries p ON p.team_id = ${viewer.teamId} AND p.thread_id = ${threadId}
                               AND p.entry_id = b.parent_id
         WHERE b.depth < ${MAX_BRANCH_DEPTH})
      SELECT entry_id FROM b`);
    return new Set(res.rows.map((r) => r.entry_id));
  });
}

/**
 * An offloaded entry body (D15), only from the thread's own object tree (`threadKey`), read with a
 * byte cap; undefined when unavailable (logged).
 */
async function offloaded(
  blobs: BlobStore | undefined,
  viewer: ExportViewer,
  threadId: string,
  key: string,
): Promise<unknown> {
  if (!blobs || !threadKey(blobs.prefix, viewer.teamId, threadId, key)) return undefined;
  try {
    const object = await blobs.objects.get(key);
    if (!object) return undefined;
    if (object.size > MAX_OFFLOADED_BYTES) {
      object.body.destroy();
      return undefined;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of object.body) {
      const b = Buffer.from(chunk as Uint8Array);
      bytes += b.length;
      if (bytes > MAX_OFFLOADED_BYTES) {
        object.body.destroy();
        return undefined;
      }
      chunks.push(b);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (err) {
    logger.warn({ err, teamId: viewer.teamId, threadId }, "export: offloaded entry unreadable");
    return undefined;
  }
}

/** The stored Pi entry, or a stub that keeps the tree intact when its body is unavailable. */
async function piEntry(
  row: EntryRow,
  blobs: BlobStore | undefined,
  viewer: ExportViewer,
  threadId: string,
) {
  const body =
    row.blob_ref === null ? row.payload : await offloaded(blobs, viewer, threadId, row.blob_ref);
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

const ARTIFACT_PAGE = 50;

type ArtifactVersionRow = {
  readonly artifact_id: string;
  readonly version: number;
  readonly blob_ref: string;
  readonly kind: string;
  readonly language: string | null;
};

/** One page of the thread's artifact versions in (artifact, version) order, owner re-checked. */
async function artifactVersionPage(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  after: { artifactId: string; version: number } | null,
) {
  const cursor =
    after === null
      ? sql.raw("")
      : sql`AND (v.artifact_id, v.version) > (${after.artifactId}::uuid, ${after.version}::int)`;
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<ArtifactVersionRow>(sql`
      SELECT v.artifact_id, v.version, v.blob_ref, a.kind, a.language
        FROM artifact_versions v
        JOIN artifacts a ON a.team_id = v.team_id AND a.id = v.artifact_id
        JOIN threads t ON t.team_id = v.team_id AND t.id = v.thread_id
       WHERE v.team_id = ${viewer.teamId} AND v.thread_id = ${threadId}
         AND a.team_id = ${viewer.teamId} AND t.team_id = ${viewer.teamId}
         AND ${OWN_THREADS(viewer)} ${cursor}
       ORDER BY v.artifact_id, v.version LIMIT ${ARTIFACT_PAGE}`);
    return res.rows;
  });
}

const FILE_PAGE = 50;

type FileRow = { readonly id: string; readonly name: string; readonly blob_ref: string };

/** One page of the thread's files (uploads and shared), by id, owner re-checked. */
async function filePage(db: KobeDb, viewer: ExportViewer, threadId: string, after: string | null) {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<FileRow>(sql`
      SELECT f.id, f.name, f.blob_ref
        FROM files f JOIN threads t ON t.team_id = f.team_id AND t.id = f.thread_id
       WHERE f.team_id = ${viewer.teamId} AND f.thread_id = ${threadId}
         AND t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}
         ${after === null ? sql.raw("") : sql`AND f.id > ${after}::uuid`}
       ORDER BY f.id LIMIT ${FILE_PAGE}`);
    return res.rows;
  });
}

const README = `# Your Kobe conversations

This archive holds the conversations you own in one Kobe team.

- \`sessions/<thread id>.jsonl\`: each conversation as a Pi session file (session format v3: a
  header line, then every entry, including other branches, in the order they were written).
- \`transcripts/\`: each conversation's active branch as Markdown.
- \`artifacts/<artifact id>/v<n>.<ext>\`: every version of the artifacts the assistant made.
- \`memory/<path>\`: your personal memory files (current versions).
- \`files/<file id>/<name>\`: the files you uploaded to the conversation or the assistant shared.
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
        // One entry at a time: at most one (capped) body is in memory.
        for (const row of rows) {
          const entry = await piEntry(row, blobs, viewer, thread.id);
          jsonl.push(strToU8(`${JSON.stringify(entry)}\n`));
          yield* drain();
        }
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
      const branch = await activeBranchIds(db, viewer, thread.id, thread.leaf_entry_id);
      for await (const rows of entries(db, viewer, thread.id)) {
        for (const row of rows) {
          if (!branch.has(row.entry_id)) continue;
          const block = entryMarkdown(await piEntry(row, blobs, viewer, thread.id));
          if (block !== null) md.push(strToU8(`\n${block}\n`));
          yield* drain();
        }
      }
      md.push(new Uint8Array(0), true);
      let afterVersion: { artifactId: string; version: number } | null = null;
      for (;;) {
        const versions = await artifactVersionPage(db, viewer, thread.id, afterVersion);
        for (const v of versions) {
          const bytes = blobs
            ? await readArtifactBytes(blobs, viewer.teamId, thread.id, v.blob_ref).catch(
                (err: unknown) => {
                  logger.warn(
                    { err, teamId: viewer.teamId, threadId: thread.id },
                    "export: artifact unreadable",
                  );
                  return undefined;
                },
              )
            : undefined;
          const name = `artifacts/${v.artifact_id}/v${v.version}.${artifactExtension(v.kind, v.language)}`;
          // A missing body is left out of the archive (as an unreadable offloaded entry is marked).
          if (bytes) file(name).push(new Uint8Array(bytes), true);
          yield* drain();
        }
        if (versions.length < ARTIFACT_PAGE) break;
        const last = versions.at(-1);
        afterVersion = last ? { artifactId: last.artifact_id, version: last.version } : null;
        if (!afterVersion) break;
      }
      let afterFile: string | null = null;
      for (;;) {
        const page = await filePage(db, viewer, thread.id, afterFile);
        for (const f of page) {
          const object =
            blobs && threadKey(blobs.prefix, viewer.teamId, thread.id, f.blob_ref)
              ? await blobs.objects.get(f.blob_ref).catch((err: unknown) => {
                  logger.warn({ err, teamId: viewer.teamId }, "export: file unreadable");
                  return null;
                })
              : null;
          // A missing object is left out of the archive, as an unreadable artifact is.
          if (!object) continue;
          const entry = file(`files/${f.id}/${f.name}`);
          for await (const chunk of object.body) {
            entry.push(new Uint8Array(chunk as Buffer));
            yield* drain();
          }
          entry.push(new Uint8Array(0), true);
          yield* drain();
        }
        afterFile = page.at(-1)?.id ?? null;
        if (page.length < FILE_PAGE || afterFile === null) break;
      }
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
  if (blobs) {
    for await (const m of personalMemoryForExport(db, viewer, blobs)) {
      text(`memory/${m.path}`, m.content);
      yield* drain();
    }
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
