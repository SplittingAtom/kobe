import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { ExportViewer } from "./export.js";

/**
 * Every branch in the export (KOBE-543, docs/specs/conversation-tree.md CT14). The transcript
 * stays the leaf's branch; each other leaf's path gets its own file under
 * `branches/<date>-<title>-<id>/<n>-<label-or-first-words>.md`, holding what that path adds after
 * it leaves the main transcript, and starting with the line that says where it left it.
 *
 * The walk reads only the tree's shape (ids, parents, order, type) page by page and keeps every
 * leaf's id set; bodies are still read one entry at a time by the export's paged reader.
 */

const SHAPE_PAGE = 5_000;
/** The excerpt of the message a branch left from (§5's node excerpt). */
export const BRANCH_EXCERPT_CHARS = 120;

type ShapeRow = {
  readonly seq: number;
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly type: string;
};

export interface ExportBranch {
  /** 1-based, in the order the branches' leaves were written. */
  readonly n: number;
  /** The entries this path adds after it leaves the main transcript. */
  readonly ids: ReadonlySet<string>;
  /** The entry of the main transcript it leaves from; null: it shares none (another root). */
  readonly from: string | null;
  /** The seq of `from` (0 when null): every entry of the branch comes after it. */
  readonly afterSeq: number;
  /** Its first entry (where a label would sit, CT9). */
  readonly first: string;
  /** Its first entry a transcript shows (for the file name's first words). */
  readonly firstShown: string;
}

export interface ThreadBranches {
  /** The entry ids of the main transcript (the leaf's branch). */
  readonly main: ReadonlySet<string>;
  readonly branches: readonly ExportBranch[];
}

async function shapePage(db: KobeDb, viewer: ExportViewer, threadId: string, after: number) {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<ShapeRow>(sql`
      SELECT e.seq, e.entry_id, e.parent_id, e.type
        FROM thread_entries e
       WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId} AND e.seq > ${after}
       ORDER BY e.seq LIMIT ${SHAPE_PAGE}`);
    return res.rows;
  });
}

/** Entry types a transcript can show: a branch made only of markers (a ghost node) adds no file. */
const SHOWN_TYPES: ReadonlySet<string> = new Set(["message", "custom_message"]);

/** The main path and every other leaf's path (CT14); pure, for the walk and its tests. */
export function branchesOf(rows: readonly ShapeRow[], leaf: string | null): ThreadBranches {
  const byId = new Map(rows.map((r) => [r.entry_id, r]));
  const parents = new Set<string>();
  for (const r of rows) if (r.parent_id !== null) parents.add(r.parent_id);
  const main = new Set<string>();
  for (let at = leaf === null ? undefined : byId.get(leaf); at;) {
    if (main.has(at.entry_id)) break;
    main.add(at.entry_id);
    at = at.parent_id === null ? undefined : byId.get(at.parent_id);
  }
  const branches: ExportBranch[] = [];
  for (const r of rows) {
    if (parents.has(r.entry_id) || main.has(r.entry_id)) continue;
    const ids = new Set<string>();
    let from: ShapeRow | undefined;
    let first = r;
    let firstShown: string | undefined;
    for (let at: ShapeRow | undefined = r; at;) {
      if (main.has(at.entry_id)) {
        from = at;
        break;
      }
      if (ids.has(at.entry_id)) break;
      ids.add(at.entry_id);
      first = at;
      if (SHOWN_TYPES.has(at.type)) firstShown = at.entry_id;
      at = at.parent_id === null ? undefined : byId.get(at.parent_id);
    }
    if (firstShown === undefined) continue;
    branches.push({
      n: branches.length + 1,
      ids,
      from: from?.entry_id ?? null,
      afterSeq: from?.seq ?? 0,
      first: first.entry_id,
      firstShown,
    });
  }
  return { main, branches };
}

/** Reads the thread's shape page by page and returns its main path and other leaves' paths. */
export async function threadBranches(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  leaf: string | null,
): Promise<ThreadBranches> {
  const rows: ShapeRow[] = [];
  let after = 0;
  for (;;) {
    const page = await shapePage(db, viewer, threadId, after);
    rows.push(...page);
    if (page.length < SHAPE_PAGE) break;
    after = page.at(-1)?.seq ?? after;
  }
  return branchesOf(rows, leaf);
}

/** The thread's labels (CT9), for the metadata and the branch file names. */
export async function threadLabels(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
): Promise<{ entry_id: string; label: string }[]> {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<{ entry_id: string; label: string }>(sql`
      SELECT l.entry_id, l.label FROM thread_branch_labels l
       WHERE l.team_id = ${viewer.teamId} AND l.thread_id = ${threadId}
       ORDER BY l.entry_id`);
    return res.rows;
  });
}

/** The payload of one entry kept inline (null when offloaded or gone), for a file name. */
export async function inlinePayload(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  entryId: string,
): Promise<unknown> {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<{ payload: unknown; blob_ref: string | null }>(sql`
      SELECT e.payload, e.blob_ref FROM thread_entries e
       WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId}
         AND e.entry_id = ${entryId}`);
    const row = res.rows[0];
    return row === undefined || row.blob_ref !== null ? null : row.payload;
  });
}

/** The first line of a branch file (CT14, Q17). */
export function branchedFromLine(at: { k: number; excerpt: string } | undefined): string {
  if (at === undefined || at.k === 0) return "Branched from the start of the main transcript.";
  return `Branched from message ${at.k} of the main transcript: “${at.excerpt}”`;
}

/** Whitespace collapsed and cut to {@link BRANCH_EXCERPT_CHARS}. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > BRANCH_EXCERPT_CHARS ? `${flat.slice(0, BRANCH_EXCERPT_CHARS - 1)}…` : flat;
}
