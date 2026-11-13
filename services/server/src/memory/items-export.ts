import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { locate, type Location } from "./items/location.js";

/**
 * The person's semantic memories for the personal export (KOBE-649, SM28): their own items in the
 * Workspace being exported (`user` scope) and their portable items, every status, each with its
 * versions. Workspace (`team`) and Site items are not theirs alone and stay out, as do other
 * people's items. Provenance: a version's thread links only where the person wrote that version
 * (the item store's rule); evidence quotes only from the person's own messages (a `user` message
 * in a conversation they own in this Workspace), everything else dropped. Read page by page in
 * short transactions, like the rest of the export; legal holds change nothing here.
 */

const PAGE = 100;

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
  readonly statement: string;
  readonly tags: string[];
  readonly pinned: boolean;
  readonly as_of: string | null;
  readonly superseded_by: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** Oldest first; versions past the Site's cap may have been pruned. */
  readonly versions: ExportedVersion[];
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
};

type VersionRow = {
  readonly item_id: string;
  readonly version: number;
  readonly statement: string;
  readonly actor_user_id: string;
  readonly actor_kind: string;
  readonly lint_override: boolean;
  readonly policy_override: boolean;
  readonly source_thread_id: string | null;
  readonly source_entry_ids: string[] | null;
  readonly evidence: unknown;
  readonly created_at: Timestamp;
};

const uuidList = (ids: readonly string[]) =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/**
 * Quotes of a version's `evidence` (written by learning passes, KOBE-389/390): an array of
 * `{ entry_id, quote }` (or `{ quotes: [...] }`), optionally naming the source thread. Anything
 * else is left out rather than guessed at.
 */
export function quotesOf(
  evidence: unknown,
  threadId: string | null,
): { entryId: string; quote: string }[] {
  if (threadId === null || evidence === null || typeof evidence !== "object") return [];
  const list: unknown = Array.isArray(evidence)
    ? evidence
    : (evidence as { quotes?: unknown }).quotes;
  if (!Array.isArray(list)) return [];
  const out: { entryId: string; quote: string }[] = [];
  for (const raw of list) {
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
           i.created_at, i.updated_at, to_char(${loc.asOf}, 'YYYY-MM-DD') AS as_of, v.statement
      FROM ${loc.items} i
      JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
     WHERE ${loc.where} ${cursor}
     ORDER BY i.id LIMIT ${PAGE}`);
  return rows;
}

async function versionsOf(
  tx: KobeTx,
  loc: Location,
  ids: readonly string[],
): Promise<readonly VersionRow[]> {
  const scope = loc.workspace
    ? sql`v.team_id = ${loc.teamId}`
    : sql`v.actor_user_id = ${loc.userId}`;
  const extra = loc.workspace
    ? sql`v.source_thread_id, v.source_entry_ids, v.evidence`
    : sql`NULL::uuid AS source_thread_id, NULL::text[] AS source_entry_ids, NULL::jsonb AS evidence`;
  const { rows } = await tx.execute<VersionRow>(sql`
    SELECT v.item_id, v.version, v.statement, v.actor_user_id, v.actor_kind, v.lint_override,
           v.policy_override, v.created_at, ${extra}
      FROM ${loc.versions} v
     WHERE ${scope} AND v.item_id = ANY(${uuidList(ids)})
     ORDER BY v.item_id, v.version`);
  return rows;
}

/**
 * The cited entries that are the person's own messages: `user` messages in conversations they
 * own in this Workspace. Keyed `thread_id/entry_id`.
 */
async function ownMessages(
  tx: KobeTx,
  viewer: Viewer,
  cited: readonly { threadId: string; entryId: string }[],
): Promise<Set<string>> {
  if (cited.length === 0) return new Set();
  const pairs = sql.join(
    cited.map((c) => sql`(${c.threadId}::uuid, ${c.entryId}::text)`),
    sql`, `,
  );
  const { rows } = await tx.execute<{ thread_id: string; entry_id: string }>(sql`
    SELECT te.thread_id, te.entry_id
      FROM thread_entries te
      JOIN threads t ON t.team_id = te.team_id AND t.id = te.thread_id
     WHERE te.team_id = ${viewer.teamId} AND t.team_id = ${viewer.teamId}
       AND t.owner_user_id = ${viewer.userId}
       AND te.type = 'message' AND te.payload->'message'->>'role' = 'user'
       AND (te.thread_id, te.entry_id) IN (${pairs})`);
  return new Set(rows.map((r) => `${r.thread_id}/${r.entry_id}`));
}

async function exportPage(
  tx: KobeTx,
  loc: Location,
  viewer: Viewer,
  items: readonly ItemRow[],
): Promise<ExportedItem[]> {
  const versions = await versionsOf(
    tx,
    loc,
    items.map((i) => i.id),
  );
  // Provenance is shown only on the person's own versions (the item store's rule).
  const mine = (v: VersionRow) => v.actor_user_id === viewer.userId;
  const cited = versions.flatMap((v) =>
    mine(v) && v.source_thread_id !== null
      ? quotesOf(v.evidence, v.source_thread_id).map((q) => ({
          threadId: v.source_thread_id as string,
          entryId: q.entryId,
        }))
      : [],
  );
  const own = loc.workspace ? await ownMessages(tx, viewer, cited) : new Set<string>();
  const byItem = new Map<string, ExportedVersion[]>();
  for (const v of versions) {
    const links = mine(v);
    const evidence = links
      ? quotesOf(v.evidence, v.source_thread_id)
          .filter((q) => own.has(`${v.source_thread_id}/${q.entryId}`))
          .map((q) => ({ entry_id: q.entryId, quote: q.quote }))
      : [];
    const list = byItem.get(v.item_id) ?? [];
    byItem.set(v.item_id, [
      ...list,
      {
        version: v.version,
        statement: v.statement,
        actor_kind: v.actor_kind,
        lint_override: v.lint_override,
        policy_override: v.policy_override,
        created_at: iso(v.created_at),
        source_thread_id: links ? v.source_thread_id : null,
        source_entry_ids: links && v.source_thread_id !== null ? v.source_entry_ids : null,
        evidence,
      },
    ]);
  }
  return items.map((i) => ({
    id: i.id,
    scope: loc.scope as "user" | "portable",
    kind: i.kind,
    status: i.status,
    statement: i.statement,
    tags: i.tags,
    pinned: i.pinned,
    as_of: i.as_of,
    superseded_by: i.superseded_by,
    version: i.current_version,
    created_at: iso(i.created_at),
    updated_at: iso(i.updated_at),
    versions: byItem.get(i.id) ?? [],
  }));
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
      const page: ExportedItem[] = await withTeam(db, viewer.teamId, async (tx) => {
        const items = await itemPage(tx, loc, after);
        return items.length === 0 ? [] : exportPage(tx, loc, viewer, items);
      });
      if (page.length > 0) yield page;
      const last = page.at(-1);
      if (!last || page.length < PAGE) break;
      after = last.id;
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
