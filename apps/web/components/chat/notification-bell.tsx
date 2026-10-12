"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  createNotificationsApi,
  type KobeNotification,
  type NotificationsApi,
} from "../../lib/notifications/api";
import {
  notificationTitle,
  scheduleLabel,
  type ScheduleWhen,
} from "../../lib/notifications/format";
import { createSchedulesApi } from "../../lib/schedules/api";
import { ErrorNotice } from "../admin/error-notice";
import { DateTime } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { IconAction } from "../shell/icon-action";
import shellStyles from "../shell/shell.module.css";
import { useNotificationList } from "./use-notification-list";
import styles from "./chat.module.css";

/** How often the badge asks for the unread count while the page is open. */
const POLL_MS = 60_000;

/** The unread count for the badge: on mount, every `pollMs`, and when the window regains focus. */
function useUnreadCount(api: NotificationsApi, pollMs: number) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      api.list({ unread: true, limit: 1 }).then(
        (res) => {
          if (current && res.ok) setUnread(res.data.unreadCount);
        },
        () => undefined, // the badge keeps its last count; the list shows errors when opened
      );
    };
    refresh();
    const timer = setInterval(refresh, pollMs);
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [api, pollMs]);
  return [unread, setUnread] as const;
}

function NotificationItem({
  note: n,
  label,
  onOpen,
  onMarkRead,
}: {
  readonly note: KobeNotification;
  readonly label: string;
  readonly onOpen: (() => void) | null;
  readonly onMarkRead: () => void;
}) {
  const title = notificationTitle(n);
  const unread = n.readAt === null;
  return (
    <li className={unread ? styles.noteUnread : styles.note}>
      <p className={styles.noteTitle}>
        {title}
        {unread && <span className={styles.visuallyHidden}> (unread)</span>}
      </p>
      <p className={styles.hint}>
        {label} · <DateTime value={n.createdAt} />
      </p>
      <p className={styles.noteActions}>
        {onOpen && (
          <button type="button" onClick={onOpen}>
            Open conversation<span className={styles.visuallyHidden}> for {title}</span>
          </button>
        )}
        {unread && (
          <button type="button" onClick={onMarkRead}>
            Mark read<span className={styles.visuallyHidden}>: {title}</span>
          </button>
        )}
      </p>
    </li>
  );
}

function NotificationPanel({
  id,
  open,
  refresh,
  api,
  teamId,
  fetchFn,
  onUnread,
  onOpenThread,
}: {
  readonly id: string;
  readonly open: boolean;
  /** Bumped on every open: the list is read again, the schedules are not. */
  readonly refresh: number;
  readonly api: NotificationsApi;
  readonly teamId: string;
  readonly fetchFn: typeof fetch | undefined;
  readonly onUnread: (count: number) => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const schedules = useResource(() => createSchedulesApi(teamId, fetchFn).list());
  // Until the caller's schedules are known (or if they fail), labels stay neutral.
  const known = useMemo<ReadonlyMap<string, ScheduleWhen> | null>(
    () =>
      schedules.state.status === "ready"
        ? new Map(schedules.state.data.schedules.map((s) => [s.scheduleId, s] as const))
        : null,
    [schedules.state],
  );
  const list = useNotificationList(api, onUnread, refresh);
  const { state } = list;
  const openThread = async (n: KobeNotification, threadId: string) => {
    if (n.readAt === null) await list.markRead([n.notificationId]);
    onOpenThread(threadId);
  };
  return (
    <section id={id} className={styles.notePanel} aria-label="Notifications" hidden={!open}>
      <p className={styles.noteToolbar}>
        <label>
          <input
            type="checkbox"
            checked={list.unreadOnly}
            onChange={(e) => list.setUnreadOnly(e.target.checked)}
          />{" "}
          Unread only
        </label>
        <button type="button" onClick={() => void list.markRead(null)}>
          Mark all read
        </button>
      </p>
      {list.actionError && <ErrorNotice error={list.actionError} />}
      {state.status === "loading" && <p role="status">Loading notifications…</p>}
      {state.status === "error" && <ErrorNotice error={state.error} />}
      {state.status === "ready" && state.items.length === 0 && (
        <p className={styles.hint}>
          {list.unreadOnly ? "No unread notifications." : "No notifications yet."} Scheduled runs
          report here when they end.
        </p>
      )}
      {state.status === "ready" && state.items.length > 0 && (
        <ul className={styles.noteList}>
          {state.items.map((n) => (
            <NotificationItem
              key={n.notificationId}
              note={n}
              label={scheduleLabel(n.scheduleId, known)}
              onOpen={n.threadId === null ? null : () => void openThread(n, n.threadId as string)}
              onMarkRead={() => void list.markRead([n.notificationId])}
            />
          ))}
        </ul>
      )}
      {state.status === "ready" && state.next !== null && (
        <p>
          <button type="button" disabled={list.loadingMore} onClick={() => void list.loadMore()}>
            {list.loadingMore ? "Loading…" : "Load more"}
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * The notification bell in the app header (spec D32, KOBE-181): unread badge, and a list of the
 * caller's scheduled-run notifications in the active team, each linking to its Scheduled thread.
 * Notifications carry ids and outcomes only (KOBE-176), never prompt or message text.
 */
export function NotificationBell({
  teamId,
  fetchFn,
  onOpenThread,
  pollMs = POLL_MS,
}: {
  readonly teamId: string;
  readonly fetchFn?: typeof fetch | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly pollMs?: number;
}) {
  const api = useMemo(() => createNotificationsApi(teamId, fetchFn), [teamId, fetchFn]);
  const [unread, setUnread] = useUnreadCount(api, pollMs);
  const [open, setOpen] = useState(false);
  // Opened at least once: the panel then stays mounted (hidden when closed) and keeps what it
  // loaded once (the caller's schedules); each open reads the list again.
  const [opens, setOpens] = useState(0);
  const panelId = useId();
  const badge = unread > 0 ? `${unread} unread` : undefined;
  return (
    <div className={styles.bell}>
      <IconAction
        command="notifications"
        badge={badge}
        className={shellStyles.iconLink}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) setOpens((n) => n + 1);
          setOpen(!open);
        }}
      />
      {opens > 0 && (
        <NotificationPanel
          key={teamId}
          id={panelId}
          open={open}
          refresh={opens}
          api={api}
          teamId={teamId}
          fetchFn={fetchFn}
          onUnread={setUnread}
          onOpenThread={(threadId) => {
            setOpen(false);
            onOpenThread(threadId);
          }}
        />
      )}
    </div>
  );
}
