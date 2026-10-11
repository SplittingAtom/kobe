"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import type {
  KobeNotification,
  NotificationPage,
  NotificationsApi,
} from "../../lib/notifications/api";
import { CLIENT_ERROR } from "../admin/use-resource";

export const NOTIFICATION_PAGE = 20;

export type ListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | {
      readonly status: "ready";
      readonly items: readonly KobeNotification[];
      readonly next: string | null;
    };

const markedRead = (n: KobeNotification, at: string): KobeNotification =>
  n.readAt === null ? { ...n, readAt: at } : n;

/** A call that never rejects: a thrown request becomes the client error. */
const settled = <T>(call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> =>
  call().catch(() => ({ ok: false as const, error: CLIENT_ERROR }));

/** Marks already made in this listing, applied to pages that arrive later. */
interface Marks {
  readonly ids: ReadonlySet<string>;
  readonly allAt: string | null;
}

const NO_MARKS: Marks = { ids: new Set(), allAt: null };

function applyMarks(items: readonly KobeNotification[], marks: Marks): KobeNotification[] {
  return items.map((n) => {
    if (marks.allAt !== null) return markedRead(n, marks.allAt);
    return marks.ids.has(n.notificationId) ? markedRead(n, new Date().toISOString()) : n;
  });
}

/**
 * The open notification list: first page (all or unread only), "Load more" by cursor, marking
 * read. Every answer reports the server's unread count through `onUnread` (the badge; must be
 * stable). A listing is one filter and one `refresh` (the bell bumps it on each open): answers
 * for an older listing are dropped, one "Load more" runs at a time, and marks made meanwhile are
 * applied to the pages that arrive later.
 */
export function useNotificationList(
  api: NotificationsApi,
  onUnread: (count: number) => void,
  refresh: number,
) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listing = useRef(0);
  const moreInFlight = useRef(false);
  const marks = useRef<Marks>(NO_MARKS);

  useEffect(() => {
    const current = ++listing.current;
    marks.current = NO_MARKS;
    moreInFlight.current = false;
    setLoadingMore(false);
    setActionError(null);
    setState({ status: "loading" });
    void settled(() => api.list({ unread: unreadOnly, limit: NOTIFICATION_PAGE })).then((res) => {
      if (current !== listing.current) return;
      if (!res.ok) return setState({ status: "error", error: res.error });
      onUnread(res.data.unreadCount);
      setState({ status: "ready", items: res.data.notifications, next: res.data.nextCursor });
    });
  }, [api, unreadOnly, onUnread, refresh]);

  const appendPage = useCallback((cursor: string, page: NotificationPage) => {
    setState((s) => {
      if (s.status !== "ready" || s.next !== cursor) return s;
      const known = new Set(s.items.map((n) => n.notificationId));
      const fresh = page.notifications.filter((n) => !known.has(n.notificationId));
      return {
        status: "ready",
        items: [...s.items, ...applyMarks(fresh, marks.current)],
        next: page.nextCursor,
      };
    });
  }, []);

  const loadMore = useCallback(async () => {
    if (moreInFlight.current || state.status !== "ready" || state.next === null) return;
    const cursor = state.next;
    const current = listing.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    const res = await settled(() =>
      api.list({ unread: unreadOnly, limit: NOTIFICATION_PAGE, cursor }),
    );
    if (current !== listing.current) return;
    moreInFlight.current = false;
    setLoadingMore(false);
    if (!res.ok) return setActionError(res.error);
    setActionError(null);
    appendPage(cursor, res.data);
  }, [api, state, unreadOnly, appendPage]);

  /** Marks `ids` read (all of them when null); true on success. */
  const markRead = useCallback(
    async (ids: readonly string[] | null): Promise<boolean> => {
      const res = await settled(() => (ids === null ? api.markAllRead() : api.markRead(ids)));
      if (!res.ok) {
        setActionError(res.error);
        return false;
      }
      setActionError(null);
      onUnread(res.data.unreadCount);
      const at = new Date().toISOString();
      marks.current =
        ids === null
          ? { ids: marks.current.ids, allAt: at }
          : { ids: new Set([...marks.current.ids, ...ids]), allAt: marks.current.allAt };
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

  return { unreadOnly, setUnreadOnly, state, actionError, loadingMore, loadMore, markRead };
}
