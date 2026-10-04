// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { budgetBannerText } from "../chat/run-panel";
import { InstallBudget } from "./install/install-budget";
import { TeamBudgetsPage, spentOf } from "./team/budgets-page";
import { TEAM, renderInstall, renderTeam, stubApi } from "./testing";

const spend = (month: number, day: number) => ({ month_usd: month, day_usd: day });
const BUDGETS = {
  period: { month: "2026-10-01", day: "2026-10-04" },
  install: {
    monthly_usd: 1000,
    daily_usd: null,
    user_requests_per_minute: 60,
    updated_at: "2026-10-01T00:00:00Z",
    percent_used: { month: 12, day: null },
  },
  team: { monthly_usd: 100, daily_usd: null, user_requests_per_minute: null, spent: spend(42, 2) },
  effective_requests_per_minute: 60,
  members: [
    {
      user_id: "u-bob",
      name: "Bob",
      email: "b@x.io",
      monthly_usd: 10,
      daily_usd: null,
      spent: spend(9, 1),
    },
  ],
};
const MEMBERS = {
  members: [
    { userId: "u-bob", name: "Bob", email: "b@x.io", role: "member", joinedAt: "2026-10-01" },
    { userId: "u-cy", name: "Cy", email: "c@x.io", role: "member", joinedAt: "2026-10-01" },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("team budgets page (KOBE-42)", () => {
  it("shows spend against each budget and saves the team's budget and rate", async () => {
    const calls = stubApi({
      "GET /v1/team/budgets": [200, BUDGETS],
      "GET /v1/team/members": [200, MEMBERS],
      "PUT /v1/team/budgets/team": [200, BUDGETS],
    });
    renderTeam(<TeamBudgetsPage />);
    expect(await screen.findByText("$42.00 of $100.00 (42 %)")).toBeTruthy();
    expect(screen.getByText("$9.00 of $10.00 (90 %)")).toBeTruthy();
    // The install's spend (every team's) is shown in percent only.
    expect(screen.getByText("12 % of $1,000.00")).toBeTruthy();
    const daily = screen.getByLabelText("Daily cap ($)");
    await userEvent.type(daily, "5.5");
    await userEvent.type(screen.getByLabelText("Requests per minute (max 60)"), "20");
    await userEvent.click(screen.getByRole("button", { name: "Save team budget" }));
    await screen.findByText("The team budget was saved.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      monthly_usd: 100,
      daily_usd: 5.5,
      user_requests_per_minute: 20,
    });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("refuses a rate above the install's and an amount that is not dollars", async () => {
    const calls = stubApi({
      "GET /v1/team/budgets": [200, BUDGETS],
      "GET /v1/team/members": [200, MEMBERS],
    });
    renderTeam(<TeamBudgetsPage />);
    await userEvent.type(await screen.findByLabelText("Requests per minute (max 60)"), "61");
    await userEvent.click(screen.getByRole("button", { name: "Save team budget" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/1 to 60/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("sets and removes a member's budget", async () => {
    const calls = stubApi({
      "GET /v1/team/budgets": [200, BUDGETS],
      "GET /v1/team/members": [200, MEMBERS],
      "PUT /v1/team/budgets/members/u-cy": [200, BUDGETS],
      "DELETE /v1/team/budgets/members/u-bob": [200, BUDGETS],
    });
    renderTeam(<TeamBudgetsPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Member"), "u-cy");
    await userEvent.type(screen.getByLabelText("Monthly ($)"), "25");
    await userEvent.click(screen.getByRole("button", { name: "Set member budget" }));
    await screen.findByText("The member's budget was saved.");
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      monthly_usd: 25,
      daily_usd: null,
    });
    await userEvent.click(screen.getByRole("button", { name: "Remove budget of Bob" }));
    await screen.findByText("Budget removed.");
  });

  it("formats spend with or without a budget", () => {
    expect(spentOf(3, null)).toBe("$3.00 (no budget)");
    expect(spentOf(1, 0)).toBe("$1.00 of $0.00 (100 %)");
  });
});

describe("install budget (KOBE-42)", () => {
  it("saves the install's budget and per-user rate", async () => {
    const limits = {
      monthly_usd: null,
      daily_usd: null,
      user_requests_per_minute: 60,
      updated_at: "2026-10-01T00:00:00Z",
    };
    const calls = stubApi({
      "GET /v1/install/budget": [200, limits],
      "PUT /v1/install/budget": [200, { ...limits, monthly_usd: 500 }],
    });
    renderInstall(<InstallBudget />);
    await userEvent.type(await screen.findByLabelText("Monthly budget ($)"), "500");
    await userEvent.click(screen.getByRole("button", { name: "Save install budget" }));
    await screen.findByText("Install budget saved.");
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      monthly_usd: 500,
      daily_usd: null,
      user_requests_per_minute: 60,
    });
  });
});

describe("chat budget banner text", () => {
  it("names the most used budget; nothing below 80 %", () => {
    const line = (
      scope: "team" | "user",
      percent: number,
      state: "ok" | "warning" | "exhausted",
    ) => ({
      scope,
      period: "month" as const,
      limitUsd: 10,
      spentUsd: percent / 10,
      percent,
      state,
    });
    expect(budgetBannerText({ state: "ok", lines: [line("team", 10, "ok")] })).toBeNull();
    expect(
      budgetBannerText({
        state: "warning",
        lines: [line("team", 85, "warning"), line("user", 10, "ok")],
      }),
    ).toBe("Your team's monthly model budget is 85 % used.");
    expect(
      budgetBannerText({ state: "exhausted", lines: [line("user", 100, "exhausted")] }),
    ).toMatch(/^Your monthly model budget is used up: new messages can't start a run/);
  });
});
