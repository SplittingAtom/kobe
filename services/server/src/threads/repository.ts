import {
  ACTIVE_RUN_STATUSES,
  and,
  asc,
  desc,
  eq,
  inArray,
  runs,
  sql,
  threadEntries,
  threads,
  type KobeTx,
  type RunStatus,
} from "@kobe/db";
import type { ActivityCursor } from "./cursor.js";
import {
  TRASH_RETENTION_DAYS,
  type ThreadEntry,
  type ThreadSummary,
  type UpdateThreadBody,
} from "./schemas.js";
import { recordAudit } from "../audit/record.js";

/**
 * Thread data access (spec D9, D15, D18, D23, §6.1). Every function runs inside the caller's
 * `withTeam` transaction, so RLS confines it to the active team; the visibility rules below add
 * the per-user layer: a viewer reads their own threads (including their Trash) and threads shared
 * to a project they belong to (read-only, never from Trash). Nobody else reads a thread — not a
 * team admin (D18), not an install admin (D8; break-glass is its own audited path, KOBE-16).
 * Only the owner changes a thread.
 */

type SQL = ReturnType<typeof sql>;

export interface Viewer {
  /** The active team (also enforced by RLS; repeated here so every query leads its index). */
  readonly teamId: string;
  readonly userId: string;
  /** Projects of the active team the viewer is a member of (KOBE-57; empty until then). */
  readonly projectIds: readonly string[];
}

export type ThreadAccess = "owner" | "reader";

export type ThreadError =
  | "thread_not_found"
  | "read_only"
  | "thread_busy"
  | "thread_in_trash"
  | "not_in_trash"
  | "not_in_project"
  | "entry_not_found";

export type ThreadResult = { ok: true; thread: ThreadSummary } | { ok: false; error: ThreadError };

const TRASH_INTERVAL = sql.raw(`interval '${TRASH_RETENTION_DAYS} days'`);

/**
 * How long a change waits for the thread row. Appenders (the KOBE-29 seq trigger) and the run
 * orchestrator hold it; past this the change fails with 55P03, answered as 409 `thread_busy`.
 */
export const THREAD_LOCK_TIMEOUT = "2s";

/** Postgres lock_not_available: `lock_timeout` expired. */
const LOCK_NOT_AVAILABLE = "55P03";

export function isLockTimeout(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === LOCK_NOT_AVAILABLE || e?.cause?.code === LOCK_NOT_AVAILABLE;
}
const DAY_MS = 86_400_000;

type TimeColumn = typeof threads.lastActivityAt | typeof threads.deletedAt;

const micros = (column: TimeColumn) =>
  sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`;

const summaryColumns = {
  id: threads.id,
  title: threads.title,
  status: threads.status,
  ownerUserId: threads.ownerUserId,
  projectId: threads.projectId,
  agentId: threads.agentId,
  agentVersion: threads.agentVersion,
  sharedToProject: threads.sharedToProject,
  leafEntryId: threads.leafEntryId,
  lastActivityAt: threads.lastActivityAt,
  createdAt: threads.createdAt,
  deletedAt: threads.deletedAt,
};

type SummaryRow = {
  id: string;
  title: string | null;
  status: ThreadSummary["status"];
  ownerUserId: string;
  projectId: string | null;
  agentId: string | null;
  agentVersion: number | null;
  sharedToProject: boolean;
  leafEntryId: string | null;
  lastActivityAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
};

export function toSummary(row: SummaryRow): ThreadSummary {
  return {
    thread_id: row.id,
    title: row.title,
    status: row.status,
    owner_user_id: row.ownerUserId,
    project_id: row.projectId,
    agent_id: row.agentId,
    agent_version: row.agentVersion,
    shared_to_project: row.sharedToProject,
    leaf_entry_id: row.leafEntryId,
    last_activity_at: row.lastActivityAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
    purge_after: row.deletedAt
      ? new Date(row.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString()
      : null,
  };
}

/**
 * Rows the viewer may read: own (Trash included while restorable; older Trash is awaiting purge
 * and treated as gone) or shared to one of their projects (never from Trash).
 */
function readableBy(viewer: Viewer): SQL {
  const own = sql`${eq(threads.ownerUserId, viewer.userId)} AND (${threads.deletedAt} IS NULL OR ${threads.deletedAt} > now() - ${TRASH_INTERVAL})`;
  if (viewer.projectIds.length === 0) return sql`${eq(threads.teamId, viewer.teamId)} AND ${own}`;
  const shared = and(
    eq(threads.sharedToProject, true),
    inArray(threads.projectId, [...viewer.projectIds]),
    sql`${threads.deletedAt} IS NULL`,
  );
  return sql`${eq(threads.teamId, viewer.teamId)} AND (${own} OR ${shared})`;
}

/** Keyset predicate for (column DESC, id DESC) after `cursor`. */
function after(column: TimeColumn, c: ActivityCursor): SQL {
  return sql`(${column}, ${threads.id}) < (timestamptz 'epoch' + ${c.micros}::bigint * interval '1 microsecond', ${c.id}::uuid)`;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: ActivityCursor | null;
}

function toPage(
  rows: readonly (SummaryRow & { position: string })[],
  limit: number,
): Page<ThreadSummary> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toSummary),
    next: rows.length > limit && last ? { micros: last.position, id: last.id } : null,
  };
}

/**
 * The thread list (§6.1 `GET /v1/threads`), most recent activity first. Without a project: the
 * viewer's own live threads. With a project: its live threads the viewer may read (own, or shared
 * if the viewer is a project member). Never Trash.
 */
export async function listThreads(
  tx: KobeTx,
  viewer: Viewer,
  options: { projectId?: string | undefined; cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  const scope = options.projectId
    ? and(eq(threads.projectId, options.projectId), readableBy(viewer))
    : and(eq(threads.teamId, viewer.teamId), eq(threads.ownerUserId, viewer.userId));
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.lastActivityAt) })
    .from(threads)
    .where(
      and(
        // Explicit, not only in `scope` and RLS: see the KOBE-16 note in packages/db/README.md.
        eq(threads.teamId, viewer.teamId),
        scope,
        sql`${threads.deletedAt} IS NULL`,
        options.cursor ? after(threads.lastActivityAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.lastActivityAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(rows, options.limit);
}

/** The viewer's Trash, most recently deleted first; only threads still restorable. */
export async function listTrash(
  tx: KobeTx,
  viewer: Viewer,
  options: { cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.deletedAt) })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        sql`${threads.deletedAt} > now() - ${TRASH_INTERVAL}`,
        options.cursor ? after(threads.deletedAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.deletedAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(rows, options.limit);
}

export async function createThread(
  tx: KobeTx,
  input: {
    teamId: string;
    ownerUserId: string;
    projectId: string | null;
    agentId: string | null;
    agentVersion: number | null;
    title: string | null;
  },
): Promise<ThreadSummary> {
  const [row] = await tx.insert(threads).values(input).returning(summaryColumns);
  if (!row) throw new Error("thread insert returned no row");
  return toSummary(row);
}

/**
 * The thread with the viewer's access to it, or null when they may not read it (unknown id,
 * another team's thread, another user's private thread: all indistinguishable). `lock` takes the
 * row lock that every change holds; lock order is thread before run (KOBE-29).
 */
export async function findThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  options: { lock?: boolean } = {},
): Promise<{ thread: SummaryRow; access: ThreadAccess } | null> {
  const query = tx
    .select(summaryColumns)
    .from(threads)
    .where(and(eq(threads.id, id), readableBy(viewer)));
  // Only the threads row is locked; nothing else is joined.
  const [row] = await (options.lock ? query.for("update") : query);
  if (!row) return null;
  return { thread: row, access: row.ownerUserId === viewer.userId ? "owner" : "reader" };
}

/** Locks the thread for a change by its owner, or says why the viewer can't change it. */
async function lockForChange(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
): Promise<{ ok: true; thread: SummaryRow } | { ok: false; error: ThreadError }> {
  // Transaction-local: fail fast (55P03) rather than queue behind a long-held row lock.
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${THREAD_LOCK_TIMEOUT}'`));
  const found = await findThread(tx, viewer, id, { lock: true });
  if (!found) return { ok: false, error: "thread_not_found" };
  if (found.access !== "owner") return { ok: false, error: "read_only" };
  return { ok: true, thread: found.thread };
}

async function hasRunIn(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
  statuses: readonly RunStatus[],
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(runs)
    .where(
      and(
        eq(runs.teamId, viewer.teamId),
        eq(runs.threadId, threadId),
        inArray(runs.status, [...statuses]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function updateThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  body: UpdateThreadBody,
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (body.shared_to_project !== undefined && locked.thread.projectId === null) {
    return { ok: false, error: "not_in_project" };
  }
  const [row] = await tx
    .update(threads)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.shared_to_project !== undefined ? { sharedToProject: body.shared_to_project } : {}),
    })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  if (row.projectId !== null && row.sharedToProject !== locked.thread.sharedToProject) {
    await recordAudit(tx, {
      action: "thread.sharing_changed",
      teamId: viewer.teamId,
      target: { threadId: id, projectId: row.projectId, shared: row.sharedToProject },
    });
  }
  return { ok: true, thread: toSummary(row) };
}

/**
 * Switches the active branch (§6.1 `POST /v1/threads/{id}/leaf`, D15). Refused while a run holds
 * the thread: Pi continues from its own leaf and would diverge from the record.
 */
export async function setLeaf(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  entryId: string,
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (await hasRunIn(tx, viewer, id, ACTIVE_RUN_STATUSES))
    return { ok: false, error: "thread_busy" };
  const [entry] = await tx
    .select({ entryId: threadEntries.entryId })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, viewer.teamId),
        eq(threadEntries.threadId, id),
        eq(threadEntries.entryId, entryId),
      ),
    );
  if (!entry) return { ok: false, error: "entry_not_found" };
  const [row] = await tx
    .update(threads)
    .set({ leafEntryId: entryId })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  return { ok: true, thread: toSummary(row) };
}

const PENDING_RUN_STATUSES: readonly RunStatus[] = ["queued", ...ACTIVE_RUN_STATUSES];

/**
 * Moves the thread to Trash (D18 soft delete). Refused while it has an active or queued run: Stop
 * and clear queued messages first, so nothing runs on a thread its owner deleted. Idempotent.
 */
export async function trashThread(tx: KobeTx, viewer: Viewer, id: string): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt) return { ok: true, thread: toSummary(locked.thread) };
  if (await hasRunIn(tx, viewer, id, PENDING_RUN_STATUSES))
    return { ok: false, error: "thread_busy" };
  const [row] = await tx
    .update(threads)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  await recordAudit(tx, {
    action: "thread.trashed",
    teamId: viewer.teamId,
    target: { threadId: id },
  });
  return { ok: true, thread: toSummary(row) };
}

/** Restores a thread from Trash within the 30-day window; past it the thread awaits purge. */
export async function restoreThread(tx: KobeTx, viewer: Viewer, id: string): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (!locked.thread.deletedAt) return { ok: false, error: "not_in_trash" };
  const [row] = await tx
    .update(threads)
    .set({ deletedAt: null })
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.id, id),
        sql`${threads.deletedAt} > now() - ${TRASH_INTERVAL}`,
      ),
    )
    .returning(summaryColumns);
  if (!row) return { ok: false, error: "thread_not_found" };
  await recordAudit(tx, {
    action: "thread.restored",
    teamId: viewer.teamId,
    target: { threadId: id },
  });
  return { ok: true, thread: toSummary(row) };
}

/** One page of the thread's entries in append order (`seq`), after `afterSeq`. */
export async function listEntries(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
  afterSeq: number,
  limit: number,
): Promise<{ entries: ThreadEntry[]; nextAfter: number | null }> {
  const rows = await tx
    .select({
      entryId: threadEntries.entryId,
      parentId: threadEntries.parentId,
      seq: threadEntries.seq,
      type: threadEntries.type,
      payload: threadEntries.payload,
      blobRef: threadEntries.blobRef,
      createdAt: threadEntries.createdAt,
    })
    .from(threadEntries)
    .where(
      and(
        eq(threadEntries.teamId, viewer.teamId),
        eq(threadEntries.threadId, threadId),
        sql`${threadEntries.seq} > ${afterSeq}`,
      ),
    )
    .orderBy(asc(threadEntries.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    entries: page.map((r) => ({
      entry_id: r.entryId,
      parent_id: r.parentId,
      seq: r.seq,
      type: r.type,
      // An offloaded body lives in object storage; never echo whatever was left inline.
      payload: r.blobRef !== null ? {} : r.payload,
      payload_offloaded: r.blobRef !== null,
      created_at: r.createdAt.toISOString(),
    })),
    nextAfter: rows.length > limit ? (page.at(-1)?.seq ?? null) : null,
  };
}
