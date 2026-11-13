import { sql, type KobeDb } from "@kobe/db";
import type {
  SemanticMemoryItemDetail,
  SemanticMemoryListQuery,
  SemanticMemoryListResponse,
  SemanticMemoryScope,
} from "@kobe/protocol";
import { inStore } from "./context.js";
import { disabled, invalid, notFound } from "./errors.js";
import { activeCount, policyUsage, scopeLimit } from "./limits.js";
import { detailOf, itemColumns, itemToWire, readItem, type ItemRow } from "./rows.js";
import { assertEnabled, type MemoryWho } from "./who.js";

/** Trigram similarity a search match needs when the words don't match (SM10 search). */
const SEARCH_SIMILARITY = 0.3;

interface Cursor {
  readonly us: string;
  readonly id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof c.us === "string" &&
      /^\d{1,20}$/.test(c.us) &&
      typeof c.id === "string" &&
      /^[0-9a-f-]{36}$/.test(c.id)
    )
      return { us: c.us, id: c.id };
  } catch {
    // fall through
  }
  throw invalid("cursor is not one this list returned.");
}

/**
 * One scope, newest change first (KOBE-378). Personal scopes are the caller's own; Workspace and
 * Site items are read by every member. With the Workspace's Site memories off, the Site scope lists
 * Policy only (Policy follows the Site master switch alone). `usage` feeds the 80% warning.
 */
export function listItems(
  db: KobeDb,
  who: MemoryWho,
  q: SemanticMemoryListQuery,
): Promise<SemanticMemoryListResponse> {
  return inStore(db, who, q.scope, async (op) => {
    const { tx, loc } = op;
    if (q.policy !== undefined && q.scope !== "site")
      throw invalid("policy filters the Site scope only.");
    let policyOnly = false;
    if (q.scope === "site" && !op.memory.scopes.site) {
      if (!op.memory.policy || q.policy === false) throw disabled();
      policyOnly = true;
    } else assertEnabled(op.memory, q.scope);
    const policy = policyOnly ? true : q.policy;
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    const stamp = sql`floor(extract(epoch FROM i.updated_at) * 1000000)::bigint`;
    const filters = [
      sql`i.status = ${q.status}`,
      q.kind ? sql`i.kind = ${q.kind}` : undefined,
      q.pinned !== undefined ? sql`i.pinned = ${q.pinned}` : undefined,
      policy !== undefined ? sql`${loc.policy} = ${policy}` : undefined,
      q.q
        ? sql`(v.statement_tsv @@ websearch_to_tsquery('english', ${q.q})
               OR similarity(v.statement, ${q.q}) >= ${SEARCH_SIMILARITY})`
        : undefined,
      cursor ? sql`(${stamp}, i.id) < (${cursor.us}::bigint, ${cursor.id}::uuid)` : undefined,
    ].filter((f) => f !== undefined);
    const { rows } = await tx.execute<ItemRow & { stamp: string }>(sql`
      SELECT ${itemColumns(loc)}, ${stamp}::text AS stamp
        FROM ${loc.items} i JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
       WHERE ${loc.where} AND ${sql.join(filters, sql` AND `)}
       ORDER BY i.updated_at DESC, i.id DESC
       LIMIT ${q.limit + 1}`);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const usage =
      q.scope === "site"
        ? await (async () => {
            const p = await policyUsage(tx);
            return { policy_count: p.count, policy_bytes: p.bytes };
          })()
        : {};
    return {
      scope: q.scope,
      items: page.map((r) => itemToWire(loc, who, r)),
      next_cursor:
        rows.length > q.limit && last ? encodeCursor({ us: last.stamp, id: last.id }) : null,
      usage: { count: await activeCount(tx, loc), max: scopeLimit(op.settings, loc), ...usage },
    };
  });
}

/** One item with its versions; another person's personal item is a 404. */
export function getItem(
  db: KobeDb,
  who: MemoryWho,
  scope: SemanticMemoryScope,
  id: string,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, scope, async (op) => {
    const row = await readItem(op.tx, op.loc, id);
    if (!row) throw notFound();
    assertEnabled(op.memory, scope, row.policy);
    return detailOf(op.tx, op.loc, who, row);
  });
}
