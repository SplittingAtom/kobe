import { sql, withTeam, type KobeDb, type KobeTx, type ThreadFileAccess } from "@kobe/db";
import { threadAttachmentPaths } from "../uploads/attach-list.js";
import { LINK_TOOLS, toolCallLink } from "./paths.js";
import { recordLinks, resolveTarget, type LinkInput, type LinkTarget } from "./record.js";

/**
 * One-time backfill of thread–file links (KOBE-610, TFM3) from what threads already store: the
 * file tool calls in their mirrored entries (a call whose result was an error, a denied call
 * included, is left out), their attachments, and project commits made from them. The same sources
 * and rules as live recording (`paths.ts`, `record.ts`); `bash` is never parsed (TFM2).
 *
 * Idempotent: counts merge as the larger (never added), first/last widen, so a second run (or a
 * run after live links were recorded for the same calls) changes nothing. Resumable: threads are
 * walked in (team, id) order, each in its own transaction that also stores the cursor
 * (`site_settings` key {@link BACKFILL_CURSOR_KEY}), so a stopped run continues after the last
 * thread it finished. Skill eval threads (their own sandbox) and offloaded entries are skipped.
 */
export const BACKFILL_CURSOR_KEY = "thread_file_links.backfill";

export interface BackfillCursor {
  readonly teamId: string;
  readonly threadId: string;
}

export interface BackfillOptions {
  /** Stop after this many threads (run again to continue). */
  readonly maxThreads?: number;
  /** Ignore the stored cursor and start over (safe: idempotent). */
  readonly restart?: boolean;
  /** Pause between threads, ms (default 0). */
  readonly paceMs?: number;
}

export interface BackfillResult {
  readonly threads: number;
  readonly links: number;
  /** Every thread has been walked (the cursor then reads `done`). */
  readonly done: boolean;
}

type StoredCursor = BackfillCursor | "done" | undefined;

async function readCursor(db: KobeDb): Promise<StoredCursor> {
  const res = await db.execute<{ value: string }>(
    sql`SELECT value FROM public.site_settings WHERE key = ${BACKFILL_CURSOR_KEY}`,
  );
  const value = res.rows[0]?.value;
  if (value === undefined) return undefined;
  if (value === "done") return "done";
  try {
    const parsed = JSON.parse(value) as { team_id?: unknown; thread_id?: unknown };
    return typeof parsed.team_id === "string" && typeof parsed.thread_id === "string"
      ? { teamId: parsed.team_id, threadId: parsed.thread_id }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeCursor(db: KobeDb | KobeTx, value: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.site_settings (key, value) VALUES (${BACKFILL_CURSOR_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
}

/** The team ids at or after `from`, in order (teams is site-wide: no team scope needed). */
async function teamIds(db: KobeDb, from: string | undefined): Promise<string[]> {
  const res = await db.execute<{ id: string }>(
    from === undefined
      ? sql`SELECT id FROM public.teams ORDER BY id`
      : sql`SELECT id FROM public.teams WHERE id >= ${from} ORDER BY id`,
  );
  return res.rows.map((r) => r.id);
}

async function nextThread(
  db: KobeDb,
  teamId: string,
  after: string | undefined,
): Promise<{ id: string; owner: string; eval: boolean } | undefined> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ id: string; owner_user_id: string; skill_eval: boolean }>(
      after === undefined
        ? sql`SELECT id, owner_user_id, skill_eval FROM threads
               WHERE team_id = ${teamId} ORDER BY id LIMIT 1`
        : sql`SELECT id, owner_user_id, skill_eval FROM threads
               WHERE team_id = ${teamId} AND id > ${after} ORDER BY id LIMIT 1`,
    ),
  );
  const row = res.rows[0];
  return row ? { id: row.id, owner: row.owner_user_id, eval: row.skill_eval } : undefined;
}

type Row = {
  readonly kind: "call" | "result";
  readonly call_id: string | null;
  readonly tool: string | null;
  readonly args: unknown;
  readonly is_error: string | null;
  readonly at: Date | string;
};

const linkToolNames = sql.join(
  Object.keys(LINK_TOOLS).map((t) => sql`${t}`),
  sql`, `,
);

/** File tool calls and their results in the thread's inline message entries, in append order. */
async function toolRows(tx: KobeTx, teamId: string, threadId: string): Promise<Row[]> {
  const res = await tx.execute<Row>(sql`
    SELECT kind, call_id, tool, args, is_error, at FROM (
      SELECT 'call' AS kind, p.part->>'id' AS call_id, p.part->>'name' AS tool,
             p.part->'arguments' AS args, NULL AS is_error, te.created_at AS at, te.seq, p.ord
        FROM thread_entries te
       CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(te.payload->'message'->'content') = 'array'
                    THEN te.payload->'message'->'content' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS p(part, ord)
       WHERE te.team_id = ${teamId} AND te.thread_id = ${threadId} AND te.type = 'message'
         AND te.blob_ref IS NULL
         AND te.payload->'message'->>'role' = 'assistant'
         AND p.part->>'type' = 'toolCall' AND p.part->>'name' IN (${linkToolNames})
      UNION ALL
      SELECT 'result', te.payload->'message'->>'toolCallId', te.payload->'message'->>'toolName',
             NULL, te.payload->'message'->>'isError', te.created_at, te.seq, 0
        FROM thread_entries te
       WHERE te.team_id = ${teamId} AND te.thread_id = ${threadId} AND te.type = 'message'
         AND te.blob_ref IS NULL
         AND te.payload->'message'->>'role' = 'toolResult'
         AND te.payload->'message'->>'toolName' IN (${linkToolNames})
    ) rows
     ORDER BY seq, ord`);
  return res.rows;
}

export interface CallUse {
  readonly path: string;
  readonly access: ThreadFileAccess;
  readonly at: Date;
}

/**
 * The uses of stored tool calls: a call counts when a result without error answers it (the latest
 * call with that id before the result). A call never answered, or answered with an error (denied,
 * failed), makes no link.
 */
export function usesFromRows(rows: readonly Row[]): CallUse[] {
  const pending = new Map<string, Row>();
  const out: CallUse[] = [];
  for (const row of rows) {
    if (row.call_id === null || row.tool === null) continue;
    if (row.kind === "call") {
      pending.set(row.call_id, row);
      continue;
    }
    const call = pending.get(row.call_id);
    pending.delete(row.call_id);
    if (call === undefined || row.is_error === "true" || call.tool !== row.tool) continue;
    const link = toolCallLink(row.tool, call.args);
    if (link !== undefined) out.push({ ...link, at: new Date(call.at) });
  }
  return out;
}

/** Folds uses into one link per (target, access): count, first and last. */
function aggregate(
  threadId: string,
  uses: readonly (CallUse & { readonly target: LinkTarget })[],
): LinkInput[] {
  const byKey = new Map<string, LinkInput & { at: Date; firstAt: Date; count: number }>();
  for (const use of uses) {
    const { target } = use;
    const key = [target.ownerUserId ?? "", target.projectId ?? "", target.path, use.access].join(
      "\u0000",
    );
    const seen = byKey.get(key);
    byKey.set(
      key,
      seen === undefined
        ? { ...target, threadId, access: use.access, at: use.at, firstAt: use.at, count: 1 }
        : {
            ...seen,
            at: seen.at > use.at ? seen.at : use.at,
            firstAt: seen.firstAt < use.at ? seen.firstAt : use.at,
            count: seen.count + 1,
          },
    );
  }
  return [...byKey.values()];
}

/** Attachments of the thread (write, TFM1) at their upload time. */
async function attachmentUses(tx: KobeTx, teamId: string, threadId: string): Promise<CallUse[]> {
  const paths = await threadAttachmentPaths(tx, teamId, threadId);
  if (paths.size === 0) return [];
  const res = await tx.execute<{ id: string; created_at: Date | string }>(sql`
    SELECT id, created_at FROM files
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND kind = 'upload'
       AND run_id IS NOT NULL`);
  return res.rows.flatMap((r) => {
    const path = paths.get(r.id);
    return path === undefined
      ? []
      : [{ path, access: "write" as const, at: new Date(r.created_at) }];
  });
}

/** Paths each commit made from the thread changed (against its parent), as project links. */
async function commitLinks(tx: KobeTx, teamId: string, threadId: string): Promise<LinkInput[]> {
  const res = await tx.execute<{
    project_id: string;
    path: string;
    first_at: Date | string;
    last_at: Date | string;
    n: string | number;
  }>(sql`
    WITH c AS (
      SELECT id, parent_id, project_id, created_at FROM project_commits
       WHERE team_id = ${teamId} AND thread_id = ${threadId}),
    n AS (
      SELECT c.id AS cid, e.path, e.sha256 FROM c
        JOIN project_tree_entries e ON e.team_id = ${teamId} AND e.commit_id = c.id),
    o AS (
      SELECT c.id AS cid, e.path, e.sha256 FROM c
        JOIN project_tree_entries e ON e.team_id = ${teamId} AND e.commit_id = c.parent_id),
    changed AS (
      SELECT COALESCE(n.cid, o.cid) AS cid, COALESCE(n.path, o.path) AS path
        FROM n FULL JOIN o ON o.cid = n.cid AND o.path = n.path
       WHERE n.path IS NULL OR o.path IS NULL OR n.sha256 <> o.sha256)
    SELECT c.project_id, ch.path, min(c.created_at) AS first_at, max(c.created_at) AS last_at,
           count(*) AS n
      FROM changed ch JOIN c ON c.id = ch.cid
     GROUP BY c.project_id, ch.path`);
  return res.rows.map((r) => ({
    threadId,
    projectId: r.project_id,
    path: r.path,
    access: "write" as const,
    firstAt: new Date(r.first_at),
    at: new Date(r.last_at),
    count: Number(r.n),
  }));
}

/** Backfills one thread (inside its team's transaction); returns the links written. */
export async function backfillThread(
  tx: KobeTx,
  teamId: string,
  thread: { readonly id: string; readonly owner: string },
): Promise<number> {
  const uses = [
    ...usesFromRows(await toolRows(tx, teamId, thread.id)),
    ...(await attachmentUses(tx, teamId, thread.id)),
  ];
  const targets = new Map<string, LinkTarget | undefined>();
  const resolved: (CallUse & { target: LinkTarget })[] = [];
  for (const use of uses) {
    if (!targets.has(use.path)) {
      targets.set(use.path, await resolveTarget(tx, teamId, thread.owner, use.path));
    }
    const target = targets.get(use.path);
    if (target !== undefined) resolved.push({ ...use, target });
  }
  const links = [...aggregate(thread.id, resolved), ...(await commitLinks(tx, teamId, thread.id))];
  await recordLinks(tx, teamId, links, "max");
  return links.length;
}

/** Walks every team's threads from the stored cursor; see the module comment. */
export async function backfillThreadFileLinks(
  db: KobeDb,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const stored = options.restart ? undefined : await readCursor(db);
  if (stored === "done") return { threads: 0, links: 0, done: true };
  const max = options.maxThreads ?? Number.POSITIVE_INFINITY;
  let threads = 0;
  let links = 0;
  for (const teamId of await teamIds(db, stored?.teamId)) {
    let after = stored !== undefined && teamId === stored.teamId ? stored.threadId : undefined;
    for (;;) {
      if (threads >= max) return { threads, links, done: false };
      const thread = await nextThread(db, teamId, after);
      if (thread === undefined) break;
      links += await withTeam(db, teamId, async (tx) => {
        const n = thread.eval ? 0 : await backfillThread(tx, teamId, thread);
        await writeCursor(tx, JSON.stringify({ team_id: teamId, thread_id: thread.id }));
        return n;
      });
      threads += 1;
      after = thread.id;
      if (options.paceMs) await new Promise((r) => setTimeout(r, options.paceMs));
    }
  }
  await writeCursor(db, "done");
  return { threads, links, done: true };
}
