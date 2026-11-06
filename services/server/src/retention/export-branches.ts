import { sql, withTeam, type KobeDb } from "@kobe/db";
import { treeEntrySql } from "../sandbox-wire/entries.js";
import { OWN_THREADS, type EntryRow, type ExportViewer } from "./export.js";

/**
 * Every branch in the export (KOBE-543, docs/specs/conversation-tree.md CT14). The transcript
 * stays the leaf's branch; each other leaf's path gets its own file under
 * `branches/<date>-<title>-<id>/<n>-<label-or-first-words>.md`, holding what that path adds after
 * it leaves the main transcript, and starting with the line that says where it left it.
 *
 * The walk reads only the tree's shape (ids, parents, order, type) page by page; each branch's
 * entries are found one branch at a time and read by key, a page at a time. At most
 * {@link BRANCH_FILES_MAX} files per thread. Every read re-checks that the viewer still owns the
 * thread (as the export's entry pages do), so a thread re-owned or purged meanwhile stops.
 */

const SHAPE_PAGE = 5_000;
/** Entry bodies read per keyed page (the export's entry page). */
const BODY_PAGE = 50;
/** The excerpt of the message a branch left from (§5's node excerpt). */
export const BRANCH_EXCERPT_CHARS = 120;
/** Branch files per thread; past it the thread's metadata says `branches_capped: true`. */
export const BRANCH_FILES_MAX = 200;

export type ShapeRow = {
  readonly seq: number;
  readonly entry_id: string;
  readonly parent_id: string | null;
  readonly type: string;
  /** A node of the tree ({@link treeEntrySql}): server notes and cards are never a leaf. */
  readonly in_tree: boolean;
};

export interface ThreadTree {
  readonly byId: ReadonlyMap<string, ShapeRow>;
  /** The entry ids of the main transcript (the leaf's branch). */
  readonly main: ReadonlySet<string>;
  /** Leaves off the main transcript, in the order they were written. */
  readonly leaves: readonly ShapeRow[];
}

export interface ExportBranch {
  /** The entries this path adds after it leaves the main transcript, root first. */
  readonly ids: readonly string[];
  /** The entry of the main transcript it leaves from; null: it shares none (another root). */
  readonly from: string | null;
  /** Its first entry (where a label would sit, CT9). */
  readonly first: string;
  /** Its first entry a transcript shows (for the file name's first words). */
  readonly firstShown: string;
}

/** Entry types a transcript can show: a branch made only of markers (a ghost node) adds no file. */
const SHOWN_TYPES: ReadonlySet<string> = new Set(["message", "custom_message"]);

/** The main path and the other leaves (CT14); pure, for the walk and its tests. */
export function treeOf(rows: readonly ShapeRow[], leaf: string | null): ThreadTree {
  const byId = new Map(rows.map((r) => [r.entry_id, r]));
  const parents = new Set<string>();
  for (const r of rows) if (r.parent_id !== null && r.in_tree) parents.add(r.parent_id);
  const main = new Set<string>();
  for (let at = leaf === null ? undefined : byId.get(leaf); at;) {
    if (main.has(at.entry_id)) break;
    main.add(at.entry_id);
    at = at.parent_id === null ? undefined : byId.get(at.parent_id);
  }
  const leaves = rows.filter((r) => r.in_tree && !parents.has(r.entry_id) && !main.has(r.entry_id));
  return { byId, main, leaves };
}

/**
 * One leaf's branch: walks up from `leaf` to the main transcript. Undefined when the new part has
 * nothing a transcript shows (a ghost marker).
 */
export function branchOf(tree: ThreadTree, leaf: ShapeRow): ExportBranch | undefined {
  const ids: string[] = [];
  const seen = new Set<string>();
  let from: string | null = null;
  let firstShown: string | undefined;
  for (let at: ShapeRow | undefined = leaf; at;) {
    if (tree.main.has(at.entry_id)) {
      from = at.entry_id;
      break;
    }
    if (seen.has(at.entry_id)) break;
    seen.add(at.entry_id);
    ids.push(at.entry_id);
    if (SHOWN_TYPES.has(at.type) && at.in_tree) firstShown = at.entry_id;
    at = at.parent_id === null ? undefined : tree.byId.get(at.parent_id);
  }
  const first = ids.at(-1);
  if (firstShown === undefined || first === undefined) return undefined;
  return { ids: ids.reverse(), from, first, firstShown };
}

async function shapePage(db: KobeDb, viewer: ExportViewer, threadId: string, after: number) {
  return withTeam(db, viewer.teamId, async (tx) => {
    const res = await tx.execute<ShapeRow>(sql`
      SELECT e.seq, e.entry_id, e.parent_id, e.type, ${treeEntrySql("e")} AS in_tree
        FROM thread_entries e
        JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id
       WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId} AND e.seq > ${after}
         AND t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}
       ORDER BY e.seq LIMIT ${SHAPE_PAGE}`);
    return res.rows;
  });
}

/** Reads the thread's shape page by page and returns its main path and other leaves. */
export async function threadTree(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  leaf: string | null,
): Promise<ThreadTree> {
  const rows: ShapeRow[] = [];
  let after = 0;
  for (;;) {
    const page = await shapePage(db, viewer, threadId, after);
    rows.push(...page);
    if (page.length < SHAPE_PAGE) break;
    after = page.at(-1)?.seq ?? after;
  }
  return treeOf(rows, leaf);
}

/** A branch's entries by key, a page at a time, in append order (owner re-checked per page). */
export async function* branchEntries(
  db: KobeDb,
  viewer: ExportViewer,
  threadId: string,
  ids: readonly string[],
): AsyncGenerator<EntryRow[]> {
  for (let i = 0; i < ids.length; i += BODY_PAGE) {
    const keys = ids.slice(i, i + BODY_PAGE);
    yield await withTeam(db, viewer.teamId, async (tx) => {
      const res = await tx.execute<EntryRow>(sql`
        SELECT e.seq, e.entry_id, e.parent_id, e.type, e.payload, e.blob_ref, e.created_at
          FROM thread_entries e
          JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id
         WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId}
           AND e.entry_id IN (${sql.join(
             keys.map((k) => sql`${k}`),
             sql`, `,
           )})
           AND t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}
         ORDER BY e.seq`);
      return res.rows;
    });
  }
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
        JOIN threads t ON t.team_id = l.team_id AND t.id = l.thread_id
       WHERE l.team_id = ${viewer.teamId} AND l.thread_id = ${threadId}
         AND t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}
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
        JOIN threads t ON t.team_id = e.team_id AND t.id = e.thread_id
       WHERE e.team_id = ${viewer.teamId} AND e.thread_id = ${threadId}
         AND e.entry_id = ${entryId}
         AND t.team_id = ${viewer.teamId} AND ${OWN_THREADS(viewer)}`);
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
