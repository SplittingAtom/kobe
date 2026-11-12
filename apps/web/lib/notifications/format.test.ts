import { describe, expect, it } from "vitest";
import type { KobeNotification } from "./api";
import { notificationLabel, notificationTitle, scheduleLabel } from "./format";

const base: KobeNotification = {
  notificationId: "n",
  kind: "schedule.run.succeeded",
  scheduleId: "s1",
  threadId: "t",
  runId: "r",
  readAt: null,
  createdAt: "2026-10-11T08:00:00Z",
};

describe("notification words (KOBE-181)", () => {
  it.each([
    ["schedule.run.succeeded", {}, "Scheduled run finished"],
    ["schedule.run.failed", {}, "Scheduled run failed"],
    ["schedule.run.interrupted", {}, "Scheduled run was interrupted"],
    [
      "schedule.run.skipped_actions",
      { skippedCount: 1 },
      "Scheduled run finished; 1 action was skipped",
    ],
    [
      "schedule.run.skipped_actions",
      { skippedCount: 3 },
      "Scheduled run finished; 3 actions were skipped",
    ],
    ["schedule.paused", { pausedBy: "team_admin" }, "Paused by a team admin"],
    ["schedule.paused", { pausedBy: "deactivation" }, "Paused: owner deactivated or removed"],
  ] as const)("%s %o → %s", (kind, extra, words) => {
    expect(notificationTitle({ ...base, kind, ...extra })).toBe(words);
  });

  it("says a Team admin's block removed the member's add (KOBE-338)", () => {
    const blocked = {
      ...base,
      kind: "skill.member_add.blocked",
      scheduleId: null,
      threadId: null,
      runId: null,
      skillId: "k1",
      skillName: "sales-report",
    } as const;
    expect(notificationTitle(blocked)).toBe(
      "A Team admin blocked sales-report in this team; your Add for me was removed",
    );
    expect(notificationLabel(blocked, null)).toBe("Catalog skill sales-report");
    expect(notificationLabel(base, null)).toBe("One of your schedules");
  });

  it("says which Site admin added the user to the team (KOBE-638)", () => {
    const added = {
      ...base,
      kind: "team.member.added",
      scheduleId: null,
      threadId: null,
      runId: null,
      actorName: "Ada Admin",
    } as const;
    expect(notificationTitle(added)).toBe("Ada Admin added you to this team");
    expect(notificationLabel(added, null)).toBe("Team membership");
  });

  it("names a schedule by its recurrence and zone, or says it is gone", () => {
    const known = new Map([
      ["s1", { recurrence: { kind: "daily", at: "09:00" }, tz: "Europe/Berlin" }],
    ] as const);
    expect(scheduleLabel("s1", known)).toBe("Every day at 09:00 (Europe/Berlin)");
    expect(scheduleLabel("s2", known)).toBe("A schedule that no longer exists");
    expect(scheduleLabel("s1", null)).toBe("One of your schedules");
  });
});
