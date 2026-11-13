/**
 * The caller's notifications: scheduled runs, skill, team and memory notices (`/v1/notifications`, KOBE-179; contract KOBE-176).
 * Responses arrive camelized; request bodies use the route's snake_case. Every call sends
 * `X-Kobe-Team`: notifications belong to the active team.
 */
import type { NotificationKind, SchedulePausedBy } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";

export interface KobeNotification {
  readonly notificationId: string;
  readonly kind: NotificationKind;
  /** Null for `skill.member_add.blocked`, which names a catalog skill instead (KOBE-338). */
  readonly scheduleId: string | null;
  /** Null for `schedule.paused` and `skill.member_add.blocked`. */
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly skippedCount?: number | undefined;
  readonly pausedBy?: SchedulePausedBy | undefined;
  readonly skillId?: string | undefined;
  readonly skillName?: string | undefined;
  /** The retired version (`skill.version.*`, KOBE-340). */
  readonly skillSemver?: string | undefined;
  /** `skill.version.site_published`: the Site admin who published it (KOBE-495). */
  readonly actorName?: string | undefined;
  /** `team.site_admin.*`: the member and their team role (KOBE-638 review M1). */
  readonly subjectName?: string | undefined;
  readonly teamRole?: "team_admin" | "contributor" | "member" | undefined;
  /** Memory kinds (KOBE-645): see `memoryNotificationFields` in @kobe/protocol. */
  readonly memoryScope?: "team" | "site" | undefined;
  readonly memoryObjectId?: string | undefined;
  readonly relatedKind?: NotificationKind | undefined;
  readonly itemCount?: number | undefined;
  readonly projectId?: string | undefined;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface NotificationPage {
  readonly notifications: readonly KobeNotification[];
  /** All the caller's unread notifications in the team, not just this page. */
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

export interface MarkReadResult {
  readonly updated: number;
  readonly unreadCount: number;
}

export interface ListOptions {
  readonly unread?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface NotificationsApi {
  list(options?: ListOptions): Promise<ApiResult<NotificationPage>>;
  markRead(ids: readonly string[]): Promise<ApiResult<MarkReadResult>>;
  markAllRead(): Promise<ApiResult<MarkReadResult>>;
}

export function createNotificationsApi(teamId: string, fetchFn?: typeof fetch): NotificationsApi {
  const base = { teamId, fetchFn };
  const read = (json: unknown) =>
    apiRequest<MarkReadResult>("/v1/notifications/read", { ...base, method: "POST", json });
  return {
    list: ({ unread = false, limit, cursor } = {}) => {
      const q = new URLSearchParams({ unread: String(unread) });
      if (limit !== undefined) q.set("limit", String(limit));
      if (cursor) q.set("cursor", cursor);
      return apiRequest(`/v1/notifications?${q.toString()}`, base);
    },
    markRead: (ids) => read({ notification_ids: ids }),
    markAllRead: () => read({ all: true }),
  };
}
