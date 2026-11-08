// @vitest-environment happy-dom
import type { AgentRosterUsage } from "@kobe/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi, summary } from "../admin/testing";
import { entry, page, row } from "./roster-fixtures";
import {
  bodyOf,
  MEMBER,
  Page,
  ROSTER,
  rowAction,
  rowActions,
  rowOf,
  SITE_ADMIN,
  TEAM_ADMIN,
} from "./roster-testing";

/**
 * KOBE-570 (spec agents-roster AR12, §6.4): the Inventory's columns and actions on the Team tab
 * for team admins, the Gallery page's actions on the Site tab for site admins, and the proposals
 * queue (count, filter, approve with an optional pin, decline with a note).
 */

beforeEach(() => {
  forbidNativeConfirm();
  localStorage.clear();
  window.history.replaceState(null, "", "/agents");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USAGE: AgentRosterUsage = {
  runCount: 1234,
  lastRunAt: "2026-11-07T09:00:00Z",
  tokens: 1_200_000,
  schedules: [
    {
      scheduleId: "s-1",
      ownerUserId: "u-ann",
      ownerName: "Ann",
      status: "paused",
      pausedBy: "agent_unavailable",
      nextDueAt: null,
    },
    {
      scheduleId: "s-2",
      ownerUserId: "u-bo",
      ownerName: "Bo",
      status: "paused",
      pausedBy: "team_admin",
      nextDueAt: null,
    },
    {
      scheduleId: "s-3",
      ownerUserId: "u-cy",
      ownerName: "Cy",
      status: "active",
      pausedBy: null,
      nextDueAt: "2026-11-09T09:00:00Z",
    },
  ],
  orbitScore: { status: "passed", attackSuccessRate: 0.04, at: "2026-11-01T10:00:00Z" },
  canExport: true,
};

const TRIAGE = row({
  agentId: "t-a",
  kind: "team_owned",
  name: "Triage",
  ownerUserId: "u-bob",
  ownerName: "Bob",
  usage: USAGE,
  actions: { viewDefinition: true, edit: true, suspendHere: true },
});
const PLANNER = row({
  agentId: "p-9",
  name: "Planner",
  ownerUserId: "u-cy",
  ownerName: "Cy",
  status: "proposed",
  currentVersion: 3,
  versionInEffect: 3,
  entry: entry({ agentId: "p-9", state: "proposed", assignedBy: "u-cy" }),
  usage: { ...USAGE, runCount: 0, lastRunAt: null, tokens: 0, schedules: [], canExport: false },
  actions: { decide: true },
});
const DRAFTER = row({
  ...PLANNER,
  agentId: "p-8",
  name: "Drafter",
  entry: entry({ agentId: "p-8", state: "proposed", assignedBy: "u-cy" }),
});
const ORPHAN = row({
  agentId: "o-1",
  name: "Orphan",
  ownerUserId: "u-gone",
  ownerName: "Gone",
  status: "unavailable",
  unavailableReason: "owner_left",
  entry: entry({ agentId: "o-1", assignedBy: "u-gone" }),
  actions: { remove: true, pin: true },
});

const GALLERY_ROW = row({
  agentId: "g-1",
  kind: "gallery",
  name: "Kobe",
  slug: "kobe",
  ownerUserId: null,
  ownerName: null,
  actions: { viewDefinition: true, edit: true, fork: true },
});
const SITE_PROPOSAL = row({
  ...PLANNER,
  usage: undefined,
  entry: entry({ agentId: "p-9", target: "site", teamId: null, state: "proposed" }),
});

const GALLERY_STATE = {
  key: "kobe",
  generation: 3,
  customized: true,
  customizedAt: "2026-10-30T10:00:00Z",
  customizedBy: "u-me",
  customizedFromGeneration: 2,
  updateAvailable: true,
};
const GALLERY_ADMIN_LIST = [
  200,
  {
    agents: [
      {
        id: "g-1",
        scope: "gallery",
        slug: "kobe",
        name: "Kobe",
        status: "active",
        ownerUserId: null,
        currentVersion: 2,
        revision: 1,
        updatedAt: "2026-11-01T10:00:00Z",
        canEdit: true,
        starters: [],
        gallery: GALLERY_STATE,
      },
    ],
  },
] as const;

describe("Team tab as a team admin: the Inventory's columns and actions (ac-1)", () => {
  it("shows runs, last run, tokens, schedules (with who paused them) and the Orbit score", async () => {
    stubApi({ [ROSTER("team")]: [200, page("team", [TRIAGE])] });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    const triage = await rowOf("Triage");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    for (const column of ["Runs", "Last run", "Tokens", "Schedules", "Orbit score"]) {
      expect(headers).toContain(column);
    }
    expect(within(triage).getByText("1,234")).toBeTruthy();
    expect(within(triage).getByText("1,200,000 tokens")).toBeTruthy();
    expect(within(triage).getByText("Ann: Paused: agent unavailable")).toBeTruthy();
    expect(within(triage).getByText("Bo: paused by a team admin")).toBeTruthy();
    expect(within(triage).getByText("Cy: active")).toBeTruthy();
    expect(within(triage).getByText("4% (passed)")).toBeTruthy();
    expect(await rowActions("Triage")).toEqual(["Export to Orbit", "Suspend here"]);
  });

  it("exports a version to Orbit with the inventory's call", async () => {
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [TRIAGE])],
      "GET /v1/agents/t-a/versions/2/orbit": [403, { code: "forbidden", message: "Not here." }],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowAction("Triage", "Export to Orbit");
    expect(await screen.findByText("Not here.")).toBeTruthy();
    expect(summary(calls)).toContain("GET /v1/agents/t-a/versions/2/orbit");
  });

  it("adopts an Unavailable entry into the team after asking, then refreshes", async () => {
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [ORPHAN])],
      "POST /v1/team/agent-roster/o-1/adopt": [201, { agent: { id: "n-1" } }],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    expect(await rowActions("Orphan")).toEqual([
      "Pin a version…",
      "Adopt into Finance",
      "Remove from Finance",
    ]);
    await rowAction("Orphan", "Adopt into Finance");
    await answerConfirm("Adopt Orphan into Finance?", "Adopt");
    expect(await screen.findByText("Adopted Orphan: Finance now owns a copy.")).toBeTruthy();
    expect(calls.filter((c) => c.url === "/v1/agents/roster?tab=team")).toHaveLength(2);
  });
});

describe("Members see none of the admin columns or actions (ac-1)", () => {
  it("has no inventory columns, proposals filter, adopt or gallery actions", async () => {
    const calls = stubApi({
      [ROSTER("team")]: [
        200,
        page("team", [
          { ...TRIAGE, usage: undefined, actions: { ...TRIAGE.actions, suspendHere: false } },
          {
            ...PLANNER,
            usage: undefined,
            ownerUserId: "u-me",
            actions: { ...PLANNER.actions, decide: false },
          },
        ]),
      ],
      [ROSTER("site")]: [
        200,
        page("site", [{ ...GALLERY_ROW, actions: { ...GALLERY_ROW.actions, edit: false } }]),
      ],
    });
    renderTeam(<Page search="tab=team" />, MEMBER);
    await rowOf("Triage");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).not.toContain("Runs");
    expect(headers).not.toContain("Schedules");
    expect(screen.queryByRole("button", { name: /^Proposed/ })).toBeNull();
    expect(await rowActions("Triage")).toEqual([]);
    await userEvent.click(screen.getByRole("tab", { name: "Site" }));
    expect(await rowActions("Kobe")).toEqual(["Fork to Personal"]);
    expect(screen.queryByText("Customized")).toBeNull();
    expect(summary(calls)).not.toContain("GET /v1/site/gallery/agents");
  });
});

describe("Site tab as a site admin: the Gallery page's actions (ac-1)", () => {
  it("marks Customized, offers Compare and Reset, Edit, Run eval and Export", async () => {
    const calls = stubApi({
      [ROSTER("site")]: [200, page("site", [GALLERY_ROW])],
      "GET /v1/site/gallery/agents": GALLERY_ADMIN_LIST,
      "GET /v1/agents/gallery-scores": [200, { scores: [] }],
      "GET /v1/site/gallery/agents/g-1/compare": [
        200,
        {
          gallery: GALLERY_STATE,
          repository: { frontmatter: {}, prompt: "new", file: "repository file", generation: 3 },
          current: { frontmatter: {}, prompt: "old", file: "current file", version: 2 },
        },
      ],
      "POST /v1/site/gallery/agents/g-1/eval": [202, { message: "Evaluating" }],
    });
    renderTeam(<Page search="tab=site" />, SITE_ADMIN);
    const kobe = await rowOf("Kobe");
    expect(await within(kobe).findByText("Customized")).toBeTruthy();
    expect(
      within(kobe)
        .getByRole("link", { name: /Edit\s+Kobe/ })
        .getAttribute("href"),
    ).toBe("/admin/site/gallery/g-1");
    expect(within(kobe).getByText("Not evaluated")).toBeTruthy();
    expect(screen.getByText(/A newer repository version of Kobe is available/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Compare/ }));
    expect(await screen.findByText("repository file")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Reset to repository/ })).toBeTruthy();

    expect(await rowActions("Kobe")).toEqual(["Run eval", "Export file", "Fork to Personal"]);
    await rowAction("Kobe", "Run eval");
    expect(
      await screen.findByText(
        "Evaluating Kobe in Finance. The score appears here when it finishes.",
      ),
    ).toBeTruthy();
    expect(bodyOf(calls, "POST", "/v1/site/gallery/agents/g-1/eval")).toEqual({ teamId: "t-1" });
  });

  it("resets a customized agent to the repository after asking, then refreshes the tab", async () => {
    const calls = stubApi({
      [ROSTER("site")]: [200, page("site", [GALLERY_ROW])],
      "GET /v1/site/gallery/agents": [
        GALLERY_ADMIN_LIST,
        [
          200,
          {
            agents: [
              {
                ...GALLERY_ADMIN_LIST[1].agents[0],
                gallery: { ...GALLERY_STATE, customized: false, updateAvailable: false },
              },
            ],
          },
        ],
      ],
      "POST /v1/site/gallery/agents/g-1/reset": [200, { agent: { id: "g-1" } }],
    });
    renderTeam(<Page search="tab=site" />, SITE_ADMIN);
    expect(await within(await rowOf("Kobe")).findByText("Customized")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Reset to repository/ }));
    await answerConfirm("Reset Kobe to the repository definition?", "Reset to repository");
    await waitFor(() => expect(screen.queryByText("Customized")).toBeNull());
    expect(summary(calls)).toContain("POST /v1/site/gallery/agents/g-1/reset");
    expect(calls.filter((c) => c.url === "/v1/agents/roster?tab=site")).toHaveLength(2);
  });

  it("downloads the gallery agent's file from Export file", async () => {
    stubApi({
      [ROSTER("site")]: [200, page("site", [GALLERY_ROW])],
      "GET /v1/site/gallery/agents": GALLERY_ADMIN_LIST,
    });
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });
    renderTeam(<Page search="tab=site" />, SITE_ADMIN);
    await within(await rowOf("Kobe")).findByText("Customized");
    await rowAction("Kobe", "Export file");
    await waitFor(() =>
      expect(clicked).toEqual([
        { href: "/v1/site/gallery/agents/g-1/export", download: "kobe.md" },
      ]),
    );
    click.mockRestore();
  });
});

describe("Proposals queue (ac-2)", () => {
  it("counts proposals for team admins and filters the Team tab to them", async () => {
    stubApi({ [ROSTER("team")]: [200, page("team", [TRIAGE, PLANNER, DRAFTER])] });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowOf("Triage");
    const filter = screen.getByRole("button", { name: "Proposed (2)" });
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(filter);
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("rowheader", { name: /Triage/ })).toBeNull();
    expect(screen.getByRole("rowheader", { name: /Planner/ })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: /Drafter/ })).toBeTruthy();
    await userEvent.click(filter);
    expect(await rowOf("Triage")).toBeTruthy();
  });

  it("says when no proposal waits", async () => {
    stubApi({ [ROSTER("team")]: [200, page("team", [TRIAGE])] });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowOf("Triage");
    await userEvent.click(screen.getByRole("button", { name: "Proposed (0)" }));
    expect(await screen.findByText("No proposals are waiting.")).toBeTruthy();
  });

  it("approves with a pinned version, and refreshes in place", async () => {
    const calls = stubApi({
      [ROSTER("team")]: [
        [200, page("team", [PLANNER])],
        [200, page("team", [row({ ...PLANNER, status: "active", actions: { pin: true } })])],
      ],
      "PUT /v1/team/agent-roster/p-9": [200, { entry: entry({ agentId: "p-9" }) }],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    expect(await rowActions("Planner")).toEqual(["Approve…", "Decline…"]);
    await rowAction("Planner", "Approve…");
    const dialog = await screen.findByRole("dialog", { name: "Approve Planner for Finance?" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Version rule"), "Pin to v1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved Planner for Finance, pinned to v1.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/team/agent-roster/p-9")).toEqual({
      state: "active",
      versionRule: 1,
    });
    await waitFor(() => expect(within(screen.getByRole("table")).getByText("Active")).toBeTruthy());
  });

  it("approves following the latest version by default", async () => {
    const calls = stubApi({
      [ROSTER("site")]: [200, page("site", [SITE_PROPOSAL])],
      "PUT /v1/site/agent-roster/p-9": [200, { entry: entry({ agentId: "p-9" }) }],
    });
    renderTeam(<Page search="tab=site" />, SITE_ADMIN);
    expect(await screen.findByRole("button", { name: "Proposed (1)" })).toBeTruthy();
    await rowAction("Planner", "Approve…");
    const dialog = await screen.findByRole("dialog", { name: "Approve Planner for the site?" });
    expect(
      (within(dialog).getByLabelText("Version rule") as HTMLSelectElement).selectedOptions[0]
        ?.textContent,
    ).toBe("Latest published version (now v3)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved Planner for the site.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/site/agent-roster/p-9")).toEqual({ state: "active" });
  });

  it("declines with a note the proposer then reads on their Personal tab", async () => {
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [PLANNER])],
      "PUT /v1/team/agent-roster/p-9": [
        200,
        { entry: entry({ agentId: "p-9", state: "removed" }) },
      ],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowAction("Planner", "Decline…");
    const dialog = await screen.findByRole("dialog", { name: "Decline Planner for Finance?" });
    await userEvent.type(within(dialog).getByLabelText("Note (optional)"), "Overlaps Triage");
    await userEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Declined Planner for Finance.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/team/agent-roster/p-9")).toEqual({
      state: "removed",
      note: "Overlaps Triage",
    });
    cleanup();

    // The proposer's own row (Personal tab) carries the decision and the note.
    stubApi({
      [ROSTER("personal")]: [
        200,
        page("personal", [
          row({
            agentId: "p-9",
            name: "Planner",
            reach: [
              {
                target: "team",
                teamId: "t-1",
                teamName: "Finance",
                state: "removed",
                note: "Overlaps Triage",
              },
            ],
          }),
        ]),
      ],
    });
    renderTeam(<Page search="tab=personal" />, MEMBER);
    expect(
      within(await rowOf("Planner")).getByText("Declined for Team: Finance: Overlaps Triage"),
    ).toBeTruthy();
  });

  it("offers members no queue, even beside their own proposal", async () => {
    stubApi({
      [ROSTER("team")]: [
        200,
        page("team", [
          row({ ...PLANNER, usage: undefined, ownerUserId: "u-me", actions: { decide: false } }),
        ]),
      ],
    });
    renderTeam(<Page search="tab=team" />, MEMBER);
    expect(within(await rowOf("Planner")).getByText("Proposed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Proposed/ })).toBeNull();
  });
});
