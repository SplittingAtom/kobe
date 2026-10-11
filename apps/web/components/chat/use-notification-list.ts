"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { KobeNotification, NotificationsApi } from "../../lib/notifications/api";
import type { ScheduleWhen } from "../../lib/notifications/format";
import type { SchedulesApi } from "../../lib/schedules/api";

export const NOTIFICATION_PAGE = 20;

export type ListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | {
      readonly status: "ready";
      readonly items: readonly KobeNotification[];
      readonly next: string | null;
    };

const clientError: ApiError = {
  status: 0,
  code: "client_error",
  message: "Something went wrong. Try again.",
};

/** The caller's schedules by id (to name them by recurrence); null when they could not load. */
function useKnownSchedules(schedules: SchedulesApi): ReadonlyMap<string, ScheduleWhen> | null {
  const [known, setKnown] = useState<ReadonlyMap<string, ScheduleWhen> | null>(new Map());
  useEffect(() => {
    let current = true;
    schedules.list().then(
      (res) => {
        if (!current) return;
        setKnown(
          res.ok ? new Map(res.data.schedules.map((s) => [s.scheduleId, s] as const)) : null,
        );
      },
      () => current && setKnown(null),
    );
    return () => {
      current = false;
    };
  }, [schedules]);
  return known;
}

const markedRead = (n: KobeNotification, at: string): KobeNotification =>
  n.readAt === null ? { ...n, readAt: at } : n;

/**
 * The open notification list: first page (all or unread only), "Load more" by cursor, marking
 * read. Every change reports the server's unread count through `onUnread` (the badge).
 */
export function useNotificationList(
  api: NotificationsApi,
  schedules: SchedulesApi,
  onUnread: (count: number) => void,
) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const known = useKnownSchedules(schedules);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    api.list({ unread: unreadOnly, limit: NOTIFICATION_PAGE }).then(
      (res) => {
        if (!current) return;
        if (!res.ok) return setState({ status: "error", error: res.error });
        onUnread(res.data.unreadCount);
        setState({ status: "ready", items: res.data.notifications, next: res.data.nextCursor });
      },
      () => current && setState({ status: "error", error: clientError }),
    );
    return () => {
      current = false;
    };
  }, [api, unreadOnly, onUnread]);

  const loadMore = useCallback(async () => {
    if (state.status !== "ready" || state.next === null) return;
    const res = await api.list({
      unread: unreadOnly,
      limit: NOTIFICATION_PAGE,
      cursor: state.next,
    });
    if (!res.ok) return setActionError(res.error);
    setActionError(null);
    setState({
      status: "ready",
      items: [...state.items, ...res.data.notifications],
      next: res.data.nextCursor,
    });
  }, [api, state, unreadOnly]);

  /** Marks `ids` read (all of them when null); true on success. */
  const markRead = useCallback(
    async (ids: readonly string[] | null): Promise<boolean> => {
      const res = await (ids === null ? api.markAllRead() : api.markRead(ids)).catch(() => null);
      if (!res?.ok) {
        setActionError(res ? res.error : clientError);
        return false;
      }
      setActionError(null);
      onUnread(res.data.unreadCount);
      const at = new Date().toISOString();
      setState((s) =>
        s.status !== "ready"
          ? s
          : {
              ...s,
              items: s.items.map((n) =>
                ids === null || ids.includes(n.notificationId) ? markedRead(n, at) : n,
              ),
            },
      );
      return true;
    },
    [api, onUnread],
  );

  return { unreadOnly, setUnreadOnly, state, known, actionError, loadMore, markRead };
}
