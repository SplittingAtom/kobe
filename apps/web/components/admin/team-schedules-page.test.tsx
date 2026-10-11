// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamSchedulesPage } from "./team/schedules-page";
import { ME, renderTeam, stubApi, summary } from "./testing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ADMIN = {
  role: "team_admin",
  permissions: ["team.schedules.personal", "team.schedules.pause", "team.members.read"],
} as const;
const LIST = "GET /v1/schedules?scope=team";
const MEMBERS = "GET /v1/team/members";
const S1 = "00000000-0000-4000-8000-0000000005c1";
const S2 = "00000000-0000-4000-8000-0000000005c2";

const schedule = (id: string, over: Record<string, unknown> = {}) => ({
  schedule_id: id,
  team_id: "t-1",
  user_id: "u-bob",
  agent_id: "a-1",
  prompt: "Bob's private prompt",
  recurrence: { kind: "daily", at: "07:00" },
  tz: "Europe/Paris",
  active: true,
  notify_email: false,
  next_due_at: "2026-10-12T05:00:00Z",
  last_run_id: null,
  paused_by: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  ...over,
});
const list = (schedules: unknown[]) => ({ schedules, active_count: 0 });
const members = {
  members: [
    {
      userId: ME.id,
      name: ME.name,
      email: ME.email,
      role: "team_admin",
      joinedAt: "2026-10-01T10:00:00Z",
    },
    {
      userId: "u-bob",
      name: "Bob",
      email: "b@x.io",
      role: "member",
      joinedAt: "2026-10-01T10:00:00Z",
    },
  ],
};
const paused = (by: string | null) => ({ active: false, paused_by: by, next_due_at: null });

describe("team schedules page (KOBE-181, ac-1)", () => {
  it("lists the team's schedules by owner, recurrence and status, without their prompts", async () => {
    stubApi({
      [LIST]: [
        200,
        list([
          schedule(S1),
          schedule(S2, {
            user_id: "u-gone",
            ...paused("deactivation"),
            recurrence: { kind: "weekdays", at: "18:00" },
          }),
        ]),
      ],
      [MEMBERS]: [200, members],
    });
    renderTeam(<TeamSchedulesPage />, ADMIN);
    const table = within(await screen.findByRole("table", { name: /Schedules of/ }));
    const rows = table.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("Bob")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Every day at 07:00")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Active")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Former member")).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByText(/Paused: owner deactivated or removed/),
    ).toBeTruthy();
    expect(screen.queryByText(/private prompt/)).toBeNull();
  });

  it("pauses a member's schedule, then resumes it", async () => {
    const calls = stubApi({
      [LIST]: [
        [200, list([schedule(S1)])],
        [200, list([schedule(S1, paused("team_admin"))])],
        [200, list([schedule(S1)])],
      ],
      [MEMBERS]: [200, members],
      [`POST /v1/schedules/${S1}/pause`]: [200, schedule(S1, paused("team_admin"))],
      [`POST /v1/schedules/${S1}/resume`]: [200, schedule(S1)],
    });
    renderTeam(<TeamSchedulesPage />, ADMIN);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Pause Bob's schedule (Every day at 07:00)" }),
    );
    await screen.findByText("Paused by a team admin");
    await user.click(
      await screen.findByRole("button", { name: "Resume Bob's schedule (Every day at 07:00)" }),
    );
    await screen.findByText("Active");
    expect(summary(calls)).toEqual(
      expect.arrayContaining([`POST /v1/schedules/${S1}/pause`, `POST /v1/schedules/${S1}/resume`]),
    );
    expect(await screen.findByText("Schedule resumed.")).toBeTruthy();
  });

  it("shows the server's refusal to resume a deactivated owner's schedule", async () => {
    stubApi({
      [LIST]: [200, list([schedule(S1, paused("team_admin"))])],
      [MEMBERS]: [200, members],
      [`POST /v1/schedules/${S1}/resume`]: [
        409,
        {
          code: "schedule_owner_inactive",
          message: "The schedule's owner is deactivated or no longer in the team.",
        },
      ],
    });
    renderTeam(<TeamSchedulesPage />, ADMIN);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Resume Bob's schedule/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The schedule's owner is deactivated or no longer in the team.",
    );
  });

  it("offers Resume only for schedules a team admin paused", async () => {
    stubApi({
      [LIST]: [200, list([schedule(S1, paused(null)), schedule(S2, paused("deactivation"))])],
      [MEMBERS]: [200, members],
    });
    renderTeam(<TeamSchedulesPage />, ADMIN);
    await screen.findByText("Paused by its owner");
    const resumes = screen.getAllByRole("button", { name: /^Resume/ }) as HTMLButtonElement[];
    expect(resumes.map((b) => b.disabled)).toEqual([true, true]);
    expect(resumes[0]?.title).toBe("Only its owner can resume this schedule.");
  });

  it("says when the team has no schedules", async () => {
    stubApi({ [LIST]: [200, list([])], [MEMBERS]: [200, members] });
    renderTeam(<TeamSchedulesPage />, ADMIN);
    await waitFor(() =>
      expect(screen.getByText(/No one in Finance has a schedule yet/)).toBeTruthy(),
    );
  });
});
