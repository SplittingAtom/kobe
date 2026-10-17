// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AgentBuilderPage } from "./team/agent-builder/agent-builder-page";
import { SharedCasePage } from "./team/eval-cases/shared-case-page";
import { SharedCasesPage } from "./team/eval-cases/shared-cases-page";
import { SharedCasesSummary } from "./team/eval-cases/shared-cases-summary";
import { forbidNativeConfirm, renderTeam, stubApi, summary, TEAM } from "./testing";

const AGENT = "a-1";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const C3 = "00000000-0000-4000-8000-0000000000c3";
const LIST = `/v1/agents/${AGENT}/eval-cases`;

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "open",
  agent_version: 3,
  reasons: ["wrong"],
  prompt_excerpt: "What is <b>Q3</b> revenue?",
  shared_on: "2026-10-15",
  expected_behaviour: null,
  reviewed_at: null,
  ...over,
});

const content = {
  prompt: "What is <b>Q3</b> revenue?",
  answer: "It is 12.",
  earlier: [{ role: "user", text: "Hi" }],
  tool_outputs: [{ tool: "sql", text: "revenue: 14", is_error: false }],
  attachments: [{ name: "q3.csv", mime_type: "text/csv", size_bytes: 2048 }],
  reasons: ["wrong", "too_slow"],
  comment: "Wrong number.",
  truncated: true,
};

const detail = (over: Record<string, unknown> = {}) => ({ ...row(C1, over), content });

const LISTED = {
  agent_id: AGENT,
  accepted: 1,
  max_accepted: 20,
  // The server's order: open first, then accepted, then dismissed; day, then a random id.
  cases: [
    row(C2, { shared_on: "2026-10-15" }),
    row(C1, { shared_on: "2026-10-15", reasons: [] }),
    row(C3, { status: "accepted", shared_on: "2026-10-16", expected_behaviour: "Say 14." }),
  ],
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the owner's shared cases list (KOBE-276 ac-2)", () => {
  it("lists cases in the server's order with the day only, never who shared them", async () => {
    stubApi({ [`GET ${LIST}`]: [200, LISTED] });
    const { container } = renderTeam(<SharedCasesPage scope="team" agentId={AGENT} />);
    const table = await screen.findByRole("table", { name: "Shared cases" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("a")?.getAttribute("href"))).toEqual([
      `/admin/team/agents/${AGENT}/cases/${C2}`,
      `/admin/team/agents/${AGENT}/cases/${C1}`,
      `/admin/team/agents/${AGENT}/cases/${C3}`,
    ]);
    expect(rows[0]?.textContent).toMatch(
      /v3.*Wrong or made up.*What is <b>Q3<\/b> revenue\?.*Waiting for review/,
    );
    expect(rows[1]?.textContent).toMatch(/v3—/);
    expect(rows[2]?.textContent).toMatch(/Accepted/);
    expect(container.querySelector("b")).toBeNull();
    // Day only: a date element with the day, and no time of day anywhere.
    const time = must(rows[0]?.querySelector("time"));
    expect(time.getAttribute("dateTime")).toBe("2026-10-15");
    expect(table.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(screen.getByText("1 of 20 accepted.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/shared by|u-me|Ada/i);
  });

  it("shows an empty state, and the personal agent's links under My agents", async () => {
    stubApi({ [`GET ${LIST}`]: [200, { ...LISTED, accepted: 0, cases: [] }] });
    renderTeam(<SharedCasesPage scope="personal" agentId={AGENT} />);
    expect(await screen.findByText("No shared cases yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the agent" }).getAttribute("href")).toBe(
      `/me/agents/${AGENT}`,
    );
  });

  it("shows the server's refusal to anyone but the owner", async () => {
    stubApi({ [`GET ${LIST}`]: [403, { code: "forbidden", message: "Only the agent's owner." }] });
    renderTeam(<SharedCasesPage scope="team" agentId={AGENT} />);
    expect(await screen.findByText("Only the agent's owner.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("reviewing one shared case (KOBE-276 ac-2)", () => {
  const ONE = `${LIST}/${C1}`;

  it("shows the copy as plain text and accepts only with an expected behaviour", async () => {
    const calls = stubApi({
      [`GET ${ONE}`]: [200, detail()],
      [`PATCH ${ONE}`]: [200, detail({ status: "accepted", expected_behaviour: "Say 14." })],
    });
    const { container } = renderTeam(<SharedCasePage scope="team" agentId={AGENT} caseId={C1} />);
    const shared = await screen.findByRole("region", { name: "What was shared" });
    expect(shared.textContent).toMatch(/Earlier promptHi/);
    expect(shared.textContent).toMatch(/PromptWhat is <b>Q3<\/b> revenue\?/);
    expect(shared.textContent).toMatch(/Tool output: sqlrevenue: 14/);
    expect(shared.textContent).toMatch(/q3\.csv \(text\/csv, 2 KB\)/);
    expect(shared.textContent).toMatch(/Thumbs down: Wrong or made up, Too slow/);
    expect(shared.textContent).toMatch(/CommentWrong number\./);
    expect(screen.getByText(/Some text was cut/)).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(must(container.querySelector("time")).getAttribute("dateTime")).toBe("2026-10-15");

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    const field = screen.getByLabelText("Expected behaviour");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(summary(calls)).toEqual([`GET ${ONE}`]);

    await userEvent.type(field, "  Say 14.  ");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(
      await screen.findByText(/Accepted\. The case runs in the next gated publish/),
    ).toBeTruthy();
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      status: "accepted",
      expected_behaviour: "Say 14.",
    });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("says what to do when the agent has the most accepted cases", async () => {
    stubApi({
      [`GET ${ONE}`]: [200, detail({ expected_behaviour: "Say 14." })],
      [`PATCH ${ONE}`]: [409, { code: "case_limit", message: "limit" }],
    });
    renderTeam(<SharedCasePage scope="team" agentId={AGENT} caseId={C1} />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(
      await screen.findByText(/most accepted cases it can run\. Dismiss one first/),
    ).toBeTruthy();
  });

  it("dismisses, reopens and saves the expected behaviour", async () => {
    const calls = stubApi({
      [`GET ${ONE}`]: [200, detail()],
      [`PATCH ${ONE}`]: [
        [200, detail({ status: "dismissed" })],
        [200, detail({ status: "open" })],
        [200, detail({ expected_behaviour: "Cite the table." })],
      ],
    });
    renderTeam(<SharedCasePage scope="team" agentId={AGENT} caseId={C1} />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText(/Dismissed\. It won't run/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByText("Reopened for review.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Expected behaviour"), "Cite the table.");
    await userEvent.click(screen.getByRole("button", { name: "Save expected behaviour" }));
    expect(await screen.findByText("Expected behaviour saved.")).toBeTruthy();
    expect(calls.slice(1).map((c) => JSON.parse(String(c.body)))).toEqual([
      { status: "dismissed" },
      { status: "open" },
      { expected_behaviour: "Cite the table." },
    ]);
  });
});

describe("shared cases on the agent's page (KOBE-276)", () => {
  it("summarizes for the owner and links to the review page", async () => {
    stubApi({ [`GET ${LIST}`]: [200, LISTED] });
    renderTeam(<SharedCasesSummary teamId={TEAM.id} agentId={AGENT} scope="team" />);
    const section = await screen.findByRole("region", { name: "Shared cases" });
    expect(section.textContent).toMatch(/2 waiting for review\. 1 of 20 accepted\./);
    expect(
      within(section).getByRole("link", { name: "Review shared cases" }).getAttribute("href"),
    ).toBe(`/admin/team/agents/${AGENT}/cases`);
  });

  it("shows no section to a team admin who doesn't own the agent (403)", async () => {
    const calls = stubApi({ [`GET ${LIST}`]: [403, { code: "forbidden", message: "no" }] });
    const { container } = renderTeam(
      <SharedCasesSummary teamId={TEAM.id} agentId={AGENT} scope="team" />,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("the builder shows Ratings and Shared cases only where the server answers", async () => {
    const agent = {
      id: AGENT,
      scope: "team",
      slug: "triage",
      name: "Triage",
      status: "active",
      ownerUserId: "u-me",
      currentVersion: 2,
      revision: 3,
      updatedAt: "2026-10-01T10:00:00Z",
      canEdit: false,
      canPublish: false,
      canExport: false,
      frontmatter: { name: "Triage" },
      prompt: "Be helpful.",
    };
    stubApi({
      [`GET /v1/agents/${AGENT}`]: [200, { agent }],
      [`GET /v1/agents/${AGENT}/feedback?window=30`]: [
        200,
        {
          agent_id: AGENT,
          from: "2026-09-17T00:00:00Z",
          to: "2026-10-17T00:00:00Z",
          window_days: 30,
          bucket: "day",
          min_raters: 5,
          totals: { enough: false, up: null, down: null, rate: null },
          versions: null,
          series: null,
        },
      ],
      [`GET ${LIST}`]: [403, { code: "forbidden", message: "no" }],
    });
    renderTeam(<AgentBuilderPage agentId={AGENT} />);
    expect(await screen.findByRole("region", { name: "Ratings" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("region", { name: "Shared cases" })).toBeNull();
  });
});
