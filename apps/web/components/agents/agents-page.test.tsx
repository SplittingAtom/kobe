// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidNativeConfirm, renderTeam, stubApi, TEAM } from "../admin/testing";
import { AgentsPage } from "./agents-page";
import { entry, page, row } from "./roster-fixtures";

/** Navigates the page's `?tab=` as a link or Back would (Next's search params, not a reload). */
let goTo: (search: string) => void = () => {};

/** The page with Next's search params, as the app router provides them. */
function Page({ search = "" }: { readonly search?: string }) {
  const [current, setCurrent] = useState(search);
  goTo = setCurrent;
  return (
    <SearchParamsContext.Provider value={new URLSearchParams(current)}>
      <AgentsPage />
    </SearchParamsContext.Provider>
  );
}

const ROSTER = (tab: string) => `GET /v1/agents/roster?tab=${tab}`;

const MEMBER = { role: "member", permissions: ["team.agents.use"] } as const;
const BUILDER = { role: "builder", permissions: ["team.agents.use", "team.agents.build"] } as const;
const TEAM_ADMIN = {
  role: "team_admin",
  permissions: [
    "team.agents.use",
    "team.agents.build",
    "team.agents.manage",
    "team.agents.suspend",
  ],
} as const;
const SITE_ADMIN = { ...MEMBER, siteAdmin: true } as const;

beforeEach(() => {
  forbidNativeConfirm();
  localStorage.clear();
  window.history.replaceState(null, "", "/agents");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The labels in the row's ⋯ menu (none when the row offers no action), closing it again. */
async function rowActions(agent: string): Promise<string[]> {
  await screen.findByRole("rowheader", { name: new RegExp(agent) });
  const button = screen.queryByRole("button", { name: `Actions for ${agent}` });
  if (!button) return [];
  await userEvent.click(button);
  const menu = await screen.findByRole("menu");
  const labels = within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return labels;
}

async function rowAction(agent: string, action: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${agent}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: action }));
}

const rowOf = async (agent: string) =>
  must((await screen.findByRole("rowheader", { name: new RegExp(agent) })).closest("tr"));

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing");
  return v;
}

const bodyOf = (calls: ReturnType<typeof stubApi>, method: string, url: string) =>
  JSON.parse(String(must(calls.find((c) => c.method === method && c.url === url)).body));

// The rows each role gets from the server (KOBE-566 `actions`, spec §5).
const OWN_DRAFT = row({
  agentId: "p-1",
  name: "Notes",
  status: "not_published",
  currentVersion: null,
  versionInEffect: null,
  reach: [],
  actions: {
    viewDefinition: true,
    edit: true,
    fork: true,
    assignTeam: "propose",
    assignSite: "propose",
  },
});
const TEAM_OWNED = row({
  agentId: "t-a",
  kind: "team_owned",
  name: "Triage",
  ownerUserId: "u-bob",
  ownerName: "Bob",
  dangerous: true,
});
const LENT = row({
  agentId: "l-1",
  name: "Writer",
  ownerUserId: "u-cy",
  ownerName: "Cy",
  entry: entry({ agentId: "l-1", assignedBy: "u-cy" }),
});
const GALLERY = row({
  agentId: "g-1",
  kind: "gallery",
  name: "Kobe",
  ownerUserId: null,
  ownerName: null,
  actions: { viewDefinition: true, fork: true },
});

describe("Agents page as a member (ac-1)", () => {
  it("shows own agents with Reach, Draft and the propose actions; no team creation", async () => {
    stubApi({
      [ROSTER("personal")]: [200, page("personal", [OWN_DRAFT])],
      [ROSTER("team")]: [200, page("team", [TEAM_OWNED, LENT])],
    });
    renderTeam(<Page />, MEMBER);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    const notes = await rowOf("Notes");
    expect(within(notes).getByText("Private")).toBeTruthy();
    expect(within(notes).getAllByText("Draft")).toHaveLength(2);
    expect(
      within(notes)
        .getByRole("link", { name: /Edit\s+Notes/ })
        .getAttribute("href"),
    ).toBe("/agents/p-1");
    expect(await rowActions("Notes")).toEqual([
      "Propose to Finance",
      "Propose to the site",
      "Fork to Personal",
    ]);
    expect(screen.getByRole("columnheader", { name: "Reach" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New agent" }).getAttribute("href")).toBe(
      "/agents/new",
    );

    await userEvent.click(screen.getByRole("tab", { name: "Team" }));
    const triage = await rowOf("Triage");
    expect(within(triage).getByText("Dangerous")).toBeTruthy();
    expect(within(triage).getByText("Bob (team)")).toBeTruthy();
    expect(within(triage).queryByRole("link")).toBeNull();
    expect(await rowActions("Triage")).toEqual([]);
    expect(within(await rowOf("Writer")).getByText("Cy")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create for the team" })).toBeNull();
    expect(screen.getByRole("link", { name: "New agent" }).getAttribute("href")).toBe(
      "/agents/new",
    );
  });

  it("views and forks a gallery agent from the Site tab", async () => {
    stubApi({ [ROSTER("site")]: [200, page("site", [GALLERY])] });
    renderTeam(<Page search="tab=site" />, MEMBER);
    const kobe = await rowOf("Kobe");
    expect(within(kobe).getByText("Kobe gallery")).toBeTruthy();
    expect(
      within(kobe)
        .getByRole("link", { name: /View\s+Kobe/ })
        .getAttribute("href"),
    ).toBe("/agents/g-1");
    expect(await rowActions("Kobe")).toEqual(["Fork to Personal"]);
  });
});

describe("Agents page as a builder (ac-1)", () => {
  it("assigns directly to the team, edits team-owned agents and keeps Create for the team", async () => {
    stubApi({
      [ROSTER("personal")]: [
        200,
        page("personal", [
          row({ actions: { edit: true, assignTeam: "direct", assignSite: "propose" } }),
        ]),
      ],
      [ROSTER("team")]: [
        200,
        page("team", [
          {
            ...TEAM_OWNED,
            actions: { ...TEAM_OWNED.actions, viewDefinition: true, edit: true, fork: true },
          },
          { ...LENT, actions: { ...LENT.actions, viewDefinition: true, fork: true } },
        ]),
      ],
    });
    renderTeam(<Page />, BUILDER);
    expect(await rowActions("Notes")).toEqual(["Assign to Finance", "Propose to the site"]);
    await userEvent.click(screen.getByRole("tab", { name: "Team" }));
    expect(screen.getByRole("link", { name: "Create for the team" }).getAttribute("href")).toBe(
      "/admin/team/agents/new",
    );
    const triage = await rowOf("Triage");
    expect(
      within(triage)
        .getByRole("link", { name: /Edit\s+Triage/ })
        .getAttribute("href"),
    ).toBe("/admin/team/agents/t-a");
    const writer = await rowOf("Writer");
    expect(
      within(writer)
        .getByRole("link", { name: /View\s+Writer/ })
        .getAttribute("href"),
    ).toBe("/agents/l-1");
    expect(await rowActions("Writer")).toEqual(["Fork to Personal"]);
  });
});

describe("Agents page as a team admin (ac-1)", () => {
  it("offers pin, update, suspend, remove and decisions on the Team tab", async () => {
    const pinned = row({
      ...LENT,
      versionInEffect: 1,
      currentVersion: 3,
      updateAvailable: true,
      entry: entry({ agentId: "l-1", versionRule: "pinned", pinnedVersion: 1 }),
      actions: { pin: true, remove: true, suspendHere: true },
    });
    const proposed = row({
      agentId: "pr-1",
      name: "Planner",
      ownerUserId: "u-dee",
      ownerName: "Dee",
      status: "proposed",
      entry: entry({ agentId: "pr-1", state: "proposed" }),
      actions: { decide: true },
    });
    const suspended = row({
      ...TEAM_OWNED,
      status: "suspended_here",
      actions: { resumeHere: true },
    });
    const gone = row({
      agentId: "u-1",
      name: "Orphan",
      ownerName: "Eve",
      status: "unavailable",
      unavailableReason: "owner_left",
      actions: { remove: true },
    });
    stubApi({
      [ROSTER("team")]: [200, page("team", [pinned, proposed, suspended, gone])],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    const writer = await rowOf("Writer");
    expect(within(writer).getByText("v1")).toBeTruthy();
    expect(within(writer).getByText("Pinned to v1")).toBeTruthy();
    expect(within(writer).getByText("Update available: v3")).toBeTruthy();
    expect(await rowActions("Writer")).toEqual([
      "Update to latest (v3)",
      "Pin a version…",
      "Suspend here",
      "Remove from Finance",
    ]);
    expect(within(await rowOf("Planner")).getByText("Proposed")).toBeTruthy();
    expect(await rowActions("Planner")).toEqual(["Approve", "Decline…"]);
    expect(within(await rowOf("Triage")).getByText("Suspended here")).toBeTruthy();
    expect(await rowActions("Triage")).toEqual(["Resume here"]);
    expect(
      within(await rowOf("Orphan")).getByText("Unavailable: its owner left the team"),
    ).toBeTruthy();
  });
});

describe("Agents page as a site admin (ac-1)", () => {
  it("assigns to the site directly and curates the Site tab", async () => {
    stubApi({
      [ROSTER("personal")]: [
        200,
        page("personal", [
          row({ actions: { edit: true, assignTeam: "propose", assignSite: "direct" } }),
        ]),
      ],
      [ROSTER("site")]: [
        200,
        page("site", [
          { ...GALLERY, actions: { ...GALLERY.actions, edit: true, suspendHere: false } },
          row({
            ...LENT,
            entry: entry({ agentId: "l-1", target: "site", teamId: null }),
            actions: { pin: true, remove: true, suspendSiteWide: true },
          }),
          row({
            agentId: "s-2",
            name: "Scout",
            ownerName: "Fay",
            ownerUserId: "u-fay",
            status: "suspended_site",
            actions: { resumeSiteWide: true },
          }),
        ]),
      ],
    });
    renderTeam(<Page />, SITE_ADMIN);
    expect(await rowActions("Notes")).toEqual(["Propose to Finance", "Assign to the site"]);
    await userEvent.click(screen.getByRole("tab", { name: "Site" }));
    expect(
      within(await rowOf("Kobe"))
        .getByRole("link", { name: /Edit\s+Kobe/ })
        .getAttribute("href"),
    ).toBe("/admin/site/gallery/g-1");
    expect(await rowActions("Writer")).toEqual([
      "Pin a version…",
      "Suspend site-wide",
      "Remove from the site",
    ]);
    expect(within(await rowOf("Scout")).getByText("Suspended site-wide")).toBeTruthy();
    expect(await rowActions("Scout")).toEqual(["Resume site-wide"]);
  });
});

describe("Agents page flows (ac-2)", () => {
  const OWN = row({
    agentId: "p-1",
    reach: [{ target: "team", teamId: "t-2", teamName: "Legal", state: "active", note: null }],
    actions: { edit: true, assignTeam: "direct", assignSite: "propose", withdrawTeam: false },
  });

  it("assigns (201) and proposes (202), says which, and refreshes the tab", async () => {
    const calls = stubApi({
      [ROSTER("personal")]: [200, page("personal", [OWN])],
      "POST /v1/agents/p-1/assignments": [
        [201, { entry: entry({ agentId: "p-1" }) }],
        [
          202,
          { entry: entry({ agentId: "p-1", target: "site", teamId: null, state: "proposed" }) },
        ],
      ],
    });
    renderTeam(<Page />, BUILDER);
    await rowAction("Notes", "Assign to Finance");
    expect(await screen.findByText("Notes is on Finance's roster.")).toBeTruthy();
    expect(bodyOf(calls, "POST", "/v1/agents/p-1/assignments")).toEqual({ target: "team" });
    await rowAction("Notes", "Propose to the site");
    expect(
      await screen.findByText("Proposed Notes to the site: a site admin decides."),
    ).toBeTruthy();
    expect(JSON.parse(String(calls.filter((c) => c.method === "POST")[1]?.body))).toEqual({
      target: "site",
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/v1/agents/roster?tab=personal")).toHaveLength(3),
    );
    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
  });

  it("shows the server's refusal (422 agent_bound_to_team)", async () => {
    stubApi({
      [ROSTER("personal")]: [200, page("personal", [OWN])],
      "POST /v1/agents/p-1/assignments": [
        422,
        {
          code: "agent_bound_to_team",
          message: "This agent is bound to Legal: it can't go there.",
        },
      ],
    });
    renderTeam(<Page />, BUILDER);
    await rowAction("Notes", "Propose to the site");
    expect(
      await screen.findByText("This agent is bound to Legal: it can't go there."),
    ).toBeTruthy();
  });

  it("withdraws from the active team after asking, and from a team the owner left", async () => {
    const withdrawable = row({ ...OWN, actions: { withdrawTeam: true } });
    const calls = stubApi({
      [ROSTER("personal")]: [200, page("personal", [withdrawable])],
      "DELETE /v1/agents/p-1/assignments/team": [200, { entry: entry({ state: "removed" }) }],
      "DELETE /v1/agents/p-1/assignments/team?teamId=t-2": [
        200,
        { entry: entry({ teamId: "t-2", state: "removed" }) },
      ],
    });
    renderTeam(<Page />, MEMBER);
    await rowAction("Notes", "Withdraw from Finance");
    const ask = await screen.findByRole("alertdialog", { name: "Withdraw Notes from Finance?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Withdrew Notes from Finance.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Withdraw\s+Notes \(Team: Legal\)/ }));
    const again = await screen.findByRole("alertdialog", { name: "Withdraw Notes from Legal?" });
    await userEvent.click(within(again).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Withdrew Notes from Legal.")).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(
      "DELETE /v1/agents/p-1/assignments/team?teamId=t-2",
    );
  });

  it("pins a version and updates to latest on the team roster", async () => {
    const pinnable = row({
      ...LENT,
      currentVersion: 3,
      versionInEffect: 1,
      updateAvailable: true,
      entry: entry({ agentId: "l-1", versionRule: "pinned", pinnedVersion: 1 }),
      actions: { pin: true },
    });
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [pinnable])],
      "PUT /v1/team/agent-roster/l-1": [200, { entry: entry({ agentId: "l-1" }) }],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowAction("Writer", "Pin a version…");
    const dialog = await screen.findByRole("dialog", { name: "Version of Writer on Finance" });
    const select = within(dialog).getByLabelText("Version rule") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Latest published version (now v3)",
      "Pin to v3",
      "Pin to v2",
      "Pin to v1",
    ]);
    expect(select.value).toBe("1");
    await userEvent.selectOptions(select, "2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save version rule" }));
    expect(await screen.findByText("Pinned Writer to v2 on Finance.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/team/agent-roster/l-1")).toEqual({
      state: "active",
      versionRule: 2,
    });
    await rowAction("Writer", "Update to latest (v3)");
    expect(
      await screen.findByText("Writer now follows its latest version (v3) on Finance."),
    ).toBeTruthy();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(JSON.parse(String(puts[1]?.body))).toEqual({ state: "active", versionRule: "latest" });
  });

  it("approves and declines with a note on the site roster", async () => {
    const proposed = row({
      ...LENT,
      status: "proposed",
      entry: entry({ agentId: "l-1", target: "site", teamId: null, state: "proposed" }),
      actions: { decide: true },
    });
    const calls = stubApi({
      [ROSTER("site")]: [200, page("site", [proposed])],
      "PUT /v1/site/agent-roster/l-1": [200, { entry: entry({ agentId: "l-1" }) }],
    });
    renderTeam(<Page search="tab=site" />, SITE_ADMIN);
    await rowAction("Writer", "Approve");
    expect(await screen.findByText("Approved Writer for the site.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/site/agent-roster/l-1")).toEqual({ state: "active" });
    await rowAction("Writer", "Decline…");
    const dialog = await screen.findByRole("dialog", { name: "Decline Writer for the site?" });
    await userEvent.type(within(dialog).getByLabelText("Note (optional)"), "Too narrow");
    await userEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Declined Writer for the site.")).toBeTruthy();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(JSON.parse(String(puts[1]?.body))).toEqual({ state: "removed", note: "Too narrow" });
  });

  it("suspends here through the team roster and resumes site-wide through the site roster", async () => {
    const calls = stubApi({
      [ROSTER("site")]: [
        200,
        page("site", [
          { ...GALLERY, actions: { ...GALLERY.actions, suspendHere: true } },
          row({
            agentId: "s-2",
            name: "Scout",
            status: "suspended_site",
            actions: { resumeSiteWide: true },
          }),
        ]),
      ],
      "PUT /v1/team/agent-roster/g-1": [200, { agentId: "g-1", suspendedHere: true }],
      "PUT /v1/site/agent-roster/s-2": [200, { entry: entry({ agentId: "s-2", target: "site" }) }],
    });
    renderTeam(<Page search="tab=site" />, { ...TEAM_ADMIN, siteAdmin: true });
    await rowAction("Kobe", "Suspend here");
    const ask = await screen.findByRole("alertdialog", { name: "Suspend Kobe for Finance?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Suspend" }));
    expect(await screen.findByText("Suspended Kobe for Finance.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/team/agent-roster/g-1")).toEqual({ state: "suspended" });
    await rowAction("Scout", "Resume site-wide");
    expect(await screen.findByText("Resumed Scout for every team.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/site/agent-roster/s-2")).toEqual({ state: "active" });
  });

  it("removes after asking, and forks into Personal and opens the copy", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const calls = stubApi({
      [ROSTER("team")]: [
        200,
        page("team", [
          row({ ...LENT, actions: { remove: true, fork: true, viewDefinition: true } }),
        ]),
      ],
      "PUT /v1/team/agent-roster/l-1": [
        200,
        { entry: entry({ agentId: "l-1", state: "removed" }) },
      ],
      "POST /v1/agents/l-1/fork": [201, { agent: { id: "p-9", name: "Writer" } }],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowAction("Writer", "Remove from Finance");
    const ask = await screen.findByRole("alertdialog", { name: "Remove Writer from Finance?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed Writer from Finance.")).toBeTruthy();
    expect(bodyOf(calls, "PUT", "/v1/team/agent-roster/l-1")).toEqual({ state: "removed" });
    await rowAction("Writer", "Fork to Personal");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/agents/p-9"));
    expect(bodyOf(calls, "POST", "/v1/agents/l-1/fork")).toEqual({ scope: "personal" });
  });

  it("loads the next page by cursor above 200 rows", async () => {
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [LENT], "c-2")],
      "GET /v1/agents/roster?tab=team&cursor=c-2": [200, page("team", [TEAM_OWNED])],
    });
    renderTeam(<Page search="tab=team" />, MEMBER);
    await rowOf("Writer");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await rowOf("Triage")).toBeTruthy();
    expect(await rowOf("Writer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(calls.map((c) => c.url)).toContain("/v1/agents/roster?tab=team&cursor=c-2");
  });

  it("refreshes a row on a later page in place after an action", async () => {
    const later = row({ ...TEAM_OWNED, actions: { suspendHere: true } });
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [LENT], "c-2")],
      "GET /v1/agents/roster?tab=team&cursor=c-2": [
        [200, page("team", [later])],
        [
          200,
          page("team", [
            {
              ...later,
              status: "suspended_here",
              actions: { ...later.actions, suspendHere: false, resumeHere: true },
            },
          ]),
        ],
      ],
      "PUT /v1/team/agent-roster/t-a": [200, { agentId: "t-a", suspendedHere: true }],
    });
    renderTeam(<Page search="tab=team" />, TEAM_ADMIN);
    await rowOf("Writer");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await rowAction("Triage", "Suspend here");
    const ask = await screen.findByRole("alertdialog", { name: "Suspend Triage for Finance?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Suspend" }));
    expect(await within(await rowOf("Triage")).findByText("Suspended here")).toBeTruthy();
    expect(await rowOf("Writer")).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("cursor=c-2"))).toHaveLength(2);
  });
});

describe("Agents page tab memory (ac-3)", () => {
  it("opens the last tab used in this browser and keeps the open tab in the address", async () => {
    localStorage.setItem("kobe.agents.tab", "site");
    const calls = stubApi({
      [ROSTER("site")]: [200, page("site", [GALLERY])],
      [ROSTER("team")]: [200, page("team", [])],
    });
    renderTeam(<Page />, MEMBER);
    expect(screen.getByRole("tab", { name: "Site" }).getAttribute("aria-selected")).toBe("true");
    await rowOf("Kobe");
    await userEvent.click(screen.getByRole("tab", { name: "Team" }));
    expect(await screen.findByText("Nothing is on this team's roster yet.")).toBeTruthy();
    expect(localStorage.getItem("kobe.agents.tab")).toBe("team");
    expect(window.location.search).toBe("?tab=team");
    expect(calls.map((c) => c.url)).not.toContain("/v1/agents/roster?tab=personal");
  });

  it("lets ?tab= win over the remembered tab", async () => {
    localStorage.setItem("kobe.agents.tab", "site");
    stubApi({ [ROSTER("personal")]: [200, page("personal", [])] });
    renderTeam(<Page search="tab=personal" />, MEMBER);
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByText("You have no personal agents yet.")).toBeTruthy();
  });

  it("puts the remembered tab in the address on opening, so a copied link opens it", async () => {
    localStorage.setItem("kobe.agents.tab", "site");
    stubApi({ [ROSTER("site")]: [200, page("site", [])] });
    renderTeam(<Page />, MEMBER);
    await waitFor(() => expect(window.location.search).toBe("?tab=site"));
  });

  it("follows a later link to another tab after a tab was clicked", async () => {
    stubApi({
      [ROSTER("personal")]: [200, page("personal", [])],
      [ROSTER("team")]: [200, page("team", [])],
      [ROSTER("site")]: [200, page("site", [])],
    });
    renderTeam(<Page search="tab=personal" />, MEMBER);
    await userEvent.click(screen.getByRole("tab", { name: "Team" }));
    // Next's router follows the page's replaceState, then a link names Personal again.
    act(() => goTo("tab=team"));
    act(() => goTo("tab=personal"));
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    act(() => goTo("tab=site"));
    expect(screen.getByRole("tab", { name: "Site" }).getAttribute("aria-selected")).toBe("true");
    expect(localStorage.getItem("kobe.agents.tab")).toBe("site");
  });

  it("keeps a tab loaded, with its notice, across a look at another tab", async () => {
    const calls = stubApi({
      [ROSTER("personal")]: [200, page("personal", [row({ actions: { assignTeam: "direct" } })])],
      [ROSTER("team")]: [200, page("team", [])],
      "POST /v1/agents/a-1/assignments": [201, { entry: entry() }],
    });
    renderTeam(<Page />, BUILDER);
    await rowAction("Notes", "Assign to Finance");
    expect(await screen.findByText("Notes is on Finance's roster.")).toBeTruthy();
    const personalReads = () =>
      calls.filter((c) => c.url === "/v1/agents/roster?tab=personal").length;
    await waitFor(() => expect(personalReads()).toBe(2));
    await userEvent.click(screen.getByRole("tab", { name: "Team" }));
    await screen.findByText("Nothing is on this team's roster yet.");
    await userEvent.click(screen.getByRole("tab", { name: "Personal" }));
    expect(screen.getByText("Notes is on Finance's roster.")).toBeTruthy();
    expect(personalReads()).toBe(2);
    expect(calls.filter((c) => c.url === "/v1/agents/roster?tab=team")).toHaveLength(1);
  });
});
