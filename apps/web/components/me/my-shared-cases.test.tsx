// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi, summary } from "../admin/testing";
import { MySharedCasesPage } from "./my-shared-cases-page";

const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const TEAM_AGENT = "00000000-0000-4000-8000-0000000000a1";
const GONE_AGENT = "00000000-0000-4000-8000-0000000000a9";

const shared = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  agent: { scope: "team", id: TEAM_AGENT, version: 3 },
  status: "open",
  content: {
    prompt: "What is Q3 revenue?",
    answer: "It is 12.",
    earlier: [],
    tool_outputs: [],
    attachments: [],
    reasons: ["wrong"],
    comment: "Wrong number.",
    truncated: false,
  },
  shared_at: "2026-10-15T13:45:00Z",
  ...over,
});

const AGENTS = {
  "GET /v1/agents?scope=team&include_archived=true": [
    200,
    { agents: [{ id: TEAM_AGENT, name: "Ledger Bot" }] },
  ],
  "GET /v1/agents?scope=personal&include_archived=true": [200, { agents: [] }],
} as const;

const TWO = [
  shared(C1),
  shared(C2, { status: "accepted", agent: { scope: "team", id: GONE_AGENT, version: null } }),
];

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("My area, Shared cases (KOBE-276 ac-3)", () => {
  it("lists the member's shared cases, rating cleared or not, with what was shared", async () => {
    stubApi({ ...AGENTS, "GET /v1/eval-cases": [200, { cases: TWO }] });
    renderTeam(<MySharedCasesPage />, MEMBER);
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(await within(items[0] as HTMLElement).findByText("Ledger Bot, v3")).toBeTruthy();
    expect(items[0]?.textContent).toMatch(/Waiting for review/);
    // The day only, as for the owner.
    expect(items[0]?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-15");
    expect(items[0]?.textContent).not.toMatch(/13:45/);
    expect(items[0]?.textContent).toMatch(/PromptWhat is Q3 revenue\?/);
    // An agent the member can't list any more keeps a neutral name.
    expect(within(items[1] as HTMLElement).getByText("A team agent, Unknown version")).toBeTruthy();
    expect(items[1]?.textContent).toMatch(/Accepted/);
  });

  it("withdraws after the console's confirm; Cancel sends nothing", async () => {
    const calls = stubApi({
      ...AGENTS,
      "GET /v1/eval-cases": [
        [200, { cases: TWO }],
        [200, { cases: [TWO[1]] }],
      ],
      [`DELETE /v1/eval-cases/${C1}`]: [204],
    });
    renderTeam(<MySharedCasesPage />, MEMBER);
    const withdraw = await screen.findByRole("button", {
      name: /Withdraw the case shared on .* with Ledger Bot/,
    });

    await userEvent.click(withdraw);
    await answerConfirm("Withdraw this shared case?", "Cancel");
    expect(summary(calls).filter((c) => c.startsWith("DELETE"))).toEqual([]);

    await userEvent.click(withdraw);
    const text = await answerConfirm("Withdraw this shared case?", "Withdraw");
    expect(text).toMatch(/no longer sees it/);
    expect(await screen.findByText("Withdrawn.")).toBeTruthy();
    expect(summary(calls).filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /v1/eval-cases/${C1}`,
    ]);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    // Focus stays on the list: the next case's Withdraw.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/^Withdraw the case shared on/),
    );
  });

  it("a withdrawal under a legal hold looks the same (always 204), and the empty list says so", async () => {
    stubApi({
      ...AGENTS,
      "GET /v1/eval-cases": [
        [200, { cases: [TWO[0]] }],
        [200, { cases: [] }],
      ],
      [`DELETE /v1/eval-cases/${C1}`]: [204],
    });
    renderTeam(<MySharedCasesPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: /Withdraw the case/ }));
    await answerConfirm("Withdraw this shared case?", "Withdraw");
    expect(await screen.findByText("You haven't shared any cases.")).toBeTruthy();
    expect(screen.getByText("Withdrawn.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("my-shared-cases"));
    expect(screen.queryByText(/hold/i)).toBeNull();
  });
});
