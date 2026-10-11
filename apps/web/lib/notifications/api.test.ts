import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApi } from "../../components/admin/testing";
import { createNotificationsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

const N1 = "00000000-0000-4000-8000-00000000a001";

describe("notifications API client (KOBE-181)", () => {
  it("lists with the unread filter, page size and cursor, camelized, naming the team", async () => {
    const calls = stubApi({
      "GET /v1/notifications?unread=true&limit=20&cursor=abc%2B1": [
        200,
        {
          notifications: [
            {
              notification_id: N1,
              kind: "schedule.run.skipped_actions",
              schedule_id: "s",
              thread_id: "t",
              run_id: "r",
              skipped_count: 2,
              read_at: null,
              created_at: "2026-10-11T08:00:00Z",
            },
          ],
          unread_count: 3,
          next_cursor: "next",
        },
      ],
    });
    const res = await createNotificationsApi("t-1").list({
      unread: true,
      limit: 20,
      cursor: "abc+1",
    });
    expect(res.ok && res.data).toEqual({
      notifications: [
        {
          notificationId: N1,
          kind: "schedule.run.skipped_actions",
          scheduleId: "s",
          threadId: "t",
          runId: "r",
          skippedCount: 2,
          readAt: null,
          createdAt: "2026-10-11T08:00:00Z",
        },
      ],
      unreadCount: 3,
      nextCursor: "next",
    });
    expect(calls[0]?.headers.get("x-kobe-team")).toBe("t-1");
  });

  it("marks some or all read with the contract's bodies", async () => {
    const calls = stubApi({
      "POST /v1/notifications/read": [200, { updated: 1, unread_count: 0 }],
    });
    const api = createNotificationsApi("t-1");
    const one = await api.markRead([N1]);
    await api.markAllRead();
    expect(one.ok && one.data).toEqual({ updated: 1, unreadCount: 0 });
    expect(calls.map((c) => JSON.parse(String(c.body)))).toEqual([
      { notification_ids: [N1] },
      { all: true },
    ]);
  });
});
