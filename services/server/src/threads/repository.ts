import { endThreadRules } from "../policy/user-rules.js";
import {
  ACTIVE_RUN_STATUSES,
  and,
  approvals,
  asc,
  desc,
  eq,
  inArray,
  runs,
  sql,
  teamMembers,
  threadEntries,
  threads,
  users,
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
import {
  resolveSwitchPin,
  type AgentPin,
  type DraftPin,
  type PinError,
} from "../agents/versions.js";
import { visibilityOf } from "./share.js";
import { loadAccess } from "../projects/access.js";
import { applyShareScope, recordShareScope, shareScopeRefusal } from "./share-scope.js";
import { notifyThreadAccess } from "../event-stream/access.js";
import type { ThinkingLevel, ThreadVisibility } from "@kobe/protocol";
import { isSkippedSummaryEntry } from "../policy/skipped-summary.js";
import { isModelEnabled } from "../models/team-store.js";
import { trimLargeOutput } from "./entry-output.js";

/**
 * Thread data access (spec D9, D15, D18, D23, §6.1). Every function runs inside the caller's
 * `withTeam` transaction, so RLS confines it to the active team; the visibility rules below add
 * the per-user layer: a viewer reads their own threads (including their Trash), threads shared
 * to a project they belong to and threads shared with the team (CE20, KOBE-221), read-only and
 * never from Trash. Nobody else reads a thread — not a team admin (D18), not a site admin (D8;
 * break-glass is its own audited path, KOBE-16). Only the owner changes a thread.
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
  | "entry_not_found"
  | "entry_offloaded"
  | "nothing_to_fork"
  | "project_not_found"
  | "no_agent"
  | "model_not_enabled"
  | "thread_archived"
  | "test_thread"
  | PinError;

export type ThreadResult = { ok: true; thread: ThreadSummary } | { ok: false; error: ThreadError };

const TRASH_INTERVAL = sql.raw(`interval '${TRASH_RETENTION_DAYS} days'`);

/**
 * How long a change waits for the thread row. Appenders (the KOBE-29 seq trigger) and the run
 * orchestrator hold it; past this the change fails with 55P03, answered as 409 `thread_busy`.
 */
export const THREAD_LOCK_TIMEOUT = "2s";

/** Postgres lock_not_available (`lock_timeout` expired); the shared reader in `@kobe/db`. */
export { isLockTimeout } from "@kobe/db";
const DAY_MS = 86_400_000;

type TimeColumn =
  | typeof threads.lastActivityAt
  | typeof threads.deletedAt
  | typeof threads.pinnedAt
  | typeof threads.archivedAt;

const micros = (column: TimeColumn) =>
  sql<string>`(extract(epoch from ${column}) * 1000000)::bigint::text`;

export const summaryColumns = {
  id: threads.id,
  title: threads.title,
  status: threads.status,
  ownerUserId: threads.ownerUserId,
  projectId: threads.projectId,
  agentScope: threads.agentScope,
  agentId: threads.agentId,
  agentVersion: threads.agentVersion,
  sharedToProject: threads.sharedToProject,
  sharedToTeam: threads.sharedToTeam,
  modelAlias: threads.modelAlias,
  thinkingLevel: threads.thinkingLevel,
  leafEntryId: threads.leafEntryId,
  lastActivityAt: threads.lastActivityAt,
  createdAt: threads.createdAt,
  deletedAt: threads.deletedAt,
  isTest: threads.isTest,
  scheduleId: threads.scheduleId,
  forkedFromThreadId: threads.forkedFromThreadId,
  forkedAtEntryId: threads.forkedAtEntryId,
  pinnedAt: threads.pinnedAt,
  archivedAt: threads.archivedAt,
};

export type SummaryRow = {
  id: string;
  title: string | null;
  status: ThreadSummary["status"];
  ownerUserId: string;
  projectId: string | null;
  agentScope: AgentPin["agentScope"] | null;
  agentId: string | null;
  agentVersion: number | null;
  sharedToProject: boolean;
  sharedToTeam: boolean;
  modelAlias: string | null;
  /** KOBE-260; absent in rows read without it. */
  thinkingLevel?: ThinkingLevel | null;
  leafEntryId: string | null;
  lastActivityAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
  isTest: boolean;
  scheduleId?: string | null;
  forkedFromThreadId?: string | null;
  forkedAtEntryId?: string | null;
  pinnedAt?: Date | null;
  archivedAt?: Date | null;
};

/**
 * The summary without the viewer: a fork shows its fork point but never names its source, which
 * only {@link summarize} resolves for a viewer who may open it (KOBE-216, review-280 L2).
 */
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
    visibility: visibilityOf(row),
    model: row.modelAlias,
    thinking_level: row.thinkingLevel ?? null,
    leaf_entry_id: row.leafEntryId,
    last_activity_at: row.lastActivityAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    is_test: row.isTest,
    schedule_id: row.scheduleId ?? null,
    forked_from_thread_id: null,
    forked_from_title: null,
    forked_at_entry_id: row.forkedAtEntryId ?? null,
    pinned_at: row.pinnedAt?.toISOString() ?? null,
    archived_at: row.archivedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
    purge_after: row.deletedAt
      ? new Date(row.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString()
      : null,
  };
}

/**
 * Rows the viewer may read: own (Trash included while restorable; older Trash is awaiting purge
 * and treated as gone), or shared with the team or to one of their projects (never from Trash).
 */
function readableBy(viewer: Viewer): SQL {
  const own = sql`${eq(threads.ownerUserId, viewer.userId)} AND (${threads.deletedAt} IS NULL OR ${threads.deletedAt} > now() - ${TRASH_INTERVAL})`;
  return sql`${eq(threads.teamId, viewer.teamId)} AND (${own} OR (${sharedWith(viewer)} AND ${threads.deletedAt} IS NULL))`;
}

/** The thread's owner is still a member of its team and not deactivated (see {@link sharedWith}). */
function ownerIsActiveMember(): SQL {
  return sql`EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
    WHERE m.team_id = ${threads.teamId} AND m.user_id = ${threads.ownerUserId}
      AND u.deactivated_at IS NULL)`;
}

/**
 * Shared to the viewer by its scope: with the team, or to one of their projects (D23, CE20), and
 * only while its owner is a current, active member of the team (KOBE-221, fail closed): a share
 * never outlives the one person who could revoke it, whatever happened to `endSharesOf`. One
 * primary-key lookup each in `team_members` and `users`.
 */
function sharedWith(viewer: Viewer): SQL {
  const scope =
    viewer.projectIds.length === 0
      ? sql`${threads.sharedToTeam}`
      : sql`(${threads.sharedToTeam} OR ${and(
          eq(threads.sharedToProject, true),
          inArray(threads.projectId, [...viewer.projectIds]),
        )})`;
  return sql`${scope} AND ${ownerIsActiveMember()}`;
}

/**
 * The summaries as `viewer` sees them (CE16, KOBE-216): a fork names its source (id and title) only
 * while the viewer may open it, resolved by {@link findThreads} like `findThread`. Otherwise (the
 * share was revoked, the source moved or was purged) only `forked_at_entry_id` shows, which names
 * an entry of the fork itself. One hop: provenance is never walked further.
 */
export async function summarize(
  tx: KobeTx,
  viewer: Viewer,
  rows: readonly SummaryRow[],
): Promise<ThreadSummary[]> {
  const ids = new Set(rows.flatMap((r) => (r.forkedFromThreadId ? [r.forkedFromThreadId] : [])));
  const sources =
    ids.size === 0 ? new Map<string, SummaryRow>() : await findThreads(tx, viewer, [...ids]);
  const owners = await sharerNames(tx, viewer, rows);
  const viewable = await viewableProjects(tx, viewer, rows);
  const waiting = await awaitingViewer(tx, viewer, rows);
  return rows.map((row) => {
    const source = row.forkedFromThreadId ? sources.get(row.forkedFromThreadId) : undefined;
    // Pin and archive are the owner's own organization (CE19): a reader never sees them.
    const own = row.ownerUserId === viewer.userId;
    const summary = {
      ...ownOrganization(toSummary(row), viewer),
      read_only: !own,
      owner_name: own ? null : (owners.get(row.ownerUserId) ?? null),
      ...maskedProject(row, viewer, viewable),
      ...(waiting.has(row.id) ? { pending_approval: true as const } : {}),
    };
    return source
      ? { ...summary, forked_from_thread_id: source.id, forked_from_title: source.title }
      : summary;
  });
}

/**
 * The projects of others' `rows` the viewer may open (member, or team admin), as the markers decide
 * (`project-moves.ts`). A team share can reach people outside the thread's project (CE20): they
 * see the thread, not which project it is in.
 */
export async function viewableProjects(
  tx: KobeTx,
  viewer: Viewer,
  rows: readonly { readonly ownerUserId: string; readonly projectId: string | null }[],
): Promise<ReadonlySet<string>> {
  const visible = new Set(viewer.projectIds);
  const unknown = new Set(
    rows.flatMap((r) =>
      r.ownerUserId !== viewer.userId && r.projectId !== null && !visible.has(r.projectId)
        ? [r.projectId]
        : [],
    ),
  );
  for (const projectId of unknown) {
    if (await canViewProject(tx, viewer, projectId)) visible.add(projectId);
  }
  return visible;
}

/** Whether the viewer may open the project: a member, or a team admin (as the markers decide). */
export async function canViewProject(
  tx: KobeTx,
  viewer: Viewer,
  projectId: string,
): Promise<boolean> {
  if (viewer.projectIds.includes(projectId)) return true;
  return (await loadAccess(tx, viewer, projectId))?.can.view === true;
}

/** `project_id: null` for someone else's thread in a project the viewer may not open. */
export function maskedProject(
  row: { readonly ownerUserId: string; readonly projectId: string | null },
  viewer: Viewer,
  viewable: ReadonlySet<string>,
): { project_id?: null } {
  const hidden =
    row.ownerUserId !== viewer.userId && row.projectId !== null && !viewable.has(row.projectId);
  return hidden ? { project_id: null } : {};
}

/**
 * The names of the people who shared `rows` with the viewer ("Shared by …", CE20), only those
 * still in the active team: someone who left shows as null. Never the email address.
 */
export async function sharerNames(
  tx: KobeTx,
  viewer: Viewer,
  rows: readonly { readonly ownerUserId: string }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((id) => id !== viewer.userId))];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, viewer.teamId), eq(teamMembers.userId, users.id)),
    )
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name]));
}

/**
 * Which of `rows` hold an approval waiting for the viewer (KOBE-301: the rail's amber dot): pending
 * and not yet expired, on a run the viewer started, since only the run's user may decide it
 * (KOBE-37). One query on the partial `approvals_pending_idx`, team-scoped like every read here.
 */
export async function awaitingViewer(
  tx: KobeTx,
  viewer: Viewer,
  rows: readonly { readonly id: string }[],
): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set();
  const found = await tx
    .selectDistinct({ threadId: approvals.threadId })
    .from(approvals)
    .where(
      and(
        eq(approvals.teamId, viewer.teamId),
        eq(approvals.userId, viewer.userId),
        eq(approvals.status, "pending"),
        sql`${approvals.expiresAt} > now()`,
        inArray(
          approvals.threadId,
          rows.map((r) => r.id),
        ),
      ),
    );
  return new Set(found.map((r) => r.threadId));
}

/** The summary with `pinned_at` / `archived_at` only for its owner (CE19, KOBE-220). */
export function ownOrganization<T extends ThreadSummary>(summary: T, viewer: Viewer): T {
  return summary.owner_user_id === viewer.userId
    ? summary
    : { ...summary, pinned_at: null, archived_at: null };
}

/** {@link summarize} for one row. */
export async function summarizeOne(
  tx: KobeTx,
  viewer: Viewer,
  row: SummaryRow,
): Promise<ThreadSummary> {
  const [summary] = await summarize(tx, viewer, [row]);
  if (!summary) throw new Error("summarize returned no summary");
  return summary;
}

/** Keyset predicate for (column DESC, id DESC) after `cursor`. */
function after(column: TimeColumn, c: ActivityCursor): SQL {
  return sql`(${column}, ${threads.id}) < (timestamptz 'epoch' + ${c.micros}::bigint * interval '1 microsecond', ${c.id}::uuid)`;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: ActivityCursor | null;
}

async function toPage(
  tx: KobeTx,
  viewer: Viewer,
  rows: readonly (SummaryRow & { position: string })[],
  limit: number,
): Promise<Page<ThreadSummary>> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: await summarize(tx, viewer, items),
    next: rows.length > limit && last ? { micros: last.position, id: last.id } : null,
  };
}

/**
 * The thread list (§6.1 `GET /v1/threads`), most recent activity first. Without a project: the
 * viewer's own live threads in the rail's normal groups, so neither pinned nor archived (CE19:
 * those are {@link listOwnOrganized}). With a project: its live threads the viewer may read (own,
 * or shared if the viewer is a project member), pinned and archived ones included. Never Trash.
 */
export async function listThreads(
  tx: KobeTx,
  viewer: Viewer,
  options: { projectId?: string | undefined; cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  // Others' threads of a project only for those who may open it: a team share is no way to list
  // the threads of a project one can't see (CE20).
  const projectOpen =
    options.projectId !== undefined && (await canViewProject(tx, viewer, options.projectId));
  const scope = options.projectId
    ? and(
        eq(threads.projectId, options.projectId),
        projectOpen ? readableBy(viewer) : eq(threads.ownerUserId, viewer.userId),
      )
    : and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        sql`${threads.pinnedAt} IS NULL AND ${threads.archivedAt} IS NULL`,
      );
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.lastActivityAt) })
    .from(threads)
    .where(
      and(
        // Explicit, not only in `scope` and RLS: see the KOBE-16 note in packages/db/README.md.
        eq(threads.teamId, viewer.teamId),
        scope,
        sql`${threads.deletedAt} IS NULL AND NOT ${threads.isTest}`,
        options.cursor ? after(threads.lastActivityAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.lastActivityAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

/**
 * The viewer's own pinned or archived live threads (CE19, KOBE-220), newest pin or archive first:
 * the rail's Pinned and Archived groups (indexes `threads_owner_pinned_idx`,
 * `threads_owner_archived_idx`). A thread is in at most one: archiving unpins it.
 */
export async function listOwnOrganized(
  tx: KobeTx,
  viewer: Viewer,
  options: { which: "pinned" | "archived"; cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  const column = options.which === "pinned" ? threads.pinnedAt : threads.archivedAt;
  const rows = await tx
    .select({ ...summaryColumns, position: micros(column) })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        sql`${column} IS NOT NULL AND ${threads.deletedAt} IS NULL AND NOT ${threads.isTest}`,
        options.which === "pinned" ? sql`${threads.archivedAt} IS NULL` : undefined,
        options.cursor ? after(column, options.cursor) : undefined,
      ),
    )
    // NULLS LAST as the indexes are built, so the scan is already in order (no sort).
    .orderBy(sql`${column} DESC NULLS LAST`, sql`${threads.id} DESC NULLS LAST`)
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

/**
 * Shared with me (CE20, KOBE-221): other members' live threads shared with the viewer, with the
 * team or to one of their projects, most recent activity first (indexes `threads_team_shared_idx`
 * and `threads_project_activity_idx`). Read-only for the viewer; never test threads or Trash.
 */
export async function listSharedWithMe(
  tx: KobeTx,
  viewer: Viewer,
  options: { cursor: ActivityCursor | null; limit: number },
): Promise<Page<ThreadSummary>> {
  const rows = await tx
    .select({ ...summaryColumns, position: micros(threads.lastActivityAt) })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        sql`${threads.ownerUserId} <> ${viewer.userId}`,
        sharedWith(viewer),
        sql`${threads.deletedAt} IS NULL AND NOT ${threads.isTest}`,
        options.cursor ? after(threads.lastActivityAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.lastActivityAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
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
        sql`${threads.deletedAt} > now() - ${TRASH_INTERVAL} AND NOT ${threads.isTest}`,
        options.cursor ? after(threads.deletedAt, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(threads.deletedAt), desc(threads.id))
    .limit(options.limit + 1);
  return toPage(tx, viewer, rows, options.limit);
}

export async function createThread(
  tx: KobeTx,
  input: {
    teamId: string;
    ownerUserId: string;
    projectId: string | null;
    /** A pre-chosen id (a fork copies blobs into the new thread's tree first); default: random. */
    id?: string;
    /**
     * The published agent version the thread pins (D19); null = the site default agent. A
     * `DraftPin` (no version) makes it a builder test thread (KOBE-85): pass `isTest`.
     */
    agent: AgentPin | DraftPin | null;
    isTest?: boolean;
    /** The schedule that started the thread (KOBE-174): it sits in the user's Scheduled folder. */
    scheduleId?: string;
    title: string | null;
    /** The thread's model alias (KOBE-44); the caller checked the team enabled it. */
    modelAlias?: string | null;
    /** The conversation's thinking level (KOBE-260); clamped when each run starts. */
    thinkingLevel?: ThinkingLevel | null;
    /**
     * A fork's provenance (CE16): its source and the entry it was taken at. Set here only: the
     * link is never updated afterwards (trigger `threads_guard_forked_from`, KOBE-215).
     */
    forkedFrom?: { readonly threadId: string; readonly entryId: string };
  },
): Promise<ThreadSummary> {
  const { agent, modelAlias, isTest, forkedFrom, ...rest } = input;
  const [row] = await tx
    .insert(threads)
    .values({
      ...rest,
      forkedFromThreadId: forkedFrom?.threadId ?? null,
      forkedAtEntryId: forkedFrom?.entryId ?? null,
      modelAlias: modelAlias ?? null,
      isTest: isTest ?? false,
      agentScope: agent?.agentScope ?? null,
      agentId: agent?.agentId ?? null,
      agentVersion: agent?.agentVersion ?? null,
    })
    .returning(summaryColumns);
  if (!row) throw new Error("thread insert returned no row");
  return toSummary(row);
}

/**
 * The thread with the viewer's access to it, or null when they may not read it (unknown id,
 * another team's thread, another user's private thread: all indistinguishable). `lock` takes the
 * row lock that every change holds; lock order is thread before run (KOBE-29). It is
 * `FOR NO KEY UPDATE`, as `lockThreadRow` (KOBE-266: `FOR UPDATE` deadlocked with foreign-key checks).
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
  const [row] = await (options.lock ? query.for("no key update") : query);
  if (!row) return null;
  return { thread: row, access: row.ownerUserId === viewer.userId ? "owner" : "reader" };
}

/**
 * The threads among `ids` the viewer may read, by id: {@link findThread} for many ids at once
 * (the same predicate, no lock). Ids the viewer may not read are simply absent.
 */
export async function findThreads(
  tx: KobeTx,
  viewer: Viewer,
  ids: readonly string[],
): Promise<Map<string, SummaryRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select(summaryColumns)
    .from(threads)
    .where(and(inArray(threads.id, [...ids]), readableBy(viewer)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Locks the thread for a change by its owner, or says why the viewer can't change it. */
export async function lockForChange(
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

export async function hasRunIn(
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

/**
 * The owner's changes to a thread: title, model and share scope. `visibility` (`POST /share`) sets
 * the scope; the older `shared_to_project` (PATCH) shares to the project (true) or ends a project
 * share (false; a team share stays).
 */
export async function updateThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  body: UpdateThreadBody & { readonly visibility?: ThreadVisibility },
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  const before = locked.thread;
  if (before.deletedAt) return { ok: false, error: "thread_in_trash" };
  // PATCH shared_to_project (KOBE-34) is about the project: refused outside one, as before.
  if (body.shared_to_project !== undefined && before.projectId === null) {
    return { ok: false, error: "not_in_project" };
  }
  const target = targetScope(before, body);
  if (target !== undefined) {
    const refusal = await shareScopeRefusal(tx, viewer, before, target);
    if (refusal) return { ok: false, error: refusal };
  }
  // A newly chosen model must be one the team enabled; keeping the current one is always fine.
  const modelChanged = body.model !== undefined && body.model !== before.modelAlias;
  if (modelChanged && body.model && !(await isModelEnabled(tx, viewer.teamId, body.model))) {
    return { ok: false, error: "model_not_enabled" };
  }
  const set = {
    // The owner's own name locks the title against auto-titling (CE18, KOBE-292), and
    // clearing it hands the name back to auto-titling.
    ...(body.title !== undefined ? { title: body.title, titleLocked: body.title !== null } : {}),
    ...applyShareScope(before, target),
    ...(modelChanged ? { modelAlias: body.model ?? null } : {}),
    // KOBE-260: any level may be chosen; each run clamps it to the site and team settings.
    ...(body.thinking_level !== undefined && body.thinking_level !== (before.thinkingLevel ?? null)
      ? { thinkingLevel: body.thinking_level }
      : {}),
  };
  // Nothing changes (the scope it already has, the same model): idempotent, nothing recorded.
  if (Object.keys(set).length === 0) {
    return { ok: true, thread: await summarizeOne(tx, viewer, before) };
  }
  const [row] = await tx
    .update(threads)
    .set(set)
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  await recordShareScope(tx, viewer, before, row);
  if (modelChanged) {
    await recordAudit(tx, {
      action: "thread.model_changed",
      teamId: viewer.teamId,
      target: { threadId: id, from: before.modelAlias, to: row.modelAlias },
    });
  }
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/** The scope a change asks for, or undefined when it leaves the scope alone. */
function targetScope(
  thread: SummaryRow,
  body: {
    readonly visibility?: ThreadVisibility | undefined;
    readonly shared_to_project?: boolean | undefined;
  },
): ThreadVisibility | undefined {
  if (body.visibility !== undefined) return body.visibility;
  if (body.shared_to_project === undefined) return undefined;
  if (body.shared_to_project) return "project";
  return visibilityOf(thread) === "project" ? "private" : undefined;
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
  // The skipped-actions note is not in Pi's session: it can't be where Pi continues from.
  if (!entry || (await isSkippedSummaryEntry(tx, viewer.teamId, id, entryId))) {
    return { ok: false, error: "entry_not_found" };
  }
  const [row] = await tx
    .update(threads)
    .set({ leafEntryId: entryId })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/**
 * Pins another published version of the thread's agent (D19 one-click switch; default: the
 * agent's current version). Owner only, like every change. Refused while a run is active (the run
 * started on the old version); queued runs resolve the pin when they start (KOBE-47). The agent
 * must still be available to the owner (not suspended or archived).
 */
export async function switchAgentVersion(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  version: number | undefined,
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (thread.agentId === null || thread.agentVersion === null || thread.agentScope === null) {
    return { ok: false, error: "no_agent" };
  }
  if (await hasRunIn(tx, viewer, id, ACTIVE_RUN_STATUSES)) {
    return { ok: false, error: "thread_busy" };
  }
  const pin = await resolveSwitchPin(
    tx,
    viewer,
    { agentScope: thread.agentScope, agentId: thread.agentId },
    version,
  );
  if (!pin.ok) return pin;
  if (pin.value.agentVersion === thread.agentVersion)
    return { ok: true, thread: await summarizeOne(tx, viewer, thread) };
  const [row] = await tx
    .update(threads)
    .set({ agentVersion: pin.value.agentVersion })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  await recordAudit(tx, {
    action: "thread.agent_switched",
    teamId: viewer.teamId,
    target: {
      threadId: id,
      agentId: thread.agentId,
      scope: thread.agentScope,
      fromVersion: thread.agentVersion,
      toVersion: pin.value.agentVersion,
    },
  });
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

export const PENDING_RUN_STATUSES: readonly RunStatus[] = ["queued", ...ACTIVE_RUN_STATUSES];

/**
 * Moves the thread to Trash (D18 soft delete). Refused while it has an active or queued run: Stop
 * and clear queued messages first, so nothing runs on a thread its owner deleted. Idempotent.
 */
export async function trashThread(tx: KobeTx, viewer: Viewer, id: string): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (locked.thread.deletedAt)
    return { ok: true, thread: await summarizeOne(tx, viewer, locked.thread) };
  if (await hasRunIn(tx, viewer, id, PENDING_RUN_STATUSES))
    return { ok: false, error: "thread_busy" };
  const [row] = await tx
    .update(threads)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  // Trash ends the thread's remembered approvals for good: a restore doesn't bring them back.
  await endThreadRules(tx, viewer.teamId, [id]);
  await recordAudit(tx, {
    action: "thread.trashed",
    teamId: viewer.teamId,
    target: { threadId: id },
  });
  // Readers lose a shared thread while it is in Trash: their open streams recheck now.
  if (visibilityOf(row) !== "private") await notifyThreadAccess(tx, viewer.teamId, id);
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}

/** Restores a thread from Trash within the 30-day window; past it the thread awaits purge. */
export async function restoreThread(tx: KobeTx, viewer: Viewer, id: string): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  if (!locked.thread.deletedAt) return { ok: false, error: "not_in_trash" };
  const [row] = await tx
    // Restoring counts as activity: the retention period runs again from now (KOBE-18 review H1),
    // so a thread restored near the end of its period isn't purged the next night.
    .update(threads)
    .set({ deletedAt: null, lastActivityAt: sql`now()` })
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
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
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
    entries: page.map((r) => {
      // An offloaded body lives in object storage; never echo whatever was left inline. A tool
      // output over 64 KB is cut to a preview (KOBE-208: read in full when its card opens).
      const trimmed = r.blobRef !== null ? undefined : trimLargeOutput(r.payload);
      return {
        entry_id: r.entryId,
        parent_id: r.parentId,
        seq: r.seq,
        type: r.type,
        payload: (trimmed?.payload ?? {}) as Record<string, unknown>,
        payload_offloaded: r.blobRef !== null,
        ...(trimmed?.truncated ? { payload_truncated: true } : {}),
        created_at: r.createdAt.toISOString(),
      };
    }),
    nextAfter: rows.length > limit ? (page.at(-1)?.seq ?? null) : null,
  };
}

/**
 * Clears the viewer's own test threads (KOBE-85), all or those of one agent: moves them to Trash
 * (soft delete, so their runs and `run_usage` stay for budgets; Trash lists never show them and
 * the retention purge removes them later). Threads with an active or queued run are skipped
 * (stop them first). Not audited: they are throwaway, and nothing is shared. Returns the count.
 */
export async function clearTestThreads(
  tx: KobeTx,
  viewer: Viewer,
  options: { agentId?: string | undefined },
): Promise<number> {
  const busy = sql`EXISTS (SELECT 1 FROM ${runs} r WHERE r.team_id = ${threads.teamId}
    AND r.thread_id = ${threads.id} AND r.status IN ('queued', 'running', 'waiting_approval'))`;
  const rows = await tx
    .update(threads)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.ownerUserId, viewer.userId),
        eq(threads.isTest, true),
        sql`${threads.deletedAt} IS NULL`,
        options.agentId === undefined ? undefined : eq(threads.agentId, options.agentId),
        sql`NOT ${busy}`,
      ),
    )
    .returning({ id: threads.id });
  await endThreadRules(
    tx,
    viewer.teamId,
    rows.map((r) => r.id),
  );
  return rows.length;
}
