import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { locate, type Location } from "./items/location.js";
import { quoteFoundIn } from "./quote-normalise.js";

/**
 * The person's semantic memories for the personal export (KOBE-649, SM28): their own items in the
 * Workspace being exported (`user` scope) and their portable items, every status, each with the
 * versions the person wrote. Workspace (`team`) and Site items are not theirs alone and stay out,
 * as do other people's items and versions (review 649 L-1). Provenance: thread links only to
 * conversations the person owns in this Workspace (L-2); evidence quotes only when the cited entry
 * is a message the person wrote there (not a fork's copy, H-1) and the quote is in its text (M-1).
 * Read in short transactions with bounded batches (M-2); legal holds change nothing here.
 */

const PAGE = 100;
/** Versions read per query: bounds memory and bind parameters whatever the Site's version cap. */
export const VERSION_BATCH = 1000;
/** (thread, entry) pairs checked per query (two bind parameters each). */
const QUOTE_CHUNK = 500;
/** Distinct source threads checked per query. */
const THREAD_CHUNK = 500;

type Timestamp = Date | string;
const iso = (t: Timestamp): string => new Date(t).toISOString();

export interface ExportedQuote {
  readonly entry_id: string;
  readonly quote: string;
}

export interface ExportedVersion {
  readonly version: number;
  readonly statement: string;
  readonly actor_kind: string;
  readonly lint_override: boolean;
  readonly policy_override: boolean;
  readonly created_at: string;
  readonly source_thread_id: string | null;
  readonly source_entry_ids: string[] | null;
  readonly evidence: ExportedQuote[];
}

export interface ExportedItem {
  readonly id: string;
  readonly scope: "user" | "portable";
  readonly kind: string;
  readonly status: string;
  /** Null when someone else wrote the current version (see `notes`). */
  readonly statement: string | null;
  readonly tags: string[];
  readonly pinned: boolean;
  readonly as_of: string | null;
  /** Null when the replacement is not in this archive (see `notes`). */
  readonly superseded_by: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** The person's versions, oldest first; versions past the Site's cap may have been pruned. */
  readonly versions: ExportedVersion[];
  /** Present only when something was left out of this item. */
  readonly notes?: string[];
}

interface Viewer {
  readonly teamId: string;
  readonly userId: string;
}

type ItemRow = {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly superseded_by: string | null;
  readonly pinned: boolean;
  readonly tags: string[];
  readonly current_version: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly as_of: string | null;
  readonly statement: string;
  readonly current_actor: string;
  /** The replacement is one of the person's items of the same scope. */
  readonly replacement_exported: boolean;
};

type VersionRow = {
  readonly item_id: string;
  readonly version: number;
  readonly statement: string;
  readonly actor_kind: string;
  readonly lint_override: boolean;
  readonly policy_override: boolean;
  readonly source_thread_id: string | null;
  readonly source_entry_ids: string[] | null;
  readonly evidence: unknown;
  readonly created_at: Timestamp;
};

const NOTE_OTHER_AUTHORS = (n: number) =>
  `Versions written by someone else are not included (${n}).`;
const NOTE_REPLACED_OUTSIDE =
  "Replaced by a memory that is not yours alone, so not in this archive.";

const list = (values: readonly string[], type: "uuid" | "text") =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${sql.raw(type)}[]`;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Text of a Pi message `content`: a string, or the text parts of a part list. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: unknown) =>
      p !== null &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : "",
    )
    .join("\n");
}

/**
 * Quotes of a version's `evidence` (written by learning passes, KOBE-389/390): an array of
 * `{ entry_id, quote, thread_id? }` or `{ quotes: [...] }`. Anything else is left out rather than
 * guessed at. KOBE-390 fixes the shape: keep this reader in step with it.
 */
export function quotesOf(
  evidence: unknown,
  threadId: string | null,
): { entryId: string; quote: string }[] {
  if (threadId === null || evidence === null || typeof evidence !== "object") return [];
  const items: unknown = Array.isArray(evidence)
    ? evidence
    : (evidence as { quotes?: unknown }).quotes;
  if (!Array.isArray(items)) return [];
  const out: { entryId: string; quote: string }[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const q = raw as Record<string, unknown>;
    if (q.thread_id !== undefined && q.thread_id !== threadId) continue;
    if (typeof q.entry_id === "string" && typeof q.quote === "string" && q.quote.trim() !== "")
      out.push({ entryId: q.entry_id, quote: q.quote });
  }
  return out;
}

async function itemPage(
  tx: KobeTx,
  loc: Location,
  after: string | null,
): Promise<readonly ItemRow[]> {
  const cursor = after === null ? sql`` : sql`AND i.id > ${after}`;
  const { rows } = await tx.execute<ItemRow>(sql`
    SELECT i.id, i.kind, i.status, i.superseded_by, i.pinned, i.tags, i.current_version,
           i.created_at, i.updated_at, to_char(${loc.asOf}, 'YYYY-MM-DD') AS as_of, v.statement,
           v.actor_user_id AS current_actor,
           (i.superseded_by IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${loc.items} r
               WHERE ${sql.raw(loc.workspace ? "r.team_id = i.team_id AND r.scope = 'user' AND " : "")}
                     r.owner_user_id = i.owner_user_id AND r.id = i.superseded_by
           )) AS replacement_exported
      FROM ${loc.items} i
      JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
     WHERE ${loc.where} ${cursor}
     ORDER BY i.id LIMIT ${PAGE}`);
  return rows;
}

/** The person's versions of these items after `(item, version)`, at most {@link VERSION_BATCH}. */
async function versionBatch(
  tx: KobeTx,
  loc: Location,
  ids: readonly string[],
  after: { readonly item: string; readonly version: number } | null,
): Promise<readonly VersionRow[]> {
  const team = loc.workspace ? sql`v.team_id = ${loc.teamId} AND` : sql``;
  const extra = loc.workspace
    ? sql`v.source_thread_id, v.source_entry_ids, v.evidence`
    : sql`NULL::uuid AS source_thread_id, NULL::text[] AS source_entry_ids, NULL::jsonb AS evidence`;
  const cursor =
    after === null
      ? sql``
      : sql`AND (v.item_id, v.version) > (${after.item}::uuid, ${after.version})`;
  const { rows } = await tx.execute<VersionRow>(sql`
    SELECT v.item_id, v.version, v.statement, v.actor_kind, v.lint_override, v.policy_override,
           v.created_at, ${extra}
      FROM ${loc.versions} v
     WHERE ${team} v.item_id = ANY(${list(ids, "uuid")}) AND v.actor_user_id = ${loc.userId}
           ${cursor}
     ORDER BY v.item_id, v.version LIMIT ${VERSION_BATCH}`);
  return rows;
}

/** How many versions of these items someone else wrote, per item. */
async function otherAuthors(
  tx: KobeTx,
  loc: Location,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (!loc.workspace) return new Map(); // portable versions are bound to the owner by key
  const { rows } = await tx.execute<{ item_id: string; n: number }>(sql`
    SELECT v.item_id, count(*)::int AS n FROM ${loc.versions} v
     WHERE v.team_id = ${loc.teamId} AND v.item_id = ANY(${list(ids, "uuid")})
       AND v.actor_user_id <> ${loc.userId}
     GROUP BY v.item_id`);
  return new Map(rows.map((r) => [r.item_id, r.n]));
}

/** Of these threads, the ones the person owns in this Workspace. */
async function ownThreads(
  tx: KobeTx,
  viewer: Viewer,
  threadIds: readonly string[],
): Promise<Set<string>> {
  const own = new Set<string>();
  for (const part of chunks(threadIds, THREAD_CHUNK)) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT t.id FROM threads t
       WHERE t.team_id = ${viewer.teamId} AND t.owner_user_id = ${viewer.userId}
         AND t.id = ANY(${list(part, "uuid")})`);
    for (const r of rows) own.add(r.id);
  }
  return own;
}

/**
 * The text of each cited entry that the person wrote: a `user` message in a thread
 * they own in this Workspace and, in a fork, written after the fork (H-1: a fork copies the
 * source's entries with their ids and times, up to and including `forked_at_entry_id`; the
 * person's own copied messages are dropped too, the safe side). Keyed `thread_id/entry_id`.
 */
async function ownMessages(
  tx: KobeTx,
  viewer: Viewer,
  cited: readonly { threadId: string; entryId: string }[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const part of chunks(cited, QUOTE_CHUNK)) {
    const pairs = sql.join(
      part.map((c) => sql`(${c.threadId}::uuid, ${c.entryId}::text)`),
      sql`, `,
    );
    const { rows } = await tx.execute<{ thread_id: string; entry_id: string; content: unknown }>(
      sql`
      SELECT te.thread_id, te.entry_id, te.payload->'message'->'content' AS content
        FROM thread_entries te
        JOIN threads t ON t.team_id = te.team_id AND t.id = te.thread_id
       WHERE te.team_id = ${viewer.teamId} AND t.team_id = ${viewer.teamId}
         AND t.owner_user_id = ${viewer.userId}
         AND te.type = 'message' AND te.payload->'message'->>'role' = 'user'
         AND (te.thread_id, te.entry_id) IN (${pairs})
         AND (
           (t.forked_from_thread_id IS NULL AND t.forked_at_entry_id IS NULL)
           OR (te.created_at > t.created_at
               AND te.seq > COALESCE((SELECT f.seq FROM thread_entries f
                                       WHERE f.team_id = t.team_id AND f.thread_id = t.id
                                         AND f.entry_id = t.forked_at_entry_id), 0))
         )`,
    );
    for (const r of rows) texts.set(`${r.thread_id}/${r.entry_id}`, messageText(r.content));
  }
  return texts;
}

/** One batch of version rows as exported versions, provenance and quotes checked. */
async function exportVersions(
  tx: KobeTx,
  loc: Location,
  viewer: Viewer,
  rows: readonly VersionRow[],
): Promise<ExportedVersion[]> {
  const threadIds = [
    ...new Set(rows.flatMap((v) => (v.source_thread_id === null ? [] : [v.source_thread_id]))),
  ];
  const owned = loc.workspace ? await ownThreads(tx, viewer, threadIds) : new Set<string>();
  const linked = (v: VersionRow) => v.source_thread_id !== null && owned.has(v.source_thread_id);
  const cited = rows.flatMap((v) =>
    linked(v)
      ? quotesOf(v.evidence, v.source_thread_id).map((q) => ({
          threadId: v.source_thread_id as string,
          entryId: q.entryId,
        }))
      : [],
  );
  const texts = await ownMessages(tx, viewer, cited);
  return rows.map((v) => {
    const links = linked(v);
    const evidence = links
      ? quotesOf(v.evidence, v.source_thread_id).filter((q) => {
          const text = texts.get(`${v.source_thread_id}/${q.entryId}`);
          return text !== undefined && quoteFoundIn(q.quote, text);
        })
      : [];
    return {
      version: v.version,
      statement: v.statement,
      actor_kind: v.actor_kind,
      lint_override: v.lint_override,
      policy_override: v.policy_override,
      created_at: iso(v.created_at),
      source_thread_id: links ? v.source_thread_id : null,
      source_entry_ids: links ? v.source_entry_ids : null,
      evidence: evidence.map((q) => ({ entry_id: q.entryId, quote: q.quote })),
    };
  });
}

function toItem(
  loc: Location,
  viewer: Viewer,
  i: ItemRow,
  versions: ExportedVersion[],
  others: number,
): ExportedItem {
  const notes: string[] = [];
  if (others > 0) notes.push(NOTE_OTHER_AUTHORS(others));
  const replacementOutside = i.superseded_by !== null && !i.replacement_exported;
  if (replacementOutside) notes.push(NOTE_REPLACED_OUTSIDE);
  return {
    id: i.id,
    scope: loc.scope as "user" | "portable",
    kind: i.kind,
    status: i.status,
    statement: i.current_actor === viewer.userId ? i.statement : null,
    tags: i.tags,
    pinned: i.pinned,
    as_of: i.as_of,
    superseded_by: replacementOutside ? null : i.superseded_by,
    version: i.current_version,
    created_at: iso(i.created_at),
    updated_at: iso(i.updated_at),
    versions,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * The items of one page with their versions, read {@link VERSION_BATCH} versions per transaction;
 * each item is yielded once its last version is read, so at most one batch is held besides it.
 */
async function* pageItems(
  db: KobeDb,
  loc: Location,
  viewer: Viewer,
  items: readonly ItemRow[],
  others: Map<string, number>,
): AsyncGenerator<ExportedItem> {
  const ids = items.map((i) => i.id);
  let next = 0;
  let current: ExportedVersion[] = [];
  let after: { item: string; version: number } | null = null;
  for (;;) {
    const cursor = after;
    const batch = await withTeam(db, viewer.teamId, async (tx) => {
      const rows = await versionBatch(tx, loc, ids, cursor);
      return { rows, versions: await exportVersions(tx, loc, viewer, rows) };
    });
    for (const [k, row] of batch.rows.entries()) {
      while (next < items.length && items[next]?.id !== row.item_id) {
        const done = items[next] as ItemRow;
        yield toItem(loc, viewer, done, current, others.get(done.id) ?? 0);
        current = [];
        next += 1;
      }
      current.push(batch.versions[k] as ExportedVersion);
    }
    const last = batch.rows.at(-1);
    if (!last || batch.rows.length < VERSION_BATCH) break;
    after = { item: last.item_id, version: last.version };
  }
  for (; next < items.length; next += 1) {
    const done = items[next] as ItemRow;
    yield toItem(loc, viewer, done, current, others.get(done.id) ?? 0);
    current = [];
  }
}

/**
 * Pages of the person's items: first their `user` items in this Workspace (inside `withTeam`),
 * then their portable items (site-wide rows, confined to the owner by the location's filter).
 */
export async function* semanticMemoryForExport(
  db: KobeDb,
  viewer: Viewer,
): AsyncGenerator<ExportedItem[]> {
  for (const scope of ["user", "portable"] as const) {
    const loc = locate(scope, viewer.teamId, viewer.userId);
    let after: string | null = null;
    for (;;) {
      const cursor = after;
      const { items, others } = await withTeam(db, viewer.teamId, async (tx) => {
        const rows = await itemPage(tx, loc, cursor);
        const ids = rows.map((r) => r.id);
        return {
          items: rows,
          others: rows.length === 0 ? new Map<string, number>() : await otherAuthors(tx, loc, ids),
        };
      });
      if (items.length === 0) break;
      for await (const item of pageItems(db, loc, viewer, items, others)) yield [item];
      if (items.length < PAGE) break;
      after = items.at(-1)?.id ?? null;
    }
  }
}

/** How many items the export holds (for its audit), in the caller's team transaction. */
export async function countSemanticMemoryForExport(tx: KobeTx, viewer: Viewer): Promise<number> {
  let total = 0;
  for (const scope of ["user", "portable"] as const) {
    const loc = locate(scope, viewer.teamId, viewer.userId);
    const { rows } = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${loc.items} i WHERE ${loc.where}`,
    );
    total += rows[0]?.n ?? 0;
  }
  return total;
}
