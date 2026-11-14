import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { withSiteMemoryPurge } from "../legal-hold/site-memory-hold.js";
import { logger } from "../logger.js";

type SQL = ReturnType<typeof sql>;

/**
 * Site and portable semantic memory retention (v1.3 SM28, KOBE-386). Past the Site window
 * (`retention_days`, default 365, KOBE-381): archived and superseded items (unchanged since before
 * the cutoff, nothing superseding into them) go with every version, and earlier versions replaced
 * before the cutoff go. A live item and a current version never go.
 *
 * Site deletes run only through {@link withSiteMemoryPurge} (KOBE-647: READ COMMITTED, hold lock
 * first, nothing while a Site-wide hold is in force, never an item a held person wrote). Portable
 * deletes take the hold lock first and skip a person under any active hold of theirs, or who is a
 * member of a Workspace under a Workspace-wide hold (Q2: a portable item reaches every Workspace
 * its owner is in, so a hold there covers it). Portable items are kept when their owner is
 * deactivated; only a site admin's purge ({@link purgePortableForUser}) removes them early.
 *
 * Run records of these lanes live in Workspace tables this transaction cannot see (RLS, no
 * SECURITY DEFINER): a version a run used, or an item whose run records sit in a held Workspace,
 * is found only by the 0217/0222 guards refusing the delete. Each delete runs in its own
 * savepoint, a refused one is kept (`kept`) and not tried again in the same pass.
 */

export type SiteLane = "site" | "portable";

export interface SitePurgeCounts {
  readonly items: number;
  readonly versions: number;
  readonly kept: number;
}

export const NO_SITE_PURGE: SitePurgeCounts = { items: 0, versions: 0, kept: 0 };

const BATCH = 100;
/** Deletes tried per lane and pass at most (each in its own savepoint). */
const MAX_TRIES = 5000;

const add = (a: SitePurgeCounts, b: SitePurgeCounts): SitePurgeCounts => ({
  items: a.items + b.items,
  versions: a.versions + b.versions,
  kept: a.kept + b.kept,
});

const notIn = (column: SQL, values: readonly string[]) =>
  values.length === 0
    ? sql`true`
    : sql`NOT (${column} = ANY(ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]))`;

/**
 * A portable item's owner is free of holds (lock taken by the caller): no active hold names them,
 * and they are not a member of a Workspace under a Workspace-wide hold (`frozen`, from
 * {@link workspaceHeldMembers}; KOBE-386 Q2).
 */
export const portableOwnerUnheld = (owner: SQL, frozen: readonly string[]): SQL => sql`(NOT EXISTS (
  SELECT 1 FROM legal_holds h WHERE h.status = 'active' AND h.user_id = ${owner})
  AND ${notIn(sql`${owner}::text`, frozen)})`;

/**
 * Members of every Workspace under an active Workspace-wide hold (`legal_holds.user_id` NULL),
 * read inside the caller's transaction after the hold lock (no hold can be approved meanwhile).
 * `team_members` stays behind its RLS: each held Workspace is read in its own `withTeam`.
 */
async function workspaceHeldMembers(db: KobeDb, tx: KobeTx): Promise<string[]> {
  const holds = await tx.execute<{ team_id: string }>(sql`
    SELECT DISTINCT team_id FROM legal_holds WHERE status = 'active' AND user_id IS NULL`);
  const members = new Set<string>();
  for (const { team_id } of holds.rows) {
    const rows = await withTeam(db, team_id, (t) =>
      t.execute<{ user_id: string }>(
        sql`SELECT user_id FROM team_members WHERE team_id = ${team_id}`,
      ),
    );
    for (const r of rows.rows) members.add(r.user_id);
  }
  return [...members];
}

/** Runs one delete in a savepoint; false when a guard refused it (kept). */
async function tryDelete(tx: KobeTx, statement: SQL, what: Record<string, unknown>) {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(statement);
    });
    return true;
  } catch (err) {
    // 55000: a run in some Workspace used the version; KH001: a held Workspace's run record.
    logger.info({ err, ...what }, "semantic memory kept by a guard");
    return false;
  }
}

interface LaneSql {
  /** Candidate items (ids), excluding `tried`. */
  readonly items: (cutoff: Date, tried: readonly string[], unheld: (id: SQL) => SQL) => SQL;
  readonly deleteItem: (id: string) => SQL;
  readonly countVersions: (id: string) => SQL;
  /** Candidate versions as `item_id:version` keys, excluding `tried`. */
  readonly versions: (cutoff: Date, tried: readonly string[], unheld: (id: SQL) => SQL) => SQL;
  readonly deleteVersion: (itemId: string, version: number) => SQL;
}

const SITE: LaneSql = {
  items: (cutoff, tried, unheld) => sql`
    SELECT i.id::text AS id FROM site_memory_items i
     WHERE i.status IN ('archived', 'superseded') AND i.updated_at < ${cutoff.toISOString()}
       AND ${unheld(sql`i.id`)} AND ${notIn(sql`i.id::text`, tried)}
       AND NOT EXISTS (SELECT 1 FROM site_memory_items r WHERE r.superseded_by = i.id)
     ORDER BY i.updated_at, i.id LIMIT ${BATCH}`,
  deleteItem: (id) => sql`
    DELETE FROM site_memory_items i
     WHERE i.id = ${id} AND i.status IN ('archived', 'superseded')`,
  countVersions: (id) =>
    sql`SELECT count(*)::int AS n FROM site_memory_item_versions WHERE item_id = ${id}`,
  versions: (cutoff, tried, unheld) => sql`
    SELECT v.item_id::text || ':' || v.version AS id FROM site_memory_item_versions v
      JOIN site_memory_items i ON i.id = v.item_id
     WHERE v.version <> i.current_version AND ${unheld(sql`v.item_id`)}
       AND ${notIn(sql`v.item_id::text || ':' || v.version`, tried)}
       AND (SELECT min(n.created_at) FROM site_memory_item_versions n
             WHERE n.item_id = v.item_id AND n.version > v.version) < ${cutoff.toISOString()}
     ORDER BY v.created_at, v.item_id, v.version LIMIT ${BATCH}`,
  deleteVersion: (itemId, version) => sql`
    DELETE FROM site_memory_item_versions v
     WHERE v.item_id = ${itemId} AND v.version = ${version}
       AND v.version <> (SELECT i.current_version FROM site_memory_items i WHERE i.id = v.item_id)`,
};

const PORTABLE: LaneSql = {
  items: (cutoff, tried, unheld) => sql`
    SELECT i.id::text AS id FROM portable_memory_items i
     WHERE i.status IN ('archived', 'superseded') AND i.updated_at < ${cutoff.toISOString()}
       AND ${unheld(sql`i.owner_user_id`)} AND ${notIn(sql`i.id::text`, tried)}
       AND NOT EXISTS (SELECT 1 FROM portable_memory_items r WHERE r.superseded_by = i.id)
     ORDER BY i.updated_at, i.id LIMIT ${BATCH}`,
  deleteItem: (id) => sql`
    DELETE FROM portable_memory_items i
     WHERE i.id = ${id} AND i.status IN ('archived', 'superseded')`,
  countVersions: (id) =>
    sql`SELECT count(*)::int AS n FROM portable_memory_item_versions WHERE item_id = ${id}`,
  versions: (cutoff, tried, unheld) => sql`
    SELECT v.item_id::text || ':' || v.version AS id FROM portable_memory_item_versions v
      JOIN portable_memory_items i ON i.id = v.item_id
     WHERE v.version <> i.current_version AND ${unheld(sql`i.owner_user_id`)}
       AND ${notIn(sql`v.item_id::text || ':' || v.version`, tried)}
       AND (SELECT min(n.created_at) FROM portable_memory_item_versions n
             WHERE n.item_id = v.item_id AND n.version > v.version) < ${cutoff.toISOString()}
     ORDER BY v.created_at, v.item_id, v.version LIMIT ${BATCH}`,
  deleteVersion: (itemId, version) => sql`
    DELETE FROM portable_memory_item_versions v
     WHERE v.item_id = ${itemId} AND v.version = ${version}
       AND v.version <> (SELECT i.current_version FROM portable_memory_items i WHERE i.id = v.item_id)`,
};

/** One batch of one lane: items first, then versions; `tried` collects every key attempted. */
async function laneBatch(
  tx: KobeTx,
  lane: LaneSql,
  cutoff: Date,
  tried: string[],
  unheld: (id: SQL) => SQL,
): Promise<SitePurgeCounts & { readonly found: number }> {
  const items = await tx.execute<{ id: string }>(lane.items(cutoff, tried, unheld));
  let counts = NO_SITE_PURGE;
  for (const { id } of items.rows) {
    tried.push(id);
    const n = await tx.execute<{ n: number }>(lane.countVersions(id));
    const ok = await tryDelete(tx, lane.deleteItem(id), { itemId: id });
    counts = add(
      counts,
      ok ? { items: 1, versions: n.rows[0]?.n ?? 0, kept: 0 } : { ...NO_SITE_PURGE, kept: 1 },
    );
  }
  if (items.rows.length > 0) return { ...counts, found: items.rows.length };
  const versions = await tx.execute<{ id: string }>(lane.versions(cutoff, tried, unheld));
  for (const { id } of versions.rows) {
    tried.push(id);
    const [itemId = "", version = "0"] = id.split(":");
    const ok = await tryDelete(tx, lane.deleteVersion(itemId, Number(version)), {
      itemId,
      version,
    });
    counts = add(counts, ok ? { items: 0, versions: 1, kept: 0 } : { ...NO_SITE_PURGE, kept: 1 });
  }
  return { ...counts, found: versions.rows.length };
}

async function siteAudit(
  tx: KobeTx,
  lane: SiteLane,
  reason: "retention" | "offboarding",
  counts: SitePurgeCounts,
  userId?: string,
): Promise<void> {
  if (counts.items + counts.versions + counts.kept === 0) return;
  await recordAudit(tx, {
    action: "retention.site_memory_purged",
    ...(reason === "retention" ? { actor: SYSTEM_ACTOR } : {}),
    target: {
      lane,
      reason,
      items: counts.items,
      versions: counts.versions,
      kept: counts.kept,
      ...(userId ? { userId } : {}),
    },
  });
}

/** Portable deletes: READ COMMITTED (a hold approved during the lock wait is seen), lock first. */
function withPortablePurge<T>(db: KobeDb, purge: (tx: KobeTx) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      return purge(tx);
    },
    { isolationLevel: "read committed" },
  );
}

/** Repeats batches of one lane until nothing is left, `stop`, or the try budget is spent. */
async function purgeLane(
  db: KobeDb,
  lane: SiteLane,
  cutoff: Date,
  stop: (() => boolean) | undefined,
): Promise<SitePurgeCounts> {
  const tried: string[] = [];
  let total = NO_SITE_PURGE;
  while (tried.length < MAX_TRIES && !stop?.()) {
    const one = async (tx: KobeTx, unheld: (id: SQL) => SQL) => {
      const counts = await laneBatch(tx, lane === "site" ? SITE : PORTABLE, cutoff, tried, unheld);
      await siteAudit(tx, lane, "retention", counts);
      return counts;
    };
    const outcome =
      lane === "site"
        ? await withSiteMemoryPurge(db, one)
        : {
            held: false as const,
            value: await withPortablePurge(db, async (tx) => {
              const frozen = await workspaceHeldMembers(db, tx);
              return one(tx, (owner) => portableOwnerUnheld(owner, frozen));
            }),
          };
    if (outcome.held) break;
    total = add(total, outcome.value);
    if (outcome.value.found === 0) break;
  }
  return total;
}

/**
 * Site and portable memory past the Site window, once per retention pass. Returns the counts per
 * lane; a Site-wide hold skips the Site lane (nothing deleted, nothing tried).
 */
export async function purgeSiteSemanticMemory(
  db: KobeDb,
  retentionDays: number,
  options: { readonly stop?: () => boolean } = {},
): Promise<{ readonly site: SitePurgeCounts; readonly portable: SitePurgeCounts }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const site = await purgeLane(db, "site", cutoff, options.stop);
  const portable = await purgeLane(db, "portable", cutoff, options.stop);
  return { site, portable };
}

export type PortablePurgeOutcome =
  | { readonly status: "purged"; readonly counts: SitePurgeCounts }
  | { readonly status: "active" | "held" | "not_found" };

/**
 * A site admin's purge of a deactivated person's portable memories (Q7, KOBE-386): until then
 * deactivation keeps them, and reactivation finds them unchanged. Refused for an active account
 * and while a hold covers the person (their own, or a Workspace-wide hold on a Workspace they are
 * in). Items another of the
 * person's items supersedes into go after it; a refused delete (a held Workspace's run record) is
 * kept and counted. Audited as the admin (`retention.site_memory_purged`, counts only).
 */
export function purgePortableForUser(db: KobeDb, userId: string): Promise<PortablePurgeOutcome> {
  return withPortablePurge(db, async (tx): Promise<PortablePurgeOutcome> => {
    const user = await tx.execute<{ deactivated: boolean }>(sql`
      SELECT deactivated_at IS NOT NULL AS deactivated FROM users WHERE id = ${userId} FOR SHARE`);
    const row = user.rows[0];
    if (!row) return { status: "not_found" };
    if (!row.deactivated) return { status: "active" };
    const held = await tx.execute<{ held: boolean }>(
      sql`SELECT NOT ${portableOwnerUnheld(
        sql`${userId}::uuid`,
        await workspaceHeldMembers(db, tx),
      )} AS held`,
    );
    if (held.rows[0]?.held === true) return { status: "held" };
    const tried: string[] = [];
    let counts = NO_SITE_PURGE;
    for (;;) {
      const next = await tx.execute<{ id: string; versions: number }>(sql`
        SELECT i.id::text AS id,
               (SELECT count(*) FROM portable_memory_item_versions v WHERE v.item_id = i.id)::int
                 AS versions
          FROM portable_memory_items i
         WHERE i.owner_user_id = ${userId} AND ${notIn(sql`i.id::text`, tried)}
           AND NOT EXISTS (SELECT 1 FROM portable_memory_items r
                            WHERE r.superseded_by = i.id AND ${notIn(sql`r.id::text`, tried)})
         ORDER BY i.id LIMIT ${BATCH}`);
      if (next.rows.length === 0) break;
      for (const { id, versions } of next.rows) {
        tried.push(id);
        const ok = await tryDelete(
          tx,
          sql`DELETE FROM portable_memory_items WHERE id = ${id} AND owner_user_id = ${userId}`,
          { itemId: id },
        );
        counts = add(counts, ok ? { items: 1, versions, kept: 0 } : { ...NO_SITE_PURGE, kept: 1 });
      }
    }
    await siteAudit(tx, "portable", "offboarding", counts, userId);
    return { status: "purged", counts };
  });
}
