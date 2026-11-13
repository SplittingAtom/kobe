import { sql, type KobeDb } from "@kobe/db";
import {
  SEMANTIC_MEMORY_EXPORT_FORMAT,
  type SemanticMemoryExportDocument,
  type SemanticMemoryExportItem,
  type SemanticMemoryExportQuery,
} from "@kobe/protocol";
import { audit, auditTeam, inStore } from "./context.js";
import { notAllowed } from "./errors.js";
import { itemColumns, type ItemRow } from "./rows.js";
import { assertEnabled, curates, type MemoryWho } from "./who.js";

/**
 * Export one scope (KOBE-385; contract KOBE-377 `transfer.ts`, SM21): every active item (and with
 * `include_inactive` archived and superseded ones too), oldest first, as an import-ready document.
 * Personal scopes are the caller's own; Workspace and Site exports are for their curators (Team
 * admins and Workspace stewards; Site admins and Site stewards). Each export is audited
 * (`memory.items.exported`, counts only). No authors, thread links or evidence leave.
 */
export function exportItems(
  db: KobeDb,
  who: MemoryWho,
  q: SemanticMemoryExportQuery,
): Promise<SemanticMemoryExportDocument> {
  return inStore(db, who, q.scope, async (op) => {
    const { tx, loc } = op;
    assertEnabled(op.memory, q.scope);
    if (!curates(who, q.scope))
      throw notAllowed(
        q.scope === "team"
          ? "Only Team admins and memory stewards export Workspace memories."
          : "Only Site admins and Site memory stewards export Site memories.",
      );
    const includeInactive = q.include_inactive === true;
    const { rows } = await tx.execute<ItemRow>(sql`
      SELECT ${itemColumns(loc)}
        FROM ${loc.items} i JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
       WHERE ${loc.where} ${includeInactive ? sql`` : sql`AND i.status = 'active'`}
       ORDER BY i.created_at ASC, i.id ASC`);
    const items: SemanticMemoryExportItem[] = rows.map((r) => ({
      ref: r.id,
      kind: r.kind,
      statement: r.statement,
      tags: r.tags,
      pinned: r.pinned,
      as_of: r.as_of,
      policy: r.policy,
      status: r.status,
      superseded_by: r.superseded_by,
    }));
    await audit(op, [
      {
        action: "memory.items.exported",
        teamId: auditTeam(loc),
        target: { scope: q.scope, format: q.format, count: items.length, includeInactive },
      },
    ]);
    return {
      format: SEMANTIC_MEMORY_EXPORT_FORMAT,
      scope: q.scope,
      exported_at: new Date().toISOString(),
      include_inactive: includeInactive,
      items,
    };
  });
}
