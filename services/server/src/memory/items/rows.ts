import { sql, type KobeTx } from "@kobe/db";
import type {
  SemanticMemoryActorKind,
  SemanticMemoryItem,
  SemanticMemoryItemDetail,
  SemanticMemoryKind,
  SemanticMemoryStatus,
  SemanticMemoryVersion,
} from "@kobe/protocol";
import type { Location } from "./location.js";
import { curates, seesSiteAuthors, type MemoryWho } from "./who.js";

/** One item with its current statement, as the store reads it. */
export type ItemRow = {
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly status: SemanticMemoryStatus;
  readonly superseded_by: string | null;
  readonly pinned: boolean;
  readonly tags: string[];
  readonly current_version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly as_of: string | null;
  readonly policy: boolean;
  readonly owner_user_id: string | null;
  readonly statement: string;
  readonly updated_by: string;
};

type VersionRow = {
  readonly version: number;
  readonly statement: string;
  readonly actor_user_id: string;
  readonly actor_kind: SemanticMemoryActorKind;
  readonly lint_override: boolean;
  readonly policy_override: boolean;
  readonly source_thread_id: string | null;
  readonly source_entry_ids: string[] | null;
  readonly created_at: Date | string;
};

/** The select list of {@link ItemRow} (alias `i` for the item, `v` its current version). */
export const itemColumns = (loc: Location) => sql`
  i.id, i.kind, i.status, i.superseded_by, i.pinned, i.tags, i.current_version,
  i.created_at, i.updated_at, to_char(${loc.asOf}, 'YYYY-MM-DD') AS as_of,
  ${loc.policy} AS policy, ${loc.owner} AS owner_user_id,
  v.statement, v.actor_user_id AS updated_by`;

/** One item of this scope; `lock` takes a row lock for a write. */
export async function readItem(
  tx: KobeTx,
  loc: Location,
  id: string,
  lock = false,
): Promise<ItemRow | undefined> {
  const { rows } = await tx.execute<ItemRow>(sql`
    SELECT ${itemColumns(loc)}
      FROM ${loc.items} i JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
     WHERE ${loc.where} AND i.id = ${id}
     ${lock ? sql`FOR UPDATE OF i` : sql``}`);
  return rows[0];
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** An item as the API returns it, with the author walls of the contract (M6). */
export function itemToWire(loc: Location, who: MemoryWho, r: ItemRow): SemanticMemoryItem {
  const authors = loc.scope !== "site" || seesSiteAuthors(who);
  return {
    id: r.id,
    scope: loc.scope,
    kind: r.kind,
    status: r.status,
    statement: r.statement,
    tags: r.tags,
    pinned: r.pinned,
    policy: r.policy,
    as_of: r.as_of,
    owner_user_id: r.owner_user_id,
    superseded_by: r.superseded_by,
    version: r.current_version,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    updated_by: authors ? r.updated_by : null,
  };
}

/** The item with every version, newest first; thread links only for their author and curators. */
export async function detailOf(
  tx: KobeTx,
  loc: Location,
  who: MemoryWho,
  row: ItemRow,
): Promise<SemanticMemoryItemDetail> {
  const links = loc.workspace
    ? sql`source_thread_id, source_entry_ids`
    : sql`NULL::uuid AS source_thread_id, NULL::text[] AS source_entry_ids`;
  const { rows } = await tx.execute<VersionRow>(sql`
    SELECT version, statement, actor_user_id, actor_kind, lint_override, policy_override,
           ${links}, created_at
      FROM ${loc.versions} WHERE ${loc.versionsOfItem(row.id)}
     ORDER BY version DESC`);
  const authors = loc.scope !== "site" || seesSiteAuthors(who);
  const curator = curates(who, loc.scope);
  const versions: SemanticMemoryVersion[] = rows.map((v) => {
    const showLinks = loc.workspace && (curator || v.actor_user_id === who.userId);
    return {
      version: v.version,
      statement: v.statement,
      actor_user_id: authors ? v.actor_user_id : null,
      actor_kind: v.actor_kind,
      lint_override: v.lint_override,
      policy_override: v.policy_override,
      source_thread_id: showLinks ? v.source_thread_id : null,
      source_entry_ids: showLinks && v.source_thread_id !== null ? v.source_entry_ids : null,
      created_at: iso(v.created_at),
    };
  });
  return { ...itemToWire(loc, who, row), versions };
}
