import { and, eq, inArray, lte, sql, threads, type KobeTx } from "@kobe/db";
import {
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_SIBLINGS,
  type LineageAncestor,
  type LineageRelative,
  type ThreadLineageResponse,
} from "@kobe/protocol";
import { findThread, readableBy, type Viewer } from "./repository.js";

/**
 * A thread's family for the lineage strip (TL1, TL2; KOBE-533): the readable ancestors root
 * first, the thread with its fork point, and the readable forks at every level. Runs inside the
 * caller's `withTeam()` transaction: the thread (one query), the walk up `forked_from_thread_id`
 * (one query per generation, at most {@link LINEAGE_MAX_DEPTH}), then every list in one query
 * over `threads_forked_from_idx`. Nothing about a thread the viewer cannot read is returned.
 */

/** A row of the walk or the forks query. */
export interface LineageMember {
  readonly id: string;
  readonly title: string | null;
  readonly deletedAt: Date | null;
  readonly ownerUserId: string;
  readonly forkedFromThreadId: string | null;
}

/** Builder test, Workbench test and eval threads are never part of a lineage (TL2). */
const listed = sql`NOT ${threads.isTest} AND NOT ${threads.skillTest} AND NOT ${threads.skillEval}`;

const memberColumns = {
  id: threads.id,
  title: threads.title,
  deletedAt: threads.deletedAt,
  ownerUserId: threads.ownerUserId,
  forkedFromThreadId: threads.forkedFromThreadId,
};

/** The thread, or null when the viewer may not read it (as every thread read: 404). */
export async function readLineage(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<ThreadLineageResponse | null> {
  const found = await findThread(tx, viewer, id);
  if (!found) return null;
  const self: LineageMember = {
    id: found.thread.id,
    title: found.thread.title,
    deletedAt: found.thread.deletedAt,
    ownerUserId: found.thread.ownerUserId,
    forkedFromThreadId: found.thread.forkedFromThreadId ?? null,
  };
  const { path, rootHidden } = await walkUp(tx, viewer, self);
  const forks = await forksOf(tx, viewer, [...path.map((m) => m.id), self.id]);
  return assembleLineage({
    viewer,
    self,
    forkedAtEntryId: found.thread.forkedAtEntryId ?? null,
    path,
    rootHidden,
    forks,
  });
}

/**
 * The readable ancestors, parent first, at most {@link LINEAGE_MAX_DEPTH}. A parent the viewer
 * cannot read (or never listed) stops the walk with `rootHidden`; a purged one nulled the key,
 * so the walk simply ends. The provenance trigger rules out cycles (TL5).
 */
async function walkUp(
  tx: KobeTx,
  viewer: Viewer,
  self: LineageMember,
): Promise<{ path: LineageMember[]; rootHidden: boolean }> {
  const path: LineageMember[] = [];
  let next = self.forkedFromThreadId;
  while (next !== null && path.length < LINEAGE_MAX_DEPTH) {
    const [parent] = await tx
      .select(memberColumns)
      .from(threads)
      .where(
        and(eq(threads.teamId, viewer.teamId), eq(threads.id, next), readableBy(viewer), listed),
      );
    if (!parent) return { path, rootHidden: true };
    path.push(parent);
    next = parent.forkedFromThreadId;
  }
  return { path, rootHidden: false };
}

/**
 * The readable, listed forks of each of `parents`, newest activity first, one more than the cap
 * per parent (to know whether a list was cut). One query over `threads_forked_from_idx`.
 */
async function forksOf(
  tx: KobeTx,
  viewer: Viewer,
  parents: readonly string[],
): Promise<Map<string, LineageMember[]>> {
  const ranked = tx
    .select({
      ...memberColumns,
      rank: sql<number>`row_number() OVER (PARTITION BY ${threads.forkedFromThreadId}
        ORDER BY ${threads.lastActivityAt} DESC, ${threads.id} DESC)`.as("rank"),
    })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        inArray(threads.forkedFromThreadId, [...parents]),
        readableBy(viewer),
        listed,
      ),
    )
    .as("ranked");
  const rows = await tx
    .select()
    .from(ranked)
    .where(lte(ranked.rank, LINEAGE_MAX_SIBLINGS + 1))
    .orderBy(ranked.forkedFromThreadId, ranked.rank);
  const byParent = new Map<string, LineageMember[]>();
  for (const row of rows) {
    if (row.forkedFromThreadId === null) continue;
    byParent.set(row.forkedFromThreadId, [...(byParent.get(row.forkedFromThreadId) ?? []), row]);
  }
  return byParent;
}

/** A capped list, `more` when cut. `keep` (the thread on the path) always stays in, last when past the cut. */
export function capList(
  list: readonly LineageMember[],
  keep?: LineageMember,
): { list: readonly LineageMember[]; more: boolean } {
  if (list.length <= LINEAGE_MAX_SIBLINGS) return { list, more: false };
  const head = list.slice(0, LINEAGE_MAX_SIBLINGS);
  if (!keep || head.some((m) => m.id === keep.id)) return { list: head, more: true };
  // Past the cut it is older than every listed one, so it goes last.
  return { list: [...head.slice(0, -1), keep], more: true };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function relative(viewer: Viewer, m: LineageMember): LineageRelative {
  return {
    thread_id: m.id,
    title: m.title,
    deleted_at: iso(m.deletedAt),
    owner: m.ownerUserId === viewer.userId ? "me" : "other",
  };
}

/**
 * The response from the walk and the forks (pure). `path` is parent first. Siblings of a thread
 * are the forks of its parent on the path; the topmost readable thread has none ([]), whether it
 * is the root, its parent was purged, or its parent is hidden (listing them would hint at it).
 */
export function assembleLineage(input: {
  viewer: Viewer;
  self: LineageMember;
  forkedAtEntryId: string | null;
  path: readonly LineageMember[];
  rootHidden: boolean;
  forks: ReadonlyMap<string, readonly LineageMember[]>;
}): ThreadLineageResponse {
  const { viewer, self, path, forks } = input;
  const chain = [...path].reverse(); // root first
  const siblingsOf = (index: number, member: LineageMember) => {
    const parent = index === 0 ? undefined : chain[index - 1];
    if (!parent) return { siblings: [], siblings_more: false };
    const cut = capList(forks.get(parent.id) ?? [], member);
    return { siblings: cut.list.map((m) => relative(viewer, m)), siblings_more: cut.more };
  };
  const ancestors: LineageAncestor[] = chain.map((m, i) => ({
    thread_id: m.id,
    title: m.title,
    deleted_at: iso(m.deletedAt),
    ...siblingsOf(i, m),
  }));
  const own = capList(forks.get(self.id) ?? []);
  return {
    thread_id: self.id,
    root_hidden: input.rootHidden,
    ancestors,
    self: {
      thread_id: self.id,
      title: self.title,
      forked_at_entry_id: input.forkedAtEntryId,
      ...siblingsOf(chain.length, self),
    },
    forks: own.list.map((m) => relative(viewer, m)),
    forks_more: own.more,
  };
}
