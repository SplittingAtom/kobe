// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { forbidNativeConfirm, answerConfirm, renderTeam, stubApi } from "../admin/testing";
import { MySchedulesPage } from "./my-schedules-page";

const MEMBER = { role: "member", permissions: ["team.chat", "team.schedules.personal"] } as const;
const S1 = "00000000-0000-4000-8000-0000000005c1";
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const LIST = "/v1/schedules?scope=mine";
const AGENTS = "/v1/agents/runnable?limit=200";

const schedule = (over: Record<string, unknown> = {}) => ({
  schedule_id: S1,
  team_id: "t-1",
  user_id: "u-me",
  agent_id: AGENT,
  prompt: "Summarise <b>sales</b>",
  recurrence: { kind: "daily", at: "08:30" },
  tz: "Europe/Paris",
  active: true,
  notify_email: false,
  next_due_at: "2026-10-11T06:30:00Z",
  last_run_id: null,
  paused_by: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  ...over,
});
const list = (schedules: unknown[], active = schedules.length) => ({
  schedules,
  active_count: active,
});
const agents = [
  200,
  { agents: [{ id: AGENT, scope: "team", name: "Analyst", model: null }] },
] as const;

// The console asks in its own dialog (useConfirm); the native one must never be used.
beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Schedules page (KOBE-175)", () => {
  it("lists schedules as plain text with the recurrence and the zone (ac-1)", async () => {
    stubApi({ [`GET ${LIST}`]: [200, list([schedule()])], [`GET ${AGENTS}`]: agents });
    const { container } = renderTeam(<MySchedulesPage />, MEMBER);
    await screen.findByText("Summarise <b>sales</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Every day at 08:30")).toBeTruthy();
    expect(screen.getByText("Analyst")).toBeTruthy();
    expect(screen.getAllByText(/Europe\/Paris/).length).toBeGreaterThan(0);
  });

  it("empty state links to agents (ac-2)", async () => {
    stubApi({ [`GET ${LIST}`]: [200, list([])], [`GET ${AGENTS}`]: agents });
    renderTeam(<MySchedulesPage />, MEMBER);
    await screen.findByText(/No schedules yet/);
    const link = screen.getByRole("link", { name: /agents/i });
    expect(link.getAttribute("href")).toBe("/me/agents");
  });

  it("creates a weekly schedule with the browser zone by default (ac-1)", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Tokyo",
    } as Intl.ResolvedDateTimeFormatOptions);
    const calls = stubApi({
      [`GET ${LIST}`]: [200, list([])],
      [`GET ${AGENTS}`]: agents,
      "POST /v1/schedules": [201, schedule()],
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("Asia/Tokyo");
    await user.selectOptions(await screen.findByLabelText("Agent"), "Analyst");
    await user.type(screen.getByLabelText("Prompt"), "Weekly report");
    await user.selectOptions(screen.getByLabelText("Repeats"), "weekly");
    await user.click(screen.getByRole("checkbox", { name: "Mon" }));
    await user.click(screen.getByRole("checkbox", { name: "Thu" }));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      agent_id: AGENT,
      prompt: "Weekly report",
      recurrence: { kind: "weekly", days: ["mon", "thu"], at: "09:00" },
      tz: "Asia/Tokyo",
      notify_email: false,
    });
    vi.restoreAllMocks();
  });

  it("emails run results only when asked: off by default, on with the toggle (KOBE-181)", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: [200, list([])],
      [`GET ${AGENTS}`]: agents,
      "POST /v1/schedules": [201, schedule({ notify_email: true })],
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    const toggle = screen.getByRole("checkbox", { name: /Email me when a run ends/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.selectOptions(await screen.findByLabelText("Agent"), "Analyst");
    await user.type(screen.getByLabelText("Prompt"), "Report");
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toMatchObject({ notify_email: true });
  });

  it("offers weekdays and cron presets", async () => {
    stubApi({ [`GET ${LIST}`]: [200, list([])], [`GET ${AGENTS}`]: agents });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    const repeats = screen.getByLabelText("Repeats");
    expect(
      within(repeats)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual(["daily", "weekdays", "weekly", "cron"]);
    await user.selectOptions(repeats, "cron");
    expect(screen.getByLabelText("Cron expression")).toBeTruthy();
  });

  it("edits a schedule with PATCH (ac-1)", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: [200, list([schedule({ notify_email: true })])],
      [`GET ${AGENTS}`]: agents,
      [`PATCH /v1/schedules/${S1}`]: [200, schedule({ prompt: "New prompt" })],
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit schedule Summarise <b>sales</b>" }),
    );
    const prompt = screen.getByLabelText("Prompt");
    await user.clear(prompt);
    await user.type(prompt, "New prompt");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect(JSON.parse(String(patch.body))).toMatchObject({
      prompt: "New prompt",
      recurrence: { kind: "daily", at: "08:30" },
      tz: "Europe/Paris",
      notify_email: true,
    });
  });

  it("pauses, resumes and deletes (ac-1)", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: [
        [200, list([schedule()])],
        [200, list([schedule({ active: false, next_due_at: null })], 0)],
        [200, list([schedule()])],
        [200, list([], 0)],
      ],
      [`GET ${AGENTS}`]: agents,
      [`POST /v1/schedules/${S1}/pause`]: [200, schedule({ active: false, next_due_at: null })],
      [`POST /v1/schedules/${S1}/resume`]: [200, schedule()],
      [`DELETE /v1/schedules/${S1}`]: [204],
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Pause schedule Summarise <b>sales</b>" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Resume schedule Summarise <b>sales</b>" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Delete schedule Summarise <b>sales</b>" }),
    );
    await answerConfirm("Delete this schedule?", "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Delete schedule Summarise <b>sales</b>" }),
    );
    expect(await answerConfirm("Delete this schedule?", "Delete schedule")).toMatch(
      /already started stay/,
    );
    await screen.findByText(/No schedules yet/);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(
      expect.arrayContaining([
        `POST /v1/schedules/${S1}/pause`,
        `POST /v1/schedules/${S1}/resume`,
        `DELETE /v1/schedules/${S1}`,
      ]),
    );
  });

  it("shows an admin pause and disables resume for the owner (ac-1)", async () => {
    stubApi({
      [`GET ${LIST}`]: [
        200,
        list([schedule({ active: false, paused_by: "team_admin", next_due_at: null })], 0),
      ],
      [`GET ${AGENTS}`]: agents,
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    await screen.findByText(/Paused by a team admin/);
    const resume = screen.getByRole("button", { name: "Resume schedule Summarise <b>sales</b>" });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's cap-reached message (ac-2)", async () => {
    stubApi({
      [`GET ${LIST}`]: [200, list([schedule({ active: false, paused_by: null })], 10)],
      [`GET ${AGENTS}`]: agents,
      [`POST /v1/schedules/${S1}/resume`]: [
        409,
        {
          code: "schedule_cap_reached",
          message: "You have 10 active schedules, the limit.",
          active_count: 10,
          limit: 10,
        },
      ],
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Resume schedule Summarise <b>sales</b>" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You have 10 active schedules, the limit.",
    );
  });

  it("shows validation errors from the server on save (ac-2)", async () => {
    stubApi({
      [`GET ${LIST}`]: [200, list([])],
      [`GET ${AGENTS}`]: agents,
      "POST /v1/schedules": [
        422,
        { code: "invalid_recurrence", message: "Cron runs more often than every 15 minutes." },
      ],
    });
    renderTeam(<MySchedulesPage />, MEMBER);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    await user.selectOptions(await screen.findByLabelText("Agent"), "Analyst");
    await user.type(screen.getByLabelText("Prompt"), "Go");
    await user.selectOptions(screen.getByLabelText("Repeats"), "cron");
    await user.type(screen.getByLabelText("Cron expression"), "* * * * *");
    await user.click(screen.getByRole("button", { name: "Save schedule" }));
    expect((await screen.findByRole("alert")).textContent).toContain("every 15 minutes");
  });
});
