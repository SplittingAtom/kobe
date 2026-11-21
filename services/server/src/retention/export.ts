import { Readable } from "node:stream";
import { Zip, ZipDeflate, strToU8 } from "fflate";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { threadKey, type BlobStore } from "./blobs.js";
import { evalCasesForExport } from "./export-eval-cases.js";
import { folderPaths } from "./export-folders.js";
import { readOffloadedJson } from "../threads/offloaded-body.js";
import { logger } from "../logger.js";
import { personalMemoryForExport } from "../memory/export.js";
import { countSemanticMemoryForExport, semanticMemoryForExport } from "../memory/items-export.js";
import { learningExportJson } from "../memory/learning-export.js";
import { readableProjectsForExport, projectObject } from "./export-projects.js";
import {
  entryMarkdown,
  entryPlainText,
  threadHeader,
  type ThreadHeading,
} from "./export-markdown.js";
import {
  BRANCH_FILES_MAX,
  branchEntries,
  branchOf,
  branchedFromLine,
  excerptOf,
  inlinePayload,
  threadLabels,
  threadTree,
  type ExportBranch,
  type ThreadTree,
} from "./export-branches.js";
import { TRASH_RETENTION_DAYS } from "./periods.js";
import { artifactExtension, readArtifactBytes } from "../artifacts/serve.js";

/**
 * The user's export of their threads in the active team (spec D18): one zip with
 *  - `sessions/<thread_id>.jsonl`: Pi session format v3 (header line, then every entry in append
 *    order), so Pi can open it as a session file;
 *  - `transcripts/<date>-<title>-<id>.md`: the active branch as Markdown;
 *  - `branches/<date>-<title>-<id>/<n>-<label-or-first-words>.md`: every other leaf's path, from
 *    where it leaves the transcript (KOBE-543, CT14; `export-branches.ts`);
 *  - `artifacts/<artifact id>/v<n>.<ext>`: every version of the thread's artifacts (KOBE-129);
 *  - `files/<file id>/<name>`: the thread's uploaded and shared files (KOBE-143), streamed;
 *  - `memory/<path>`: the user's personal memory files, current versions (KOBE-155);
 *  - `memory-items.json`: the user's own semantic memories, their `user` items in this team and
 *    their portable items, with versions (KOBE-649, `memory/items-export.ts`);
 *  - `memory-learning.json`: the user's Learn from this chat records in this team: passes,
 *    candidates, dismissals, watermarks, Workspace proposals and project suggestions they made
 *    (KOBE-651, `memory/learning-export.ts`);
 *  - `projects/<slug>/commits.json` and `projects/<slug>/head/<path>`: each project the user
 *    may read, its commit list and head files (KOBE-579, GV5; `export-projects.ts`);
 *  - `feedback.json`: the user's own answer ratings in this team (KOBE-275), with their comments,
 *    on their threads and on threads shared with them (ids and the rating only, no thread content);
 *  - `eval-cases.json`: the eval cases the user shared in this team (KOBE-276), with their copies;
 *  - `threads.json` (index) and `README.md`.
 * Only threads the user owns in this team (Trash included while restorable) — never threads
 * shared with them, never another user's or team's data: every query names the team and the
 * owner. The zip is streamed: threads and entries are read page by page in short transactions, so
 * memory stays bounded whatever the size: one entry (offloaded bodies capped at 8 MiB), and per
 * thread its tree's shape (ids, parents, seq, type), the active branch's ids and one other
 * branch's ids at a time (at most 200 branch files per thread, `export-branches.ts`).
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
export const iso = (t: Timestamp): string => new Date(t).toISOString();

export interface ExportViewer {
  readonly teamId: string;
  readonly userId: string;
}

export type ThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly leaf_entry_id: string | null;
  readonly created_at: Timestamp;
  readonly last_activity_at: Timestamp;
  readonly deleted_at: Timestamp | null;
  /** The thread's team folder (KOBE-534); absent where the reader did not select it. */
  readonly folder_id?: string | null;
};

export type EntryRow = {
  readonly seq: number;
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly blob_ref: string | null;
  readonly created_at: Timestamp;
};

/** The viewer's own threads (alias `t`), live or restorable from Trash; add the team yourself. */
export const OWN_THREADS = (viewer: ExportViewer) => sql`
  t.owner_user_id = ${viewer.userId}
  AND (t.deleted_at IS NULL OR t.deleted_at > now() - ${TRASH_INTERVAL})`;

export interface ExportSummary {
  readonly threads: number;
  readonly entries: number;
  /** The person's semantic memories in the export (KOBE-649). */
  readonly memoryItems: number;
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
      memoryItems: await countSemanticMemoryForExport(tx, viewer),
    };
    await recordAudit(tx, { action: "thread.exported", teamId: viewer.teamId, target: summary });
    return summary;
  });
}

/** A title (or label, or first words: CT14) as a file-name part. */
export function slug(title: string | null): string {
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
      SELECT t.id, t.title, t.leaf_entry_id, t.created_at, t.last_activity_at, t.deleted_at,
             t.folder_id
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

export async function* entries(db: KobeDb, viewer: ExportViewer, threadId: string) {
  let after = 0;
  for (;;) {
    const rows = await entryPage(db, viewer, threadId, after);
    yield rows;
    if (rows.length < ENTRY_PAGE) return;
    after = rows.at(-1)?.seq ?? after;
  }
}

/** The entry ids on the active branch (leaf to root), walked in Postgres. */
export async function activeBranchIds(
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

/** An offloaded entry body (D15) via the shared reader; undefined when unavailable (logged). */
async function offloaded(
  blobs: BlobStore | undefined,
  viewer: ExportViewer,
  threadId: string,
  key: string,
): Promise<unknown> {
  const read = await readOffloadedJson(
    blobs,
    { teamId: viewer.teamId, threadId, reader: "export" },
    key,
    MAX_OFFLOADED_BYTES,
  );
  return read.ok ? read.body : undefined;
}

/** The stored Pi entry, or a stub that keeps the tree intact when its body is unavailable. */
export async function piEntry(
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

const FEEDBACK_PAGE = 200;

type FeedbackExportRow = {
  readonly id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly entry_id: string | null;
  readonly rating: string;
  readonly reasons: readonly string[];
  readonly comment: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
};

/** One page of the viewer's own ratings in the team (KOBE-275), by id: their rows only. */
async function feedbackPage(db: KobeDb, viewer: ExportViewer, after: string | null) {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<FeedbackExportRow>(sql`
      SELECT f.id, f.thread_id, f.run_id, f.entry_id, f.rating, f.reasons, f.comment,
             f.created_at, f.updated_at
        FROM answer_feedback f
       WHERE f.team_id = ${viewer.teamId} AND f.user_id = ${viewer.userId}
         ${after === null ? sql.raw("") : sql`AND f.id > ${after}::uuid`}
       ORDER BY f.id LIMIT ${FEEDBACK_PAGE}`);
    return res.rows;
  });
}

/** A branch's file (CT14): `branches/<transcript name>/<n>-<label-or-first-words>.md`. */
async function branchFileName(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  transcript: string,
  n: number,
  branch: ExportBranch,
  labelOf: ReadonlyMap<string, string>,
): Promise<string> {
  const dir = transcript.replace(/^transcripts\//u, "").replace(/\.md$/u, "");
  const words =
    labelOf.get(branch.first) ??
    entryPlainText(await inlinePayload(db, viewer, threadId, branch.firstShown))
      .split(/\s+/u)
      .slice(0, 8)
      .join(" ");
  return `branches/${dir}/${n}-${slug(words === "" ? "branch" : words)}.md`;
}

/**
 * The branches to write (CT14): each leaf's walk, one at a time, keeping only where it leaves the
 * transcript; at most {@link BRANCH_FILES_MAX}, `capped` when there were more.
 */
function branchPoints(tree: ThreadTree): { points: Set<string>; capped: boolean } {
  const points = new Set<string>();
  let n = 0;
  for (const leaf of tree.leaves) {
    const b = branchOf(tree, leaf);
    if (b === undefined) continue;
    n += 1;
    if (n > BRANCH_FILES_MAX) return { points, capped: true };
    if (b.from !== null) points.add(b.from);
  }
  return { points, capped: false };
}

const README = `# Your Kobe conversations

This archive holds the conversations you own in one Kobe team.

- \`sessions/<thread id>.jsonl\`: each conversation as a Pi session file (session format v3: a
  header line, then every entry, including other branches, in the order they were written).
- \`transcripts/\`: each conversation's active branch as Markdown.
- \`branches/<conversation>/\`: each other branch of a conversation as Markdown, from the
  message where it leaves the transcript (only for conversations with more than one branch).
- \`artifacts/<artifact id>/v<n>.<ext>\`: every version of the artifacts the assistant made.
- \`memory/<path>\`: your personal memory files (current versions).
- \`memory-items.json\`: your own memories (short statements Kobe knows about you): yours in this
  workspace and your portable preferences, with every kept version you wrote, the conversation of
  yours each came from, and quotes of your own messages. Memories the workspace shares, Site
  memories and anything someone else wrote are not included; an item's \`notes\` says when
  something was left out.
- \`memory-learning.json\`: what Learn from this chat kept for you in this workspace: your
  learning passes, the candidates they found for you (saved, dismissed, expired or still open),
  your dismissals and how far each conversation was read, and the workspace proposals and project
  suggestions you made with their outcome. Quotes are kept only from your own messages in your own
  conversations; who decided is not included.
- \`projects/<slug>/\`: each project you can read: \`commits.json\` (its history, newest first) and
  \`head/\` (its current files).
- \`files/<file id>/<name>\`: the files you uploaded to the conversation or the assistant shared.
- \`feedback.json\`: your thumbs up and down on answers in this team, with your reasons and
  comments (on your conversations and on ones shared with you).
- \`eval-cases.json\`: the answers you shared with agents' owners as eval cases, as shared.
- \`threads.json\`: an index (id, title, dates, folder path when filed, file names).

Entries marked \`kobe_unavailable\` had a large body Kobe could not read back from storage.
`;

/** Where the export writes: zip entries, and the compressed bytes ready to send. */
interface ZipSink {
  file(name: string): ZipDeflate;
  text(name: string, content: string): void;
  /** Hands over the bytes compressed so far (throws the zip's failure, if any). */
  drain(): Generator<Uint8Array>;
}

/** The parts of an export the threads' loop writes into (one thread at a time). */
interface ExportScope {
  readonly db: KobeDb;
  readonly viewer: ExportViewer;
  readonly blobs: BlobStore | undefined;
  readonly zip: ZipSink;
}

/** One item of a JSON array written a row at a time (`first` decides the comma). */
export function jsonArrayItem(first: boolean, value: unknown): string {
  return `${first ? "" : ","}\n    ${JSON.stringify(value)}`;
}

/** The end of a JSON array object written with {@link jsonArrayItem}. */
export function jsonArrayEnd(empty: boolean): string {
  return `${empty ? "" : "\n  "}]\n}\n`;
}

/** A thread's entry in `threads.json`. */
export function threadIndexEntry(input: {
  readonly thread: ThreadRow;
  readonly heading: ThreadHeading;
  readonly session: string;
  readonly transcript: string;
  readonly folders: ReadonlyMap<string, unknown>;
  readonly labels: readonly unknown[];
  readonly branchFiles: readonly string[];
  readonly branchesCapped: boolean;
}): Record<string, unknown> {
  const { thread, heading, folders, labels, branchFiles } = input;
  return {
    id: thread.id,
    title: thread.title,
    created_at: heading.createdAt,
    last_activity_at: heading.lastActivityAt,
    in_trash: heading.inTrash,
    // The folder path by names (KOBE-534, TF9), when the thread is filed.
    ...(thread.folder_id && folders.has(thread.folder_id)
      ? { folder: folders.get(thread.folder_id) }
      : {}),
    session: input.session,
    transcript: input.transcript,
    // CT9/CT14: only for a thread that has them (a straight thread's entry is unchanged).
    ...(labels.length > 0 ? { labels } : {}),
    ...(branchFiles.length > 0 ? { branches: branchFiles } : {}),
    ...(input.branchesCapped ? { branches_capped: true } : {}),
  };
}

/** Streams a stored object into a zip entry and closes it. */
async function* copyObject(zip: ZipSink, name: string, body: AsyncIterable<unknown>) {
  const entry = zip.file(name);
  for await (const chunk of body) {
    entry.push(new Uint8Array(chunk as Buffer));
    yield* zip.drain();
  }
  entry.push(new Uint8Array(0), true);
  yield* zip.drain();
}

/** `sessions/<id>.jsonl`: the Pi session header, then every entry in append order. */
async function* sessionFile(x: ExportScope, thread: ThreadRow, session: string) {
  const jsonl = x.zip.file(session);
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
  for await (const rows of entries(x.db, x.viewer, thread.id)) {
    // One entry at a time: at most one (capped) body is in memory.
    for (const row of rows) {
      const entry = await piEntry(row, x.blobs, x.viewer, thread.id);
      jsonl.push(strToU8(`${JSON.stringify(entry)}\n`));
      yield* x.zip.drain();
    }
  }
  jsonl.push(new Uint8Array(0), true);
}

/**
 * The transcript (the leaf's branch, CT14) and a file per other leaf's path; where each branch
 * leaves the transcript is noted from the transcript's own entries.
 */
async function* transcriptFiles(
  x: ExportScope,
  thread: ThreadRow,
  heading: ThreadHeading,
  transcript: string,
) {
  const md = x.zip.file(transcript);
  md.push(strToU8(threadHeader(heading)));
  const tree = await threadTree(x.db, x.viewer, thread.id, thread.leaf_entry_id);
  const { points, capped } = branchPoints(tree);
  const leftAt = new Map<string, { k: number; excerpt: string }>();
  let k = 0;
  let excerpt = "";
  for await (const rows of entries(x.db, x.viewer, thread.id)) {
    for (const row of rows) {
      if (!tree.main.has(row.entry_id)) continue;
      const entry = await piEntry(row, x.blobs, x.viewer, thread.id);
      const block = entryMarkdown(entry);
      if (block !== null) md.push(strToU8(`\n${block}\n`));
      const said = excerptOf(entryPlainText(entry));
      if (said !== "") {
        k += 1;
        excerpt = said;
      }
      if (points.has(row.entry_id)) leftAt.set(row.entry_id, { k, excerpt });
      yield* x.zip.drain();
    }
  }
  md.push(new Uint8Array(0), true);
  const labels = await threadLabels(x.db, x.viewer, thread.id);
  const labelOf = new Map(labels.map((l) => [l.entry_id, l.label]));
  const branchFiles: string[] = [];
  for (const leaf of tree.leaves) {
    if (branchFiles.length >= BRANCH_FILES_MAX) break;
    // One branch's ids at a time; its rows are read by key.
    const b = branchOf(tree, leaf);
    if (b === undefined) continue;
    const name = await branchFileName(
      x.db,
      x.viewer,
      thread.id,
      transcript,
      branchFiles.length + 1,
      b,
      labelOf,
    );
    branchFiles.push(name);
    yield* branchFile(x, thread.id, name, b, b.from === null ? undefined : leftAt.get(b.from));
  }
  return { labels, branchFiles, branchesCapped: capped };
}

async function* branchFile(
  x: ExportScope,
  threadId: string,
  name: string,
  b: ExportBranch,
  from: { k: number; excerpt: string } | undefined,
) {
  const out = x.zip.file(name);
  out.push(strToU8(`${branchedFromLine(from)}\n`));
  for await (const rows of branchEntries(x.db, x.viewer, threadId, b.ids)) {
    for (const row of rows) {
      const block = entryMarkdown(await piEntry(row, x.blobs, x.viewer, threadId));
      if (block !== null) out.push(strToU8(`\n${block}\n`));
      yield* x.zip.drain();
    }
  }
  out.push(new Uint8Array(0), true);
  yield* x.zip.drain();
}

/** `artifacts/<id>/v<n>.<ext>`: every version; an unreadable body is left out. */
async function* artifactFiles(x: ExportScope, threadId: string) {
  const { blobs, viewer } = x;
  let after: { artifactId: string; version: number } | null = null;
  for (;;) {
    const versions = await artifactVersionPage(x.db, viewer, threadId, after);
    for (const v of versions) {
      const bytes = blobs
        ? await readArtifactBytes(blobs, viewer.teamId, threadId, v.blob_ref).catch(
            (err: unknown) => {
              logger.warn({ err, teamId: viewer.teamId, threadId }, "export: artifact unreadable");
              return undefined;
            },
          )
        : undefined;
      const name = `artifacts/${v.artifact_id}/v${v.version}.${artifactExtension(v.kind, v.language)}`;
      // A missing body is left out of the archive (as an unreadable offloaded entry is marked).
      if (bytes) x.zip.file(name).push(new Uint8Array(bytes), true);
      yield* x.zip.drain();
    }
    if (versions.length < ARTIFACT_PAGE) break;
    const last = versions.at(-1);
    after = last ? { artifactId: last.artifact_id, version: last.version } : null;
    if (!after) break;
  }
}

/** `files/<id>/<name>`: the thread's uploaded and shared files; a missing object is left out. */
async function* threadFiles(x: ExportScope, threadId: string) {
  const { blobs, viewer } = x;
  let after: string | null = null;
  for (;;) {
    const page = await filePage(x.db, viewer, threadId, after);
    for (const f of page) {
      const object =
        blobs && threadKey(blobs.prefix, viewer.teamId, threadId, f.blob_ref)
          ? await blobs.objects.get(f.blob_ref).catch((err: unknown) => {
              logger.warn({ err, teamId: viewer.teamId }, "export: file unreadable");
              return null;
            })
          : null;
      // A missing object is left out of the archive, as an unreadable artifact is.
      if (!object) continue;
      yield* copyObject(x.zip, `files/${f.id}/${f.name}`, object.body);
    }
    after = page.at(-1)?.id ?? null;
    if (page.length < FILE_PAGE || after === null) break;
  }
}

/** Everything one thread contributes; returns its `threads.json` entry. */
async function* threadExport(
  x: ExportScope,
  thread: ThreadRow,
  folders: ReadonlyMap<string, unknown>,
) {
  const session = `sessions/${thread.id}.jsonl`;
  const transcript = transcriptName(thread);
  yield* sessionFile(x, thread, session);
  const heading: ThreadHeading = {
    threadId: thread.id,
    title: thread.title,
    createdAt: iso(thread.created_at),
    lastActivityAt: iso(thread.last_activity_at),
    inTrash: thread.deleted_at !== null,
  };
  const branches = yield* transcriptFiles(x, thread, heading, transcript);
  yield* artifactFiles(x, thread.id);
  yield* threadFiles(x, thread.id);
  return threadIndexEntry({ thread, heading, session, transcript, folders, ...branches });
}

/** The feedback array, page by page (ids and the rating only, no thread content). */
async function* feedbackFile(x: ExportScope) {
  const feedback = x.zip.file("feedback.json");
  feedback.push(strToU8('{\n  "feedback": ['));
  let after: string | null = null;
  let first = true;
  for (;;) {
    const page = await feedbackPage(x.db, x.viewer, after);
    for (const f of page) {
      const row = {
        thread_id: f.thread_id,
        run_id: f.run_id,
        entry_id: f.entry_id,
        rating: f.rating,
        reasons: f.reasons,
        comment: f.comment,
        created_at: iso(f.created_at),
        updated_at: iso(f.updated_at),
      };
      feedback.push(strToU8(jsonArrayItem(first, row)));
      first = false;
    }
    yield* x.zip.drain();
    after = page.at(-1)?.id ?? null;
    if (page.length < FEEDBACK_PAGE || after === null) break;
  }
  feedback.push(strToU8(jsonArrayEnd(first)), true);
}

/** A JSON array object (`{"<key>": [...]}`) from pages of rows. */
async function* jsonArrayFile(
  x: ExportScope,
  name: string,
  key: string,
  pages: AsyncIterable<readonly unknown[]>,
) {
  const out = x.zip.file(name);
  out.push(strToU8(`{\n  "${key}": [`));
  let first = true;
  for await (const page of pages) {
    for (const row of page) {
      out.push(strToU8(jsonArrayItem(first, row)));
      first = false;
    }
    yield* x.zip.drain();
  }
  out.push(strToU8(jsonArrayEnd(first)), true);
}

/** The person's memory files and the projects they may read (object storage only). */
async function* storedFiles(x: ExportScope, blobs: BlobStore) {
  for await (const m of personalMemoryForExport(x.db, x.viewer, blobs)) {
    x.zip.text(`memory/${m.path}`, m.content);
    yield* x.zip.drain();
  }
  // GV5 (KOBE-579): the projects the viewer may read, their commit list and head files.
  for await (const p of readableProjectsForExport(x.db, x.viewer)) {
    x.zip.text(`projects/${p.slug}/commits.json`, `${JSON.stringify(p.meta, null, 2)}\n`);
    for (const f of p.files) {
      const object = await projectObject(blobs, x.viewer.teamId, p.meta.id, f.blobRef);
      if (!object) continue;
      yield* copyObject(x.zip, `projects/${p.slug}/head/${f.path}`, object.body);
    }
  }
}

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
  const sink: ZipSink = {
    file: (name) => {
      const f = new ZipDeflate(name, { level: 6 });
      f.mtime = new Date();
      zip.add(f);
      return f;
    },
    text: (name, content) => sink.file(name).push(strToU8(content), true),
    drain: function* () {
      if (failure) throw failure;
      while (out.length > 0) yield out.shift() as Uint8Array;
    },
  };
  const x: ExportScope = { db, viewer, blobs, zip: sink };

  sink.text("README.md", README);
  const index: Record<string, unknown>[] = [];
  const folders = await folderPaths(db, viewer.teamId);
  let after: string | null = null;
  for (;;) {
    const threads = await threadPage(db, viewer, after);
    for (const thread of threads) {
      index.push(yield* threadExport(x, thread, folders));
      yield* sink.drain();
    }
    if (threads.length < THREAD_PAGE) break;
    after = threads.at(-1)?.id ?? after;
  }
  if (blobs) yield* storedFiles(x, blobs);
  // KOBE-649: the person's own semantic memories (no object storage needed).
  yield* jsonArrayFile(x, "memory-items.json", "items", semanticMemoryForExport(db, viewer));
  // KOBE-651: the person's Learn from this chat records.
  const learning = sink.file("memory-learning.json");
  for await (const chunk of learningExportJson(db, viewer)) {
    learning.push(strToU8(chunk));
    yield* sink.drain();
  }
  learning.push(new Uint8Array(0), true);
  yield* feedbackFile(x);
  yield* jsonArrayFile(x, "eval-cases.json", "cases", evalCasesForExport(db, viewer));
  sink.text("threads.json", `${JSON.stringify({ threads: index }, null, 2)}\n`);
  zip.end();
  yield* sink.drain();
}

/** The export as a web stream for a Response body. */
export function exportResponseBody(
  db: KobeDb,
  viewer: ExportViewer,
  blobs: BlobStore | undefined,
): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(exportZip(db, viewer, blobs))) as ReadableStream<Uint8Array>;
}
