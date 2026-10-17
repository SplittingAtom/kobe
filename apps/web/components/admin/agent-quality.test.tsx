// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentQuality } from "./team/agent-builder/agent-quality";
import { topReasons } from "./team/agent-builder/quality-tables";
import { forbidNativeConfirm, renderTeam, stubApi, summary, TEAM } from "./testing";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const URL = (w: number) => `/v1/agents/${AGENT}/feedback?window=${w}`;

const base = (w: number) => ({
  agent_id: AGENT,
  from: "2026-09-17T00:00:00Z",
  to: "2026-10-17T00:00:00Z",
  window_days: w,
  bucket: "day",
  min_raters: 5,
});

const notEnough = (w = 30) => ({
  ...base(w),
  totals: { enough: false, up: null, down: null, rate: null },
  versions: null,
  series: null,
});

const reasons = (over: Record<string, number> = {}) => ({
  wrong: 0,
  ignored_instructions: 0,
  unsafe: 0,
  too_slow: 0,
  other: 0,
  ...over,
});

const enough = {
  ...base(30),
  totals: { enough: true, up: 14, down: 6, rate: 0.7 },
  versions: [
    {
      version: 3,
      up: 9,
      down: 3,
      rate: 0.75,
      reasons: reasons({ too_slow: 2, wrong: 3, ignored_instructions: 2 }),
      models: [{ model: "kimi", up: 9, down: 3, rate: 0.75 }],
    },
    { version: 2, up: 5, down: 3, rate: 0.625, reasons: null, models: null },
  ],
  series: [
    { start: "2026-10-15T00:00:00Z", up: 8, down: 2 },
    { start: "2026-10-16T00:00:00Z", up: 6, down: 4 },
  ],
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agent ratings totals (KOBE-275 ac-3)", () => {
  it("shows nothing to those the server refuses, or for a gone agent", async () => {
    for (const status of [403, 404]) {
      const calls = stubApi({ [`GET ${URL(30)}`]: [status, { code: "forbidden", message: "no" }] });
      const { container } = renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("says not enough ratings yet below the minimum, with no numbers", async () => {
    stubApi({ [`GET ${URL(30)}`]: [200, notEnough()] });
    renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
    const section = await screen.findByRole("region", { name: "Ratings" });
    expect(await within(section).findByText(/Not enough ratings yet/)).toBeTruthy();
    expect(section.textContent).toMatch(/at least 5 members other than you/);
    expect(within(section).queryByRole("table")).toBeNull();
    expect(within(section).queryByRole("link")).toBeNull();
  });

  it("shows totals, versions, models and days; withheld breakdowns say so", async () => {
    stubApi({ [`GET ${URL(30)}`]: [200, enough] });
    renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
    const section = await screen.findByRole("region", { name: "Ratings" });
    await within(section).findByText("Thumbs up", { selector: "dt" });
    expect(section.textContent).toMatch(/Thumbs up14Thumbs down6Positive70%/);
    const versions = within(section).getByRole("table", { name: "Ratings by version" });
    const rows = within(versions).getAllByRole("row");
    expect(rows[1]?.textContent).toBe(
      "v39375%Wrong or made up (3), Didn't follow instructions (2), Too slow (2)",
    );
    expect(rows[2]?.textContent).toBe("v25362.5%Not enough ratings to break down");
    const models = within(section).getByRole("table", { name: "Ratings by model" });
    expect(within(models).getAllByRole("row")[1]?.textContent).toBe("v3kimi9375%");
    expect(within(models).getAllByRole("row")[2]?.textContent).toBe(
      "v2Not enough ratings to break down",
    );
    expect(within(section).getByRole("img", { name: /Ratings per day/ })).toBeTruthy();
    const days = within(section).getByRole("table", { name: "Ratings per day (UTC)" });
    expect(within(days).getAllByRole("row")).toHaveLength(3);
    // Counts only: nothing links to a member or a conversation.
    expect(within(section).queryByRole("link")).toBeNull();
  });

  it("hides versions and days when the server withholds them", async () => {
    stubApi({
      [`GET ${URL(30)}`]: [200, { ...enough, versions: null, series: null }],
    });
    renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
    const section = await screen.findByRole("region", { name: "Ratings" });
    expect(
      await within(section).findByText(/Not enough ratings to break down by version/),
    ).toBeTruthy();
    expect(within(section).getByText(/Not enough ratings to break down by day/)).toBeTruthy();
    expect(within(section).queryByRole("table")).toBeNull();
    expect(within(section).queryByRole("img")).toBeNull();
  });

  it("offers only the 7, 30 and 90 day windows and asks for the one picked", async () => {
    const calls = stubApi({
      [`GET ${URL(30)}`]: [200, notEnough()],
      [`GET ${URL(7)}`]: [200, { ...enough, window_days: 7 }],
    });
    renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
    const select = await screen.findByLabelText("Period");
    expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Last 7 days",
      "Last 30 days",
      "Last 90 days",
    ]);
    await userEvent.selectOptions(select, "7");
    expect(await screen.findByText("Thumbs up", { selector: "dt" })).toBeTruthy();
    expect(summary(calls)).toEqual([`GET ${URL(30)}`, `GET ${URL(7)}`]);
  });

  it("never shows the old period's numbers under the new label while it loads", async () => {
    let answer: (r: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const fetch = vi.fn(async (url: string) =>
      url === URL(30) ? new Response(JSON.stringify(enough), { status: 200 }) : delayed,
    );
    vi.stubGlobal("fetch", fetch);
    renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
    const section = await screen.findByRole("region", { name: "Ratings" });
    await within(section).findByText("Thumbs up", { selector: "dt" });
    await userEvent.selectOptions(within(section).getByLabelText("Period"), "90");
    expect(await within(section).findByText("Loading ratings for the last 90 days…")).toBeTruthy();
    expect(within(section).queryByText("Thumbs up", { selector: "dt" })).toBeNull();
    expect(within(section).queryByRole("table")).toBeNull();
    answer(new Response(JSON.stringify(notEnough(90)), { status: 200 }));
    expect(await within(section).findByText(/Not enough ratings yet/)).toBeTruthy();
    expect(within(section).queryByText(/Loading ratings/)).toBeNull();
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([URL(30), URL(90)]);
  });

  it("drops an older period's late answer", async () => {
    let answer30: (r: Response) => void = () => undefined;
    const slow30 = new Promise<Response>((resolve) => {
      answer30 = resolve;
    });
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === URL(30) && first) {
          first = false;
          return new Response(JSON.stringify(notEnough()), { status: 200 });
        }
        if (url === URL(7)) return slow30.then(() => new Response("{}", { status: 500 }));
        return new Response(JSON.stringify({ ...enough, window_days: 90 }), { status: 200 });
      }),
    );
    renderTeam(<AgentQuality teamId={TEAM.id} agentId={AGENT} />);
    const select = await screen.findByLabelText("Period");
    await userEvent.selectOptions(select, "7");
    await userEvent.selectOptions(select, "90");
    expect(await screen.findByText("Thumbs up", { selector: "dt" })).toBeTruthy();
    answer30(new Response(null));
    await new Promise((r) => setTimeout(r, 0));
    // The 7-day request failing late changes nothing: the 90-day numbers stay.
    expect(screen.getByText("Thumbs up", { selector: "dt" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("orders reasons by count, ties in the contract's order", () => {
    expect(topReasons(null)).toBe("Not enough ratings to break down");
    expect(
      topReasons({ wrong: 0, ignored_instructions: 0, unsafe: 0, too_slow: 0, other: 0 }),
    ).toBe("—");
    expect(
      topReasons({ wrong: 1, ignored_instructions: 0, unsafe: 1, too_slow: 4, other: 0 }),
    ).toBe("Too slow (4), Wrong or made up (1), Unsafe (1)");
  });
});
