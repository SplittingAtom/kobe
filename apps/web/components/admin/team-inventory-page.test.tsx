// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamInventoryPage } from "./team/inventory-page";
import { forbidNativeConfirm, TEAM, answerConfirm, renderTeam, stubApi, summary } from "./testing";

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SKILLS = "GET /v1/skills?scope=team";
const CONNECTORS = "GET /v1/team/connectors";

/** The inventory page's three lists; `routes` replaces any of them. */
function stubInventory(routes: Parameters<typeof stubApi>[0]) {
  return stubApi({
    [SKILLS]: [200, { skills: [] }],
    [CONNECTORS]: [200, { connectors: [] }],
    ...routes,
  });
}

const item = (over: Record<string, unknown>) => ({
  id: "a-1",
  scope: "team",
  slug: "triage",
  name: "Triage",
  ownerUserId: "u-bob",
  ownerName: "Bob",
  status: "active",
  archivedAt: null,
  currentVersion: 2,
  versionCount: 2,
  runCount: 7,
  lastRunAt: "2026-10-02T10:00:00Z",
  tokens: 1234,
  schedules: [],
  orbitScore: { status: "none", attackSuccessRate: null, at: null },
  canExport: true,
  ...over,
});
const INVENTORY_1 = {
  agents: [item({}), item({ id: "p-1", scope: "personal", slug: "mine", name: "Mine" })],
  nextCursor: "mine:00000000-0000-0000-0000-000000000001",
};
const INVENTORY_2 = {
  agents: [item({ id: "p-2", scope: "personal", slug: "zed", name: "Zed", ownerName: "Zoe" })],
  nextCursor: null,
};

describe("Inventory: agents (KOBE-86, moved here by KOBE-291)", () => {
  it("shows owner, scope, status, versions, usage and placeholders, and pages", async () => {
    const calls = stubInventory({
      "GET /v1/agents/inventory": [200, INVENTORY_1],
      "GET /v1/agents/inventory?cursor=mine%3A00000000-0000-0000-0000-000000000001": [
        200,
        INVENTORY_2,
      ],
    });
    renderTeam(<TeamInventoryPage />);
    const row = (await screen.findByRole("row", { name: /Mine/ })) as HTMLElement;
    expect(row.textContent).toMatch(/Bob/);
    expect(row.textContent).toMatch(/Personal/);
    expect(row.textContent).toMatch(/Active/);
    expect(row.textContent).toMatch(/v2/);
    expect(row.textContent).toMatch(/7/);
    expect(row.textContent).toMatch(/1,234/);
    expect(row.textContent?.match(/—/g)?.length).toBe(2);
    expect(row.textContent).not.toMatch(/\$/);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("row", { name: /Zed/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(summary(calls)).toContain(
      "GET /v1/agents/inventory?cursor=mine%3A00000000-0000-0000-0000-000000000001",
    );
  });

  it("lists each agent's schedules with owner and status (KOBE-180)", async () => {
    const schedule = (over: Record<string, unknown>) => ({
      scheduleId: "s-1",
      ownerUserId: "u-bob",
      ownerName: "Bob",
      status: "active",
      pausedBy: null,
      nextDueAt: "2026-10-12T09:00:00Z",
      ...over,
    });
    stubInventory({
      "GET /v1/agents/inventory": [
        200,
        {
          agents: [
            item({
              schedules: [
                schedule({}),
                schedule({
                  scheduleId: "s-2",
                  ownerName: "Carol",
                  status: "paused",
                  pausedBy: "team_admin",
                }),
                schedule({
                  scheduleId: "s-3",
                  ownerName: "Dan",
                  status: "paused",
                  pausedBy: "deactivation",
                }),
                schedule({ scheduleId: "s-4", ownerName: "Eve", status: "paused" }),
              ],
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderTeam(<TeamInventoryPage />);
    const row = (await screen.findByRole("row", { name: /Carol/ })) as HTMLElement;
    const cells = within(row)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(cells).toEqual([
      "Bob: active",
      "Carol: paused by a team admin",
      "Dan: paused (owner deactivated or removed)",
      "Eve: paused",
    ]);
  });

  it("suspends and reactivates any listed agent, personal ones included", async () => {
    const calls = stubInventory({
      "GET /v1/agents/inventory": [200, { ...INVENTORY_1, nextCursor: null }],
      "PUT /v1/agents/inventory/p-1/status": [
        200,
        { id: "p-1", scope: "personal", status: "suspended" },
      ],
    });
    renderTeam(<TeamInventoryPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Mine" }));
    await answerConfirm("Suspend Mine?", "Suspend Mine");
    await screen.findByText("Mine is suspended.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ status: "suspended" });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
    expect(screen.getByRole("button", { name: "Reactivate Mine" })).toBeTruthy();
  });

  it("offers Export to Orbit only for published agents the caller may export", async () => {
    const calls = stubInventory({
      "GET /v1/agents/inventory": [
        200,
        {
          nextCursor: null,
          agents: [
            item({}),
            item({ id: "d-1", slug: "draft", name: "Draft", currentVersion: null }),
            item({ id: "p-1", scope: "personal", slug: "mine", name: "Mine", canExport: false }),
            item({ id: "o-1", slug: "old", name: "Old", ownerName: "Zoe" }),
          ],
        },
      ],
    });
    const downloads = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
    );
    const api = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "/v1/agents/a-1/versions/2/orbit" ? new Response("name: x\n") : api(url, init),
      ),
    );
    renderTeam(<TeamInventoryPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Export Triage to Orbit" }));
    await waitFor(() => expect(downloads).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Export Draft to Orbit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export Mine to Orbit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export Old to Orbit" })).toBeTruthy();
    expect(summary(calls)).not.toContain("GET /v1/agents/d-1/versions/null/orbit");
  });

  it("shows the server's refusal of a suspension", async () => {
    stubInventory({
      "GET /v1/agents/inventory": [200, { ...INVENTORY_1, nextCursor: null }],
      "PUT /v1/agents/inventory/a-1/status": [
        403,
        { code: "forbidden", message: "Only team admins suspend agents." },
      ],
    });
    renderTeam(<TeamInventoryPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Triage" }));
    await answerConfirm("Suspend Triage?", "Suspend Triage");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only team admins suspend/);
  });
});

describe("Inventory: Orbit scores (KOBE-94)", () => {
  const scored = (id: string, name: string, orbitScore: Record<string, unknown>) =>
    item({ id, slug: id, name, orbitScore });

  it("shows each agent's latest score and status", async () => {
    stubInventory({
      "GET /v1/agents/inventory": [
        200,
        {
          agents: [
            scored("a-ok", "Okay", {
              status: "passed",
              attackSuccessRate: 0.1,
              at: "2026-10-03T10:00:00Z",
            }),
            scored("a-bad", "Bad", {
              status: "blocked",
              attackSuccessRate: 0.6,
              at: "2026-10-03T10:00:00Z",
            }),
            scored("a-err", "Broken", {
              status: "errored",
              attackSuccessRate: null,
              at: "2026-10-03T10:00:00Z",
            }),
            scored("a-run", "Busy", { status: "evaluating", attackSuccessRate: null, at: null }),
            scored("a-none", "Fresh", { status: "none", attackSuccessRate: null, at: null }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderTeam(<TeamInventoryPage />);
    const row = async (name: string) =>
      (await screen.findByRole("rowheader", { name })).closest("tr") as HTMLElement;
    expect((await row("Okay")).textContent).toContain("10% (passed)");
    expect((await row("Bad")).textContent).toContain("60% (blocked)");
    expect((await row("Broken")).textContent).toContain("Errored");
    expect((await row("Busy")).textContent).toContain("Evaluating…");
    expect((await row("Fresh")).textContent).not.toMatch(/passed|blocked|Errored|Evaluating/);
  });
});

describe("Inventory: skills and connectors (KOBE-291)", () => {
  const skill = {
    id: "s-1",
    scope: "team",
    slug: "pdf-tools",
    description: "Reads PDFs",
    latestVersion: 3,
    ownerUserId: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
  };
  const tool = (piName: string, status = "pinned") => ({
    piName,
    name: piName,
    title: null,
    readOnly: true,
    openWorld: false,
    status,
  });
  const connector = (over: Record<string, unknown>) => ({
    id: "c-1",
    name: "Jira",
    authKind: "oauth",
    status: "active",
    iconUrl: null,
    enabled: true,
    exposure: "read_only",
    enabledTools: [],
    tools: [tool("a"), tool("b")],
    ...over,
  });

  it("lists the agents, the team's skills and its enabled connectors, for this team", async () => {
    const calls = stubInventory({
      "GET /v1/agents/inventory": [200, { agents: [item({})], nextCursor: null }],
      [SKILLS]: [200, { skills: [skill] }],
      [CONNECTORS]: [
        200,
        {
          connectors: [
            connector({}),
            connector({
              id: "c-2",
              name: "GitHub",
              status: "disabled",
              exposure: "custom",
              enabledTools: ["a"],
              tools: [tool("a"), tool("b", "drifted"), tool("c")],
            }),
            connector({ id: "c-3", name: "Off", enabled: false, exposure: null }),
          ],
        },
      ],
    });
    renderTeam(<TeamInventoryPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Inventory" })).toBeTruthy();
    const agents = await screen.findByRole("region", { name: "Agents" });
    expect(await within(agents).findByRole("rowheader", { name: "Triage" })).toBeTruthy();

    const skills = screen.getByRole("region", { name: "Skills" });
    const skillRow = (await within(skills).findByRole("rowheader", { name: /pdf-tools/ })).closest(
      "tr",
    ) as HTMLElement;
    expect(skillRow.textContent).toMatch(/Reads PDFs.*v3/);
    expect(
      within(skillRow).getByRole("link", { name: "Open pdf-tools" }).getAttribute("href"),
    ).toBe("/admin/team/skills/s-1");

    const connectors = screen.getByRole("region", { name: "Connectors" });
    const rows = within(connectors).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(must(rows[1]).textContent).toMatch(/Jira.*Active.*Read-only tools.*2 tools/);
    expect(must(rows[2]).textContent).toMatch(
      /GitHub.*Disabled by a site admin.*Chosen tools.*1 tool chosen of 3.*1 awaiting re-approval/,
    );
    expect(connectors.textContent).not.toContain("Off");

    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
    expect(summary(calls).sort()).toEqual(["GET /v1/agents/inventory", SKILLS, CONNECTORS].sort());
  });

  it("says when the team has no skills or connectors, and shows a failed list as an error", async () => {
    stubInventory({
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
      [CONNECTORS]: [200, { connectors: [connector({ enabled: false, exposure: null })] }],
    });
    renderTeam(<TeamInventoryPage />);
    expect(await screen.findByText("The team has no skills yet.")).toBeTruthy();
    expect(await screen.findByText("No connectors are enabled for the team.")).toBeTruthy();
    cleanup();

    stubInventory({
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
      [SKILLS]: [403, { code: "forbidden", message: "You can't see the team's skills." }],
    });
    renderTeam(<TeamInventoryPage />);
    const skills = screen.getByRole("region", { name: "Skills" });
    expect((await within(skills).findByRole("alert")).textContent).toMatch(/can't see/);
    expect(await screen.findByText("No connectors are enabled for the team.")).toBeTruthy();
  });

  it("links to the pages that change each list", async () => {
    stubInventory({ "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }] });
    renderTeam(<TeamInventoryPage />);
    await screen.findByText("No agents yet.");
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Schedules")).toBe("/admin/team/schedules");
    expect(href("Skills")).toBe("/admin/team/skills");
    expect(href("Skill review")).toBe("/admin/team/skill-review");
    expect(href("Connectors")).toBe("/admin/team/connectors");
    await waitFor(() => expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull());
  });
});
