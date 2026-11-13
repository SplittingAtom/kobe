import { sql } from "@kobe/db";
import type { SemanticMemoryScope } from "@kobe/protocol";

type SQL = ReturnType<typeof sql>;

/**
 * Where one scope's items live (KOBE-378), as SQL fragments over the three KOBE-376 tables. Every
 * statement the store runs goes through {@link Location.items} (alias `i`) and its `where`, so a
 * person's items are always confined to their owner (no cross-user reads of `user` or `portable`
 * rows) and Workspace rows to the active team, inside `withTeam()` (RLS applies to them too).
 * Table and column names are constants; values are bound parameters.
 */
export interface Location {
  readonly scope: SemanticMemoryScope;
  /** The Workspace the request runs in (Workspace rows are written with it). */
  readonly teamId: string;
  /** The caller (owner of `user` and `portable` items). */
  readonly userId: string;
  readonly items: SQL;
  readonly versions: SQL;
  readonly runs: SQL;
  /** Rows of this scope (alias `i`). */
  readonly where: SQL;
  /** Joins version `v` to item `i`. */
  readonly versionOf: SQL;
  /** Matches version rows of one item id (no alias). */
  readonly versionsOfItem: (itemId: string) => SQL;
  /** `as_of` (null where the table has none). */
  readonly asOf: SQL;
  /** `policy` (false where the table has none). */
  readonly policy: SQL;
  /** `owner_user_id` (null where the table has none). */
  readonly owner: SQL;
  /** Workspace scopes (`user`, `team`): team table, thread links allowed. */
  readonly workspace: boolean;
  /** Advisory lock key that serialises writes counting against this scope's limits. */
  readonly lockKey: string;
}

export function locate(scope: SemanticMemoryScope, teamId: string, userId: string): Location {
  const base = { scope, teamId, userId };
  if (scope === "user" || scope === "team") {
    return {
      ...base,
      items: sql.raw("semantic_memory_items"),
      versions: sql.raw("semantic_memory_item_versions"),
      runs: sql.raw("run_memory_items"),
      where:
        scope === "user"
          ? sql`i.team_id = ${teamId} AND i.scope = 'user' AND i.owner_user_id = ${userId}`
          : sql`i.team_id = ${teamId} AND i.scope = 'team'`,
      versionOf: sql`v.team_id = i.team_id AND v.item_id = i.id`,
      versionsOfItem: (itemId) => sql`team_id = ${teamId} AND item_id = ${itemId}`,
      asOf: sql`i.as_of`,
      policy: sql`false`,
      owner: sql`i.owner_user_id`,
      workspace: true,
      lockKey: scope === "user" ? `user:${teamId}:${userId}` : `team:${teamId}`,
    };
  }
  if (scope === "portable") {
    return {
      ...base,
      items: sql.raw("portable_memory_items"),
      versions: sql.raw("portable_memory_item_versions"),
      runs: sql.raw("run_portable_memory_items"),
      where: sql`i.owner_user_id = ${userId}`,
      versionOf: sql`v.item_id = i.id`,
      versionsOfItem: (itemId) => sql`item_id = ${itemId}`,
      asOf: sql`NULL::date`,
      policy: sql`false`,
      owner: sql`i.owner_user_id`,
      workspace: false,
      lockKey: `portable:${userId}`,
    };
  }
  return {
    ...base,
    items: sql.raw("site_memory_items"),
    versions: sql.raw("site_memory_item_versions"),
    runs: sql.raw("run_site_memory_items"),
    where: sql`true`,
    versionOf: sql`v.item_id = i.id`,
    versionsOfItem: (itemId) => sql`item_id = ${itemId}`,
    asOf: sql`i.as_of`,
    policy: sql`i.policy`,
    owner: sql`NULL::uuid`,
    workspace: false,
    lockKey: "site",
  };
}
