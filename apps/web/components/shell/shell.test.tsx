// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { forgetLastThread, lastThreadHref } from "../../lib/shell/last-thread";
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
    const profile = one.getByText("Profile", { selector: "summary *" }).closest("details");
    const menu = within(must(profile));
    expect(menu.getByRole("link", { name: "My skills" }).getAttribute("href")).toBe("/me/skills");
    expect(menu.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/me/projects");
    expect(menu.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("row two: the conversation's agent and model pickers and the Files toggle", async () => {
    fake.runnableAgents.push({ id: "a-1", scope: "team", name: "Ledger Bot", model: null });
    openApp(fake);
    const two = within(row(2));
    expect(screen.getByRole("group", { name: "Conversation context" })).toBe(row(2));
    expect(await two.findByRole("button", { name: "Chat with: No agent" })).toBeTruthy();
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
    await waitFor(() => expect(lastThreadHref()).toBe(`/?thread=${t}`));
    render(<ChatReturnLink>Back to Kobe</ChatReturnLink>);
    expect(screen.getByRole("link", { name: "Back to Kobe" }).getAttribute("href")).toBe(
      `/?thread=${t}`,
    );
  });

  it("returns to a new conversation when no thread was open, and forgets on team switch", async () => {
    const t = fake.addThread("Budget review");
    openApp(fake, t);
    await waitFor(() => expect(lastThreadHref()).toBe(`/?thread=${t}`));
    await userEvent.setup().click(await screen.findByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(lastThreadHref()).toBe("/"));

    sessionStorage.setItem("kobe.lastThreadId", t);
    expect(lastThreadHref()).toBe(`/?thread=${t}`);
    forgetLastThread();
    expect(lastThreadHref()).toBe("/");
  });

  it("ignores a stored value that is not a thread id", () => {
    sessionStorage.setItem("kobe.lastThreadId", "/evil?x=1");
    expect(lastThreadHref()).toBe("/");
  });
});
