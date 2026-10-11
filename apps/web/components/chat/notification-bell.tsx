"use client";

import { BellIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  createNotificationsApi,
  type KobeNotification,
  type NotificationsApi,
} from "../../lib/notifications/api";
import { notificationTitle, scheduleLabel } from "../../lib/notifications/format";
import { createSchedulesApi } from "../../lib/schedules/api";
import { ErrorNotice } from "../admin/error-notice";
import { DateTime } from "../admin/parts";
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
  api,
  teamId,
  fetchFn,
  onUnread,
  onOpenThread,
}: {
  readonly id: string;
  readonly api: NotificationsApi;
  readonly teamId: string;
  readonly fetchFn: typeof fetch | undefined;
  readonly onUnread: (count: number) => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const schedules = useMemo(() => createSchedulesApi(teamId, fetchFn), [teamId, fetchFn]);
  const list = useNotificationList(api, schedules, onUnread);
  const { state } = list;
  const open = async (n: KobeNotification, threadId: string) => {
    if (n.readAt === null) await list.markRead([n.notificationId]);
    onOpenThread(threadId);
  };
  return (
    <section id={id} className={styles.notePanel} aria-label="Notifications">
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
              label={scheduleLabel(n.scheduleId, list.known)}
              onOpen={n.threadId === null ? null : () => void open(n, n.threadId as string)}
              onMarkRead={() => void list.markRead([n.notificationId])}
            />
          ))}
        </ul>
      )}
      {state.status === "ready" && state.next !== null && (
        <p>
          <button type="button" onClick={() => void list.loadMore()}>
            Load more
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
  const panelId = useId();
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <div className={styles.bell}>
      <button
        type="button"
        className={styles.bellButton}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon aria-hidden="true" size={18} />
        {unread > 0 && (
          <span className={styles.bellBadge} aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <NotificationPanel
          key={teamId}
          id={panelId}
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
