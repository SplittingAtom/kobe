// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { command, commandsIn, type CommandId } from "../../lib/shell/commands";
import { forgetLastThread, lastThreadHref, rememberLastThread } from "../../lib/shell/last-thread";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";
import { ChatReturnLink } from "./chat-return-link";

/** KOBE-197 (CE3, CE4, CE7): the two-row utility bar over the rail · artifact · conversation grid. */
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

const row = (n: 1 | 2) => must(document.querySelector<HTMLElement>(`[data-bar-row="${n}"]`));
const region = (name: string) =>
  must(document.querySelector<HTMLElement>(`[data-shell-region="${name}"]`), name);

describe("utility bar", () => {
  it("row one: team switcher, wordmark, thread search, area links and the profile menu", async () => {
    openApp(fake);
    await composer();
    const one = within(row(1));
    expect(await one.findByRole("navigation", { name: "Teams" })).toBeTruthy();
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
    ]);
    const profile = row(1).querySelector('summary[aria-label="Profile"]')?.closest("details");
    const menu = within(must(profile));
    expect(menu.getByRole("link", { name: "My skills" }).getAttribute("href")).toBe("/me/skills");
    expect(menu.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/me/projects");
    expect(menu.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("row two: the conversation's agent and model pickers and the Files toggle", async () => {
    fake.runnableAgents.push({ id: "a-1", scope: "team", name: "Ledger Bot", model: null });
    openApp(fake);
    const two = within(row(2));
    expect(await two.findByRole("button", { name: "Chat with: No agent" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Conversation context" })).toBe(row(2));
    expect(await two.findByRole("combobox", { name: "Model for this conversation" })).toBeTruthy();
    expect(two.getByRole("button", { name: "Files" })).toBeTruthy();
  });

  it("shows no console link to a member", async () => {
    withAccess(null, "member", ["team.read"]);
    openApp(fake);
    await composer();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(within(row(1)).queryByRole("navigation", { name: "Administration" })).toBeNull();
  });

  it("links the team console to a team admin and the Site console to a site Owner", async () => {
    withAccess("owner", "team_admin", ["team.members.manage"]);
    openApp(fake);
    const admin = within(await within(row(1)).findByRole("navigation", { name: "Administration" }));
    expect(
      admin.getAllByRole("link").map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]),
    ).toEqual([
      ["Team console", "/admin/team"],
      ["Site console", "/admin/site"],
    ]);
  });

  it("renders every bar action through IconAction from the command registry (KOBE-203 ac-2)", async () => {
    withAccess("owner", "team_admin", ["team.members.manage"]);
    fake.runnableAgents.push({ id: "a-1", scope: "team", name: "Ledger Bot", model: null });
    openApp(fake);
    await within(row(1)).findByRole("navigation", { name: "Administration" });
    await within(row(2)).findByRole("button", { name: "Files" });
    const bar = [row(1), row(2)];
    // Icons, not content: the team switcher, the search, open menus and the context row's
    // agent and model names stay text.
    const content =
      '[aria-label="Teams"], [role="search"], details ul, section, [data-bar-row="2"]';
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

  it("links only the team console to a team admin who has no site role", async () => {
    withAccess(null, "team_admin", ["team.members.manage"]);
    openApp(fake);
    const admin = within(await within(row(1)).findByRole("navigation", { name: "Administration" }));
    expect(admin.getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual([
      "Team console",
    ]);
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
    expect(
      within(region("rail")).getByRole("complementary", { name: "Conversations" }),
    ).toBeTruthy();
    expect(region("conversation").querySelector("main#kobe-chat-main")).toBeTruthy();
    // Empty: the conversation takes the remaining width (the column collapses on `:empty`).
    expect(region("artifact").childElementCount).toBe(0);

    await userEvent.setup().click(within(row(2)).getByRole("button", { name: "Files" }));
    expect(
      await within(region("artifact")).findByRole("region", { name: "Workspace files" }),
    ).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "Quarterly revenue", hidden: false })).toBeTruthy(); // the rail
    expect(within(must(resultsPanel())).queryByText("Quarterly revenue")).toBeNull();
  });

  it("closes the results on a click outside, on focus leaving, and when a thread opens", async () => {
    fake.addThread("Quarterly revenue");
    const other = fake.addThread("Hiring plan");
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
    const rail = within(region("rail"));
    fireEvent.click(await rail.findByRole("button", { name: "Hiring plan" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${other}`));
    expect(resultsPanel()).toBeNull();
  });

  it("folds the rail on narrow screens when a search hit opens a thread", async () => {
    const t = fake.addThread("Quarterly revenue");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Show conversations" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.type(searchBox(), "revenue{Enter}");
    const results = within(await screen.findByRole("list", { name: "Search results" }));
    await user.click(results.getByRole("button", { name: "Quarterly revenue" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${t}`));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("bar menus", () => {
  const profile = () =>
    must(
      document.querySelector('summary[aria-label="Profile"]')?.closest("details"),
    ) as HTMLDetailsElement;
  const teams = async () =>
    must(
      (await screen.findByRole("navigation", { name: "Teams" })).querySelector("details"),
    ) as HTMLDetailsElement;

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
    openApp(fake);
    await composer();
    const switcher = await teams();
    profile().open = true;
    switcher.open = true; // e.g. from the keyboard: no click outside involved
    await waitFor(() => expect(profile().open).toBe(false));
    profile().open = true;
    await waitFor(() => expect(switcher.open).toBe(false));
  });
});
