import {
  MARK_READ_IDS_MAX,
  type ListNotificationsQuery,
  type ListNotificationsResponse,
  type MarkNotificationsReadBody,
  type MarkNotificationsReadResponse,
  type Notification,
  type NotificationKind,
} from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { z } from "zod";

/**
 * The caller's notifications in the active team (KOBE-179; contract in KOBE-176): every query is
 * in `withTeam()` (RLS) and names the caller's `user_id`, so nobody reads or marks anyone
 * else's. Rows whose schedule was deleted since (`schedule_id` set null) are left out: the
 * contract requires the schedule id.
 */
export interface Viewer {
  readonly teamId: string;
  readonly userId: string;
}

/** Opaque keyset cursor: the last row's `created_at` (microseconds, as text) and id. */
const cursorSchema = z.strictObject({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  i: z.uuid(),
});
type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** The cursor, or null when it is not one this server issued. */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Row = {
  id: string;
  kind: NotificationKind;
  schedule_id: string;
  thread_id: string | null;
  run_id: string | null;
  skipped_count: number | null;
  paused_by: "team_admin" | "deactivation" | null;
  read_at: Date | null;
  created_at: Date;
  created_key: string;
};

const iso = (d: Date | string) => new Date(d).toISOString();

function toNotification(row: Row): Notification {
  return {
    notification_id: row.id,
    kind: row.kind,
    schedule_id: row.schedule_id,
    thread_id: row.thread_id,
    run_id: row.run_id,
    ...(row.skipped_count !== null && row.skipped_count > 0
      ? { skipped_count: row.skipped_count }
      : {}),
    ...(row.paused_by !== null ? { paused_by: row.paused_by } : {}),
    read_at: row.read_at === null ? null : iso(row.read_at),
    created_at: iso(row.created_at),
  };
}

const mine = (v: Viewer) =>
  sql`team_id = ${v.teamId} AND user_id = ${v.userId} AND schedule_id IS NOT NULL`;

async function unreadCount(tx: KobeTx, v: Viewer): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM notifications WHERE ${mine(v)} AND read_at IS NULL`);
  return res.rows[0]?.n ?? 0;
}

/** Newest first; `cursor` must come from `decodeCursor` (null = first page). */
export async function listNotifications(
  db: KobeDb,
  v: Viewer,
  query: Omit<ListNotificationsQuery, "cursor">,
  cursor: Cursor | null,
): Promise<ListNotificationsResponse> {
  return withTeam(db, v.teamId, async (tx) => {
    const res = await tx.execute<Row>(sql`
      SELECT id, kind, schedule_id, thread_id, run_id, skipped_count, paused_by, read_at,
             created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
        FROM notifications
       WHERE ${mine(v)}
         ${query.unread ? sql`AND read_at IS NULL` : sql``}
         ${cursor ? sql`AND (created_at, id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${query.limit + 1}`);
    const page = res.rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      notifications: page.map(toNotification),
      unread_count: await unreadCount(tx, v),
      next_cursor:
        res.rows.length > query.limit && last
          ? encodeCursor({ t: last.created_key, i: last.id })
          : null,
    };
  });
}

/** Marks the caller's listed (or all) notifications read; already-read ones are not counted. */
export async function markNotificationsRead(
  db: KobeDb,
  v: Viewer,
  body: MarkNotificationsReadBody,
): Promise<MarkNotificationsReadResponse> {
  const ids = (body.notification_ids ?? []).slice(0, MARK_READ_IDS_MAX);
  return withTeam(db, v.teamId, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE notifications SET read_at = now()
       WHERE ${mine(v)} AND read_at IS NULL
         ${
           body.all
             ? sql``
             : sql`AND id IN (${sql.join(
                 ids.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})`
         }`);
    return { updated: res.rowCount ?? 0, unread_count: await unreadCount(tx, v) };
  });
}
