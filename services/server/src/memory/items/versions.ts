import { lockLegalHolds, sql, type KobeTx } from "@kobe/db";
import type { SemanticMemoryActorKind } from "@kobe/protocol";
import {
  portableHoldsUnchanged,
  portableOwnerUnheld,
  type PortableHoldSnapshot,
} from "../../legal-hold/portable-hold.js";
import { siteItemAuthorsUnheld, siteMemoryHeld } from "../../legal-hold/site-memory-hold.js";
import { logger } from "../../logger.js";
import { workspaceTeam, type Location } from "./location.js";

/**
 * Immutable versions (KOBE-378, SM8): every statement change appends a numbered version and moves
 * `current_version`; Undo appends a copy of an earlier one. Past the Site's version cap the
 * oldest versions are pruned on write ({@link pruneVersions}).
 */

export interface NewVersion {
  readonly itemId: string;
  readonly version: number;
  readonly statement: string;
  readonly actorKind: SemanticMemoryActorKind;
  readonly lintOverride: boolean;
  readonly policyOverride: boolean;
  /** Workspace scopes only (the contract refuses links elsewhere). */
  readonly sourceThreadId?: string | undefined;
  readonly sourceEntryIds?: readonly string[] | undefined;
}

export async function insertVersion(tx: KobeTx, loc: Location, v: NewVersion): Promise<void> {
  const common = sql`${v.version}, ${v.statement}, ${loc.userId}, ${v.actorKind}, ${v.lintOverride}, ${v.policyOverride}`;
  if (loc.workspace) {
    const entries = v.sourceEntryIds
      ? sql`ARRAY[${sql.join(
          v.sourceEntryIds.map((e) => sql`${e}`),
          sql`, `,
        )}]::text[]`
      : sql`NULL::text[]`;
    await tx.execute(sql`
      INSERT INTO semantic_memory_item_versions
        (team_id, item_id, version, statement, actor_user_id, actor_kind, lint_override,
         policy_override, source_thread_id, source_entry_ids)
      VALUES (${workspaceTeam(loc)}, ${v.itemId}, ${common}, ${v.sourceThreadId ?? null}, ${entries})`);
    return;
  }
  await tx.execute(sql`
    INSERT INTO ${loc.versions}
      (item_id, version, statement, actor_user_id, actor_kind, lint_override, policy_override)
    VALUES (${v.itemId}, ${common})`);
}

/**
 * Whether a legal hold suspends pruning for the item. Workspace items: the KOBE-376 rule
 * (`memory_legal_hold_covers`: the owner's hold, any hold in the team for `team` items). Portable
 * items: an active hold on the owner, or a Workspace-wide hold on a Workspace the owner is a member
 * of (KOBE-386 Q2; legal-hold/portable-hold.ts), and any Site-wide hold (N1). Site items: a Site-wide hold (KOBE-647), checked before any delete
 * so an edit past the cap under a hold keeps every version instead of failing KH001 (review M1),
 * or a hold on a person who wrote any of the item's versions (P2-L1).
 */
async function held(
  portableHolds: PortableHoldSnapshot | undefined,
  tx: KobeTx,
  loc: Location,
  itemId: string,
  owner: string | null,
): Promise<boolean> {
  if (loc.scope === "site") {
    if (await siteMemoryHeld(tx)) return true;
    // A person's hold keeps every version of the Site items they wrote (P2-L1; lock taken above).
    const { rows } = await tx.execute<{ unheld: boolean }>(
      sql`SELECT ${siteItemAuthorsUnheld(sql`${itemId}::uuid`)} AS unheld`,
    );
    return rows[0]?.unheld !== true;
  }
  // The hold lock first (as retention/memory.ts): a hold being approved waits for this write, or
  // this write waits for it and then sees it. Portable versions have no DB hold guard, so this
  // check is their only protection (review M-1).
  await lockLegalHolds(tx);
  // Portable: the Workspace-wide holds read before the transaction must still be the ones in force
  // (review M1); otherwise keep every version this time (the safe direction).
  if (!loc.workspace && (!portableHolds || !(await portableHoldsUnchanged(tx, portableHolds))))
    return true;
  // A Site-wide hold freezes portable memories on every delete path (Chris 2026-11-13, N1).
  if (!loc.workspace) {
    const site = await tx.execute<{ held: boolean }>(
      sql`SELECT public.site_legal_hold_active() AS held`,
    );
    if (site.rows[0]?.held === true) return true;
  }
  const cond = loc.workspace
    ? sql`memory_legal_hold_covers(${workspaceTeam(loc)}, ${owner})`
    : sql`NOT ${portableOwnerUnheld(sql`${owner}::uuid`, portableHolds?.members ?? [])}`;
  const { rows } = await tx.execute<{ held: boolean }>(sql`SELECT ${cond} AS held`);
  return rows[0]?.held === true;
}

/**
 * Refused deletes tolerated per write (review L-1): a portable or Site version a run in another
 * Workspace used is invisible to the candidate query (team tables under RLS; no SECURITY DEFINER),
 * so it is found only by the 0222 guard refusing it. Stop trying after this many in one write.
 */
const MAX_REFUSED_PER_WRITE = 2;

/**
 * Prunes the item's oldest versions past `cap`: never the current version, never a version a run
 * used (run records keep history; 0222 refuses those deletes in every Workspace, including ones
 * this transaction can't see), and nothing while a legal hold covers the item. Each delete runs in
 * its own savepoint, so a refused one is skipped and the write goes on. Returns how many went.
 */
export async function pruneVersions(
  /** Portable items: the Workspace-wide holds read before the transaction (`Op.portableHolds`). */
  portableHolds: PortableHoldSnapshot | undefined,
  tx: KobeTx,
  loc: Location,
  item: { readonly id: string; readonly currentVersion: number; readonly owner: string | null },
  cap: number,
): Promise<number> {
  const { rows: count } = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${loc.versions} WHERE ${loc.versionsOfItem(item.id)}`,
  );
  const excess = (count[0]?.n ?? 0) - cap;
  if (excess <= 0) return 0;
  if (await held(portableHolds, tx, loc, item.id, item.owner)) return 0;
  const { rows } = await tx.execute<{ version: number }>(sql`
    SELECT v.version FROM ${loc.versions} v
     WHERE ${loc.versionsOfItem(item.id)} AND v.version <> ${item.currentVersion}
       AND NOT EXISTS (SELECT 1 FROM ${loc.runs} r WHERE r.item_id = v.item_id AND r.version = v.version)
     ORDER BY v.version ASC LIMIT ${excess}`);
  let pruned = 0;
  let refused = 0;
  for (const { version } of rows) {
    if (refused >= MAX_REFUSED_PER_WRITE) break;
    try {
      await tx.transaction(async (sp) => {
        await sp.execute(
          sql`DELETE FROM ${loc.versions} WHERE ${loc.versionsOfItem(item.id)} AND version = ${version}`,
        );
      });
      pruned += 1;
    } catch (err) {
      // A run in another Workspace used it (55000) or a hold arrived (KH001): keep it.
      refused += 1;
      logger.info({ err, itemId: item.id, version }, "memory version kept past the cap");
    }
  }
  return pruned;
}
