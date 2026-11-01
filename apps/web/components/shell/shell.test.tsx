// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { command, commandsIn, type CommandId } from "../../lib/shell/commands";
import { forgetLastThread, lastThreadHref, rememberLastThread } from "../../lib/shell/last-thread";
import { must } from "../../lib/testing/must";
import { composer, openApp, pressModShift } from "../chat/testing";
import { ChatReturnLink } from "./chat-return-link";

/**
 * KOBE-197 (CE3, CE4, CE7): the utility bar (one row since KOBE-418) over the rail · artifact ·
 * conversation grid.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ME = { id: "u-1", name: "Ada", email: "ada@example.test", twoFactorEnabled: false };

/** The fake server, plus the access answers the console links ask for. */
function withAccess(siteRole: string | null, teamRole: string, permissions: string[]) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://kobe.test").pathname;
    if (path === "/v1/me") return json({ user: ME, siteRole });
    if (path === "/v1/team") {
      return json({
        team: { id: fake.teamId, slug: "fin", name: "Finance" },
        role: teamRole,
        permissions,
      });
    }
    return fake.fetch(input, init);
  });
}

const row = (n: 1) => must(document.querySelector<HTMLElement>(`[data-bar-row="${n}"]`));
const region = (name: string) =>
  must(document.querySelector<HTMLElement>(`[data-shell-region="${name}"]`), name);

describe("utility bar", () => {
  it("row one: wordmark, thread search, area links and the profile menu; no team switcher", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "member" });
    openApp(fake);
    await composer();
    const one = within(row(1));
    // The team selector is on the rail's top line (KOBE-419).
    expect(await screen.findByRole("navigation", { name: "Teams" })).toBeTruthy();
    expect(one.queryByRole("navigation", { name: "Teams" })).toBeNull();
    expect(one.getByRole("heading", { level: 1, name: "Kobe" })).toBeTruthy();
    expect(await one.findByRole("search")).toBeTruthy();
    expect(one.getByLabelText("Search conversations")).toBeTruthy();
    const area = within(one.getByRole("navigation", { name: "My area" }));
    expect(
      area.getAllByRole("link").map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]),
    ).toEqual([
      ["My memory", "/me/memory"],
      ["My schedules", "/me/schedules"],
      ["My agents", "/me/agents"],
      ["Skills", "/me/skills"],
    ]);
    const profile = row(1).querySelector('summary[aria-label="Profile"]')?.closest("details");
    const menu = within(must(profile));
    // Skills moved to the bar (KOBE-321).
    expect(menu.queryByRole("link", { name: /skills/i })).toBeNull();
    expect(menu.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/me/projects");
    expect(menu.getByRole("link", { name: "My approvals" }).getAttribute("href")).toBe(
      "/me/approvals",
    );
    expect(menu.getByRole("link", { name: "My shared cases" }).getAttribute("href")).toBe(
      "/me/shared-cases",
    );
    expect(menu.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("has one row: the agent and model pickers are in the composer, not the bar (KOBE-418)", async () => {
    fake.runnableAgents.push({ id: "a-1", scope: "team", name: "Ledger Bot", model: null });
    openApp(fake);
    const toolbar = await waitFor(() =>
      must(document.querySelector<HTMLElement>("[data-composer-toolbar]")),
    );
    expect(
      await within(toolbar).findByRole("button", { name: "Chat with: No agent" }),
    ).toBeTruthy();
    expect(
      await within(toolbar).findByRole("combobox", { name: "Model for this conversation" }),
    ).toBeTruthy();
    const bar = must(row(1).closest("header"));
    expect(bar.querySelectorAll("[data-bar-row]")).toHaveLength(1);
    expect(within(bar).queryByRole("combobox")).toBeNull();
    expect(within(bar).queryByRole("button", { name: /^Chat with:/ })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Files" })).toBeNull();
  });

  it("shows no console link to a member", async () => {
    withAccess(null, "member", ["team.read"]);
    openApp(fake);
    await composer();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(within(row(1)).queryByRole("navigation", { name: "Administration" })).toBeNull();
  });

  it("links the Site console to a site Owner; Team console is on the rail line (KOBE-419)", async () => {
    withAccess("owner", "team_admin", ["team.members.manage"]);
    openApp(fake);
    const admin = within(await within(row(1)).findByRole("navigation", { name: "Administration" }));
    expect(
      admin.getAllByRole("link").map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]),
    ).toEqual([["Site console", "/admin/site"]]);
    const rail = screen.getByRole("complementary", { name: "Workspace" });
    expect(await within(rail).findByRole("link", { name: "Team console" })).toBeTruthy();
  });

  it("renders every bar action through IconAction from the command registry (KOBE-203 ac-2)", async () => {
    withAccess("owner", "team_admin", ["team.members.manage"]);
    fake.runnableAgents.push({ id: "a-1", scope: "team", name: "Ledger Bot", model: null });
    openApp(fake);
    await within(row(1)).findByRole("navigation", { name: "Administration" });
    await composer();
    const bar = [row(1)];
    // Icons, not content: the team switcher, the search and open menus stay text.
    const content = '[aria-label="Teams"], [role="search"], details ul, section';
    const icons = bar
      .flatMap((r) => [...r.querySelectorAll<HTMLElement>("a, button, summary")])
      .filter((el) => el.closest(content) === null || el.hasAttribute("data-command"));
    expect(icons.filter((el) => !el.hasAttribute("data-command"))).toEqual([]);
    const rendered = icons.map((el) => el.getAttribute("data-command"));
    const registered = commandsIn("bar", { consoles: ["team", "site"] }).map((c) => c.id);
    expect([...rendered].sort()).toEqual([...registered].sort());
    for (const el of icons) {
      expect(el.getAttribute("aria-label")).toBe(command(el.dataset.command as CommandId).name);
    }
  });

  it("gives a team admin with no site role no Administration links in the bar", async () => {
    withAccess(null, "team_admin", ["team.members.manage"]);
    openApp(fake);
    const rail = await screen.findByRole("complementary", { name: "Workspace" });
    expect(await within(rail).findByRole("link", { name: "Team console" })).toBeTruthy();
    expect(within(row(1)).queryByRole("navigation", { name: "Administration" })).toBeNull();
  });
});

describe("grid", () => {
  it("lays out rail, artifact column and conversation, the artifact column empty until used", async () => {
    openApp(fake);
    await composer();
    const regions = [...document.querySelectorAll("[data-shell-region]")].map((el) =>
      el.getAttribute("data-shell-region"),
    );
    expect(regions).toEqual(["rail", "artifact", "conversation"]);
    expect(within(region("rail")).getByRole("complementary", { name: "Workspace" })).toBeTruthy();
    expect(region("conversation").querySelector("main#kobe-chat-main")).toBeTruthy();
    // Empty: the conversation takes the remaining width (the column collapses on `:empty`).
    expect(region("artifact").childElementCount).toBe(0);

    // Files live in the rail (KOBE-198): Mod+Shift+F shows them there (the bar's button went in
    // KOBE-418).
    pressModShift("F");
    const files = within(region("rail")).getByRole("region", { name: "Files" });
    await waitFor(() => expect(document.activeElement).toBe(files));
    expect(region("artifact").childElementCount).toBe(0);
  });
});

describe("return to the last thread (CE4)", () => {
  it("remembers the open thread for the full-page routes' way back", async () => {
    const t = fake.addThread("Budget review");
    openApp(fake, t);
    await composer();
    await waitFor(() => expect(lastThreadHref(fake.teamId)).toBe(`/?thread=${t}`));
    cleanup();
    render(<ChatReturnLink>Back to Kobe</ChatReturnLink>);
    const link = screen.getByRole("link", { name: "Back to Kobe" });
    await waitFor(() => expect(link.getAttribute("href")).toBe(`/?thread=${t}`));
  });

  it("returns to a new conversation when no thread was open, and forgets on team switch", async () => {
    const t = fake.addThread("Budget review");
    openApp(fake, t);
    await waitFor(() => expect(lastThreadHref(fake.teamId)).toBe(`/?thread=${t}`));
    await userEvent.setup().click(await screen.findByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(lastThreadHref(fake.teamId)).toBe("/"));

    rememberLastThread(fake.teamId, t);
    expect(lastThreadHref(fake.teamId)).toBe(`/?thread=${t}`);
    forgetLastThread();
    expect(lastThreadHref(fake.teamId)).toBe("/");
  });

  it("never offers a thread of another team than the session's active one", async () => {
    const t = "00000000-0000-4000-8000-0000000000aa";
    rememberLastThread("team-a", t);
    expect(lastThreadHref("team-a")).toBe(`/?thread=${t}`);
    expect(lastThreadHref("team-b")).toBe("/");
    expect(lastThreadHref(null)).toBe("/");
    rememberLastThread(fake.teamId, t);
    render(<ChatReturnLink>Kobe</ChatReturnLink>);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Kobe" }).getAttribute("href")).toBe(`/?thread=${t}`),
    );
    cleanup();
    rememberLastThread("team-a", t); // e.g. another tab switched the session's team since
    render(<ChatReturnLink>Kobe</ChatReturnLink>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("link", { name: "Kobe" }).getAttribute("href")).toBe("/");
  });

  it("ignores a stored value that is not a thread id", () => {
    sessionStorage.setItem("kobe.lastThread", JSON.stringify({ teamId: "team-a", threadId: "/x" }));
    expect(lastThreadHref("team-a")).toBe("/");
    sessionStorage.setItem("kobe.lastThread", "not json");
    expect(lastThreadHref("team-a")).toBe("/");
  });
});

/** Holds each `?q=` search until the test releases it, so replies can arrive out of order. */
function holdSearches(): Map<string, () => void> {
  const held = new Map<string, () => void>();
  const inner = fake.fetch;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://kobe.test");
    const q = url.searchParams.get("q");
    if (url.pathname === "/v1/threads" && q !== null) {
      await new Promise<void>((resolve) => held.set(q, resolve));
    }
    return inner(input, init);
  };
  Object.defineProperty(fake, "fetch", { value: fetchFn });
  return held;
}

const searchBox = () => screen.getByLabelText("Search conversations");
const resultsPanel = () => screen.queryByRole("region", { name: /^Results for/ });

describe("thread search in the bar", () => {
  it("drops a reply that arrives after the panel was closed, or after a newer search", async () => {
    fake.addThread("Quarterly revenue");
    fake.addThread("Hiring plan");
    const held = holdSearches();
    openApp(fake);
    await composer();
    const user = userEvent.setup();

    await user.type(searchBox(), "revenue{Enter}");
    await waitFor(() => expect(held.has("revenue")).toBe(true));
    await user.keyboard("{Escape}");
    expect(resultsPanel()).toBeNull();
    must(held.get("revenue"))();
    await new Promise((r) => setTimeout(r, 20));
    expect(resultsPanel()).toBeNull();

    await user.type(searchBox(), "{Enter}");
    await waitFor(() => expect(held.size).toBe(1)); // "revenue" again replaced the entry
    await user.clear(searchBox());
    await user.type(searchBox(), "hiring{Enter}");
    await waitFor(() => expect(held.has("hiring")).toBe(true));
    const older = must(held.get("revenue"));
    must(held.get("hiring"))();
    const results = within(await screen.findByRole("list", { name: "Search results" }));
    expect(results.getByRole("button", { name: "Hiring plan" })).toBeTruthy();
    older();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("region", { name: "Results for hiring" })).toBeTruthy();
    expect(within(must(resultsPanel())).queryByText("Quarterly revenue")).toBeNull();
  });

  it("closes the results on a click outside, on focus leaving, and when a thread opens", async () => {
    const quarterly = fake.addThread("Quarterly revenue");
    fake.addThread("Hiring plan");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const search = async () => {
      await user.click(searchBox());
      await user.type(searchBox(), "{Enter}");
      await screen.findByRole("list", { name: "Search results" });
    };
    await user.type(searchBox(), "revenue");
    await search();
    await user.click(document.body);
    expect(resultsPanel()).toBeNull();

    await search();
    act(() => screen.getByRole("button", { name: "New conversation" }).focus()); // focus moves on
    expect(resultsPanel()).toBeNull();

    await search();
    fireEvent.click(
      await within(must(resultsPanel())).findByRole("button", { name: "Quarterly revenue" }),
    );
    await waitFor(() => expect(window.location.search).toBe(`?thread=${quarterly}`));
    expect(resultsPanel()).toBeNull();
  });

  it("closes the rail's drawer on narrow screens when a thread opens from the Threads panel", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("max-width"), media: query }) as MediaQueryList,
    );
    const t = fake.addThread("Quarterly revenue");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show the workspace" }));
    const drawer = within(await screen.findByRole("dialog", { name: "Workspace" }));
    // KOBE-453: Threads in the drawer opens the Threads panel; choosing a thread closes both.
    await user.click(drawer.getByRole("button", { name: "Threads panel" }));
    const panel = within(await screen.findByRole("dialog", { name: "Threads" }));
    await user.click(await panel.findByRole("button", { name: "Quarterly revenue" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${t}`));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
  });
});

describe("bar menus", () => {
  const profile = () =>
    must(
      document.querySelector('summary[aria-label="Profile"]')?.closest("details"),
    ) as HTMLDetailsElement;
  /** The rail's team selector (KOBE-538: a popover, not a disclosure). */
  const teamTrigger = async () =>
    within(await screen.findByRole("navigation", { name: "Teams" })).getByRole("button");
  const teamList = () => screen.queryByRole("list", { name: "Your teams" });

  it("closes the profile menu on a click outside and on Escape", async () => {
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    await user.click(must(profile().querySelector("summary")));
    expect(profile().open).toBe(true);
    await user.click(document.body);
    expect(profile().open).toBe(false);

    await user.click(must(profile().querySelector("summary")));
    expect(profile().open).toBe(true);
    await user.keyboard("{Escape}");
    expect(profile().open).toBe(false);
    expect(document.activeElement).toBe(profile().querySelector("summary"));
  });

  it("keeps at most one of the team switcher and the profile menu open", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "member" });
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const trigger = await teamTrigger();
    profile().open = true;
    await user.click(trigger);
    await waitFor(() => expect(profile().open).toBe(false));
    expect(teamList()).not.toBeNull();
    await user.click(must(profile().querySelector("summary")));
    await waitFor(() => expect(teamList()).toBeNull());
    expect(profile().open).toBe(true);
  });
});
