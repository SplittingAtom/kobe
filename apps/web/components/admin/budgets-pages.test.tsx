// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import type { BudgetStatusLine } from "../../lib/admin/api/budgets";
import { budgetBannerText } from "../chat/run-panel";
import { InstallBudget } from "./install/install-budget";
import { TeamBudgetsPage, spentOf, tokensOf } from "./team/budgets-page";
import { TEAM, renderInstall, renderTeam, stubApi } from "./testing";

const spend = (month: number, day: number, monthTokens = 0, dayTokens = 0) => ({
  month_usd: month,
  day_usd: day,
  month_tokens: monthTokens,
  day_tokens: dayTokens,
});
const none = { monthly_usd: null, daily_usd: null, monthly_tokens: null, daily_tokens: null };
const BUDGETS = {
  period: { month: "2026-10-01", day: "2026-10-04" },
  install: {
    user_requests_per_minute: 60,
    percent_used: { month_usd: 12, day_usd: null, month_tokens: null, day_tokens: null },
  },
  team: {
    ...none,
    monthly_usd: 100,
    monthly_tokens: 1_000_000,
    user_requests_per_minute: null,
    spent: spend(42, 2, 250_000, 10_000),
    member_default: none,
  },
  effective_requests_per_minute: 60,
  members: [
    {
      ...none,
      user_id: "u-bob",
      name: "Bob",
      email: "b@x.io",
      monthly_usd: 10,
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

const body = (calls: ReturnType<typeof stubApi>, method: string, url?: string) =>
  JSON.parse(
    String(must(calls.find((c) => c.method === method && (!url || c.url === url))).body),
  ) as unknown;

describe("team budgets page (KOBE-42)", () => {
  it("shows dollar and token spend and saves the team's budgets and rate", async () => {
    const calls = stubApi({
      "GET /v1/team/budgets": [200, BUDGETS],
      "GET /v1/team/members": [200, MEMBERS],
      "PUT /v1/team/budgets/team": [200, BUDGETS],
    });
    renderTeam(<TeamBudgetsPage />);
    expect(await screen.findByText(/\$42\.00 of \$100\.00 \(42 %\)/)).toBeTruthy();
    expect(screen.getAllByText(/250k of 1M tokens \(25 %\)/).length).toBeGreaterThan(0);
    // The install budget in percent only.
    expect(screen.getByText(/Dollars: 12 % used/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Team Daily ($)"), "5.5");
    await userEvent.type(screen.getByLabelText("Team Daily (tokens)"), "200,000");
    await userEvent.type(screen.getByLabelText("Requests per minute (max 60)"), "20");
    await userEvent.click(screen.getByRole("button", { name: "Save team budget" }));
    await screen.findByText("The team budget was saved.");
    expect(body(calls, "PUT")).toEqual({
      monthly_usd: 100,
      daily_usd: 5.5,
      monthly_tokens: 1_000_000,
      daily_tokens: 200_000,
      user_requests_per_minute: 20,
    });
    expect(must(calls.find((c) => c.method === "PUT")).headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("saves the default member budget", async () => {
    const calls = stubApi({
      "GET /v1/team/budgets": [200, BUDGETS],
      "GET /v1/team/members": [200, MEMBERS],
      "PUT /v1/team/budgets/team": [200, BUDGETS],
    });
    renderTeam(<TeamBudgetsPage />);
    await userEvent.type(await screen.findByLabelText("Default Daily (tokens)"), "50000");
    await userEvent.click(screen.getByRole("button", { name: "Save default member budget" }));
    await screen.findByText("The default member budget was saved.");
    expect(body(calls, "PUT")).toEqual({
      member_default: { ...none, daily_tokens: 50_000 },
    });
  });

  it("refuses a rate above the install's and amounts that are not numbers", async () => {
    const calls = stubApi({
      "GET /v1/team/budgets": [200, BUDGETS],
      "GET /v1/team/members": [200, MEMBERS],
    });
    renderTeam(<TeamBudgetsPage />);
    await userEvent.type(await screen.findByLabelText("Requests per minute (max 60)"), "61");
    await userEvent.click(screen.getByRole("button", { name: "Save team budget" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/1 to 60/);
    await userEvent.type(screen.getByLabelText("Team Monthly (tokens)"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save team budget" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/whole numbers of tokens/);
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
    await userEvent.type(screen.getByLabelText("Member Monthly ($)"), "25");
    await userEvent.click(screen.getByRole("button", { name: "Set member budget" }));
    await screen.findByText("The member's budget was saved.");
    expect(body(calls, "PUT")).toEqual({ ...none, monthly_usd: 25 });
    await userEvent.click(screen.getByRole("button", { name: "Remove budget of Bob" }));
    await screen.findByText("Budget removed.");
  });

  it("formats spend with or without a budget", () => {
    expect(spentOf(3, null)).toBe("$3.00 (no budget)");
    expect(spentOf(1, 0)).toBe("$1.00 of $0.00 (100 %)");
    expect(tokensOf(1500, null)).toBe("1.5k tokens (no budget)");
  });
});

describe("install budget (KOBE-42)", () => {
  it("saves the install's dollar and token budgets and per-user rate", async () => {
    const limits = { ...none, user_requests_per_minute: 60, updated_at: "2026-10-01T00:00:00Z" };
    const calls = stubApi({
      "GET /v1/install/budget": [200, limits],
      "PUT /v1/install/budget": [200, { ...limits, monthly_usd: 500 }],
    });
    renderInstall(<InstallBudget />);
    await userEvent.type(await screen.findByLabelText("Install Monthly ($)"), "500");
    await userEvent.type(screen.getByLabelText("Install Monthly (tokens)"), "9000000");
    await userEvent.click(screen.getByRole("button", { name: "Save install budget" }));
    await screen.findByText("Install budget saved.");
    expect(body(calls, "PUT")).toEqual({
      ...none,
      monthly_usd: 500,
      monthly_tokens: 9_000_000,
      user_requests_per_minute: 60,
    });
  });
});

describe("chat budget banner text", () => {
  const line = (
    over: Partial<BudgetStatusLine> & Pick<BudgetStatusLine, "scope" | "percent" | "state">,
  ): BudgetStatusLine => ({
    period: "month",
    unit: "usd",
    limit: 10,
    spent: 1,
    ...over,
  });

  it("names the most used budget and its unit; nothing below 80 %", () => {
    expect(
      budgetBannerText({ state: "ok", lines: [line({ scope: "team", percent: 10, state: "ok" })] }),
    ).toBeNull();
    expect(
      budgetBannerText({
        state: "warning",
        lines: [
          line({ scope: "team", percent: 85, state: "warning" }),
          line({ scope: "user", percent: 10, state: "ok" }),
        ],
      }),
    ).toBe("Your team's monthly model budget is 85 % used.");
    expect(
      budgetBannerText({
        state: "exhausted",
        lines: [
          line({ scope: "user", unit: "tokens", period: "day", percent: 100, state: "exhausted" }),
        ],
      }),
    ).toMatch(/^Your daily token budget is used up: new messages can't start a run/);
  });
});
