// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallUsagePage } from "./install/usage-page";
import { TeamUsagePage } from "./team/usage-page";
import { TEAM, renderInstall, renderTeam } from "./testing";

const totals = (cost: number, calls: number) => ({
  calls,
  input_tokens: 1_200_000,
  output_tokens: 300_000,
  cache_read_tokens: 50_000,
  cache_write_tokens: 0,
  cost_usd: cost,
  unpriced_calls: 1,
  estimated_calls: 0,
});

const REPORT = {
  range: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z", bucket: "day" },
  totals: totals(4.5, 3),
  series: [{ t: "2026-10-02T00:00:00.000Z", ...totals(4.5, 3) }],
  by_user: [{ user_id: "u-bob", name: "Bob", email: "b@x.io", ...totals(4.5, 3) }],
  by_model: [{ model: "openai/gpt-x", ...totals(4.5, 3) }],
  by_agent: [{ agent_id: null, slug: null, scope: null, ...totals(4.5, 3) }],
};

function stubUsage(body: unknown) {
  const urls: { url: string; team: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/v1/install/budget") {
        const limits = {
          monthly_usd: null,
          daily_usd: null,
          user_requests_per_minute: 60,
          updated_at: "2026-10-01T00:00:00Z",
        };
        return new Response(JSON.stringify(limits), { status: 200 });
      }
      urls.push({ url, team: new Headers(init.headers).get("x-kobe-team") });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usage pages (KOBE-43)", () => {
  it("team: totals, chart and breakdowns for the active team; the range reloads", async () => {
    const urls = stubUsage(REPORT);
    renderTeam(<TeamUsagePage />);
    expect(await screen.findByText("$4.50", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("1.2M", { selector: "span" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Spend per day/ })).toBeTruthy();
    const byUser = screen.getByRole("table", { name: "By user" });
    expect(within(byUser).getByText("Bob")).toBeTruthy();
    expect(screen.getByText(/1 calls used models without a price/)).toBeTruthy();
    expect(urls[0]?.url).toMatch(/^\/v1\/team\/usage\?from=.+&to=.+/);
    expect(urls[0]?.team).toBe(TEAM.id);
    await userEvent.selectOptions(screen.getByLabelText("Time range"), "7d");
    await screen.findByRole("table", { name: "By user" });
    expect(urls).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Chart"), "tokens");
    expect(screen.getByRole("img", { name: /Tokens per day/ })).toBeTruthy();
  });

  it("install: adds the by-team breakdown", async () => {
    stubUsage({
      ...REPORT,
      by_team: [{ team_id: "t-1", slug: "fin", name: "Finance", ...totals(4.5, 3) }],
    });
    renderInstall(<InstallUsagePage />);
    const byTeam = await screen.findByRole("table", { name: "By team" });
    expect(within(byTeam).getByText("Finance")).toBeTruthy();
    // KOBE-42: the install budget form sits on the same page.
    expect(await screen.findByRole("button", { name: "Save install budget" })).toBeTruthy();
  });

  it("an empty range says so instead of drawing a chart", async () => {
    stubUsage({ ...REPORT, totals: { ...totals(0, 0), unpriced_calls: 0 }, series: [] });
    renderTeam(<TeamUsagePage />);
    expect(await screen.findByText("No model calls in this range.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
