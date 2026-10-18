// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { LAST_TEAM_KEY } from "../../lib/teams";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp, pressModShift } from "../chat/testing";

/**
 * KOBE-419: the rail's top line. The team selector (moved from the bar), the Threads and Files
 * panel toggles (the last one on stays on; the choice is saved per member), Team console for team
 * admins (moved from the bar's Administration links), then collapse.
 */
const RAIL_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "rail.module.css"),
  "utf8",
);
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The fake server, answering the console access checks as `teamRole` (and maybe site Owner). */
function withAccess(teamRole: "member" | "team_admin", siteRole: string | null = null) {
  fake.teamRole = teamRole;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const permissions = teamRole === "team_admin" ? ["team.members.manage"] : ["team.read"];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://kobe.test").pathname;
    if (path === "/v1/me") {
      return json({
        user: { id: "u-1", name: "Ada", email: "ada@example.test", twoFactorEnabled: false },
        siteRole,
      });
    }
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

const rail = () => screen.getByRole("complementary", { name: "Workspace" });
const header = () =>
  waitFor(() => must(rail().querySelector<HTMLElement>("[data-rail-header]")), WAIT);
const bar = () => must(document.querySelector<HTMLElement>('[data-bar-row="1"]'));
const toggle = (name: "Threads panel" | "Files panel") =>
  within(rail()).getByRole("button", { name });
const section = (id: string) => must(document.getElementById(id));
const rows = () =>
  must(document.getElementById("kobe-rail-sections")).style.gridTemplateRows.replace(/\s+/g, " ");
const divider = () => screen.queryByRole("separator", { name: "Resize Threads and Files" });
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);
const names = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("a, button, summary, h2")].map(
    (el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
  );

describe("the rail's top line (ac-1)", () => {
  it("team name, Threads panel, Files panel, then collapse, for a member", async () => {
    openApp(fake);
    await composer();
    const line = await header();
    await within(line).findByRole("heading", { name: "Finance", level: 2 });
    expect(names(line)).toEqual(["Finance", "Threads panel", "Files panel", "Collapse the rail"]);
    // The name truncates with its full text as a tooltip, never the buttons.
    expect(within(line).getByRole("heading", { name: "Finance" }).getAttribute("title")).toBe(
      "Finance",
    );
  });

  it("truncates the team name and never wraps or shrinks the buttons (CSS contract)", () => {
    const css = RAIL_CSS;
    const block = (selector: string) =>
      new RegExp(`(^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";
    expect(block(".header")).toContain("flex-wrap: nowrap;");
    expect(block(".teamSlot")).toContain("min-width: 0;");
    for (const d of ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]) {
      expect(block(".team")).toContain(d);
    }
    expect(block(".headerActions")).toContain("flex-shrink: 0;");
    // A multi-team summary at the 200 px minimum (KOBE-419 review S1): the slot clips, the name
    // keeps a usable minimum, and the role yields first (it shrinks first, then hides).
    expect(block(".teamSlot")).toContain("overflow: hidden;");
    expect(block(".teamSlot")).toContain("container-type: inline-size;");
    expect(block(".teamSummary .team")).toMatch(/min-width: \d/);
    const role = block(".teamSummary small");
    for (const d of ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;"]) {
      expect(role).toContain(d);
    }
    expect(role).toMatch(/flex-shrink: [1-9]\d+;/);
    expect(css).toMatch(
      /@container \(width < [\d.]+rem\) \{\s*\.teamSummary small \{\s*display: none;/,
    );
    // A hidden section is really gone: `.section` sets a display of its own.
    expect(css).toMatch(/\.section\[hidden\] \{\s*display: none;/);
  });
});

describe("the team selector (ac-2)", { timeout: 30_000 }, () => {
  it("is in the rail, not the bar; lists the teams with roles; the active one is marked", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "team_admin" });
    openApp(fake);
    await composer();
    const line = await header();
    const teams = await within(line).findByRole("navigation", { name: "Teams" }, WAIT);
    expect(within(bar()).queryByRole("navigation", { name: "Teams" })).toBeNull();
    const summary = must(teams.querySelector("summary"));
    expect(summary.textContent).toContain("Finance");
    expect(summary.textContent).toContain("Member");
    expect(summary.getAttribute("title")).toBe("Finance");
    must(teams.querySelector("details")).open = true;
    const finance = within(teams).getByRole("button", { name: /Finance/ });
    expect(finance.getAttribute("aria-current")).toBe("true");
    expect((finance as HTMLButtonElement).disabled).toBe(true);
    expect(within(teams).getByRole("button", { name: /Operations Team admin/ })).toBeTruthy();
  });

  it("switching sets the active team, remembers it and forgets the last thread", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "member" });
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload,
      href: window.location.href,
      search: window.location.search,
      pathname: window.location.pathname,
    } as Location);
    openApp(fake);
    await composer();
    const teams = await within(await header()).findByRole("navigation", { name: "Teams" }, WAIT);
    must(teams.querySelector("details")).open = true;
    await userEvent.setup().click(within(teams).getByRole("button", { name: /Operations/ }));
    await waitFor(() =>
      expect(
        fake.requests.find((r) => r.method === "PUT" && r.path === "/v1/me/teams/active")?.body,
      ).toEqual({ teamId: "t-2" }),
    );
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(localStorage.getItem(LAST_TEAM_KEY)).toBe("t-2");
  });

  it("a member in one team sees the name without a menu", async () => {
    openApp(fake);
    await composer();
    const line = await header();
    await within(line).findByRole("heading", { name: "Finance" });
    expect(line.querySelector("details")).toBeNull();
  });

  it("under 768 px the bar names the active team beside the drawer button", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    const open = await screen.findByRole("button", { name: "Show the workspace" });
    const name = await within(bar()).findByText("Finance");
    expect(name.getAttribute("title")).toBe("Finance");
    expect(name.closest("[data-rail-drawer-opener]")).toBe(
      open.closest("[data-rail-drawer-opener]"),
    );
    // Wide windows show the rail itself: the bar names no team.
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(within(bar()).queryByText("Finance")).toBeNull());
  });

  it("waits neutrally while a first team is activated, never saying there is none", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "member" });
    fake.activeTeamId = null;
    openApp(fake);
    expect(await screen.findByText("Choosing your team…")).toBeTruthy();
    expect(screen.queryByText(/not in any team/)).toBeNull();
    await composer();
    expect(fake.activeTeamId).toBe(fake.teamId);
    expect(screen.queryByText(/not in any team/)).toBeNull();
  });

  it("the phone bar's team name is capped to fit one row", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    const name = await within(bar()).findByText("Finance");
    expect(name.className).toContain("max-w-[min(9rem,30vw)]");
    expect(name.className).toContain("truncate");
  });

  it("Escape closes the drawer's open team menu, not the drawer", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "member" });
    resizeWindow(390);
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show the workspace" }));
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    const teams = await within(drawer).findByRole("navigation", { name: "Teams" }, WAIT);
    const details = must(teams.querySelector("details"));
    await user.click(must(teams.querySelector("summary")));
    expect(details.open).toBe(true);
    await user.keyboard("{Escape}");
    expect(details.open).toBe(false);
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeTruthy();
  });

  it("under 768 px it heads the drawer, which the bar opens", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "member" });
    resizeWindow(390);
    openApp(fake);
    await composer();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the workspace" }));
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    const line = must(drawer.querySelector<HTMLElement>("[data-rail-header]"));
    expect(await within(line).findByRole("navigation", { name: "Teams" }, WAIT)).toBeTruthy();
    expect(within(bar()).queryByRole("navigation", { name: "Teams" })).toBeNull();
  });
});

describe("the collapsed rail's team (KOBE-419 review S2)", { timeout: 30_000 }, () => {
  it("leads the icon strip with the team's initials; several teams open the same selector", async () => {
    fake.otherTeams.push({ id: "t-2", slug: "ops", name: "Operations", role: "team_admin" });
    fake.preferences = { rail_collapsed: true };
    openApp(fake);
    await composer();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    const team = await within(rail()).findByRole("button", { name: "Team: Finance, Member" }, WAIT);
    expect(team.textContent).toBe("F");
    const buttons = within(rail())
      .getAllByRole("button")
      .filter((b) => b.closest("[hidden]") === null);
    expect(buttons[0]).toBe(team);
    const user = userEvent.setup();
    await user.click(team);
    const list = await screen.findByRole("list", { name: "Your teams" });
    const finance = within(list).getByRole("button", { name: /Finance/ });
    expect((finance as HTMLButtonElement).disabled).toBe(true);
    expect(finance.getAttribute("aria-current")).toBe("true");
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload,
    } as Location);
    await user.click(within(list).getByRole("button", { name: /Operations Team admin/ }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(fake.activeTeamId).toBe("t-2");
  });

  it("one team: its initials with the name and role as the tooltip, no menu", async () => {
    fake.preferences = { rail_collapsed: true };
    openApp(fake);
    await composer();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    const team = await within(rail()).findByRole("img", { name: "Team: Finance, Member" }, WAIT);
    expect(team.textContent).toBe("F");
    expect(within(rail()).queryByRole("button", { name: /^Team:/ })).toBeNull();
  });
});

describe("the Threads and Files toggles (ac-3)", { timeout: 30_000 }, () => {
  it("ignore a stored value this build doesn't know: both panels show", async () => {
    fake.preferences = { rail_panels: "none" };
    openApp(fake);
    await composer();
    await header();
    await new Promise((r) => setTimeout(r, 100));
    expect(section("kobe-rail-threads").hidden).toBe(false);
    expect(section("kobe-rail-files").hidden).toBe(false);
  });

  it("are pressed for both panels by default, with the divider between", async () => {
    openApp(fake);
    await composer();
    await header();
    expect(toggle("Threads panel").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("Files panel").getAttribute("aria-pressed")).toBe("true");
    expect(divider()).not.toBeNull();
    expect(rows()).toBe("minmax(0, 0.6fr) auto minmax(0, 0.4fr)");
  });

  it("one panel fills the rail without the divider; the last one on can't be turned off", async () => {
    openApp(fake);
    await composer();
    await header();
    const user = userEvent.setup();
    await user.click(toggle("Threads panel"));
    expect(toggle("Threads panel").getAttribute("aria-pressed")).toBe("false");
    expect(section("kobe-rail-threads").hidden).toBe(true);
    expect(section("kobe-rail-files").hidden).toBe(false);
    expect(divider()).toBeNull();
    expect(rows()).toBe("minmax(0, 1fr)");
    // Files is the last panel on: its toggle says why it stays.
    const files = toggle("Files panel");
    expect(files.getAttribute("aria-disabled")).toBe("true");
    const why = must(document.getElementById(must(files.getAttribute("aria-describedby"))));
    expect(why.textContent).toBe("At least one panel stays on.");
    await user.click(files);
    expect(files.getAttribute("aria-pressed")).toBe("true");
    expect(section("kobe-rail-files").hidden).toBe(false);
    // Both on again: the divider and the share come back.
    await user.click(toggle("Threads panel"));
    expect(divider()).not.toBeNull();
    expect(rows()).toBe("minmax(0, 0.6fr) auto minmax(0, 0.4fr)");
  });

  it("is saved per member and read back on the next load (another device)", async () => {
    openApp(fake);
    await composer();
    await header();
    await userEvent.setup().click(toggle("Files panel"));
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ rail_panels: "threads" }), WAIT);
    act(() => cleanup());
    openApp(fake);
    await composer();
    await header();
    await waitFor(() => expect(section("kobe-rail-files").hidden).toBe(true));
    expect(toggle("Files panel").getAttribute("aria-pressed")).toBe("false");
    expect(toggle("Threads panel").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("existing paths turn a panel on (ac-4)", { timeout: 30_000 }, () => {
  it("Mod+Shift+F turns Files on, focuses it and saves that like the toggle", async () => {
    fake.preferences = { rail_panels: "threads" };
    openApp(fake);
    await composer();
    await header();
    await waitFor(() => expect(section("kobe-rail-files").hidden).toBe(true));
    act(() => void pressModShift("F"));
    await waitFor(() => expect(section("kobe-rail-files").hidden).toBe(false));
    await waitFor(() => expect(document.activeElement?.id).toBe("kobe-rail-files"));
    expect(toggle("Files panel").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ rail_panels: "both" }), WAIT);
  });

  it("a shown panel is not saved again: Mod+Shift+F with Files on sends nothing", async () => {
    openApp(fake);
    await composer();
    await header();
    act(() => void pressModShift("F"));
    await waitFor(() => expect(document.activeElement?.id).toBe("kobe-rail-files"));
    await new Promise((r) => setTimeout(r, 900));
    expect(puts().filter((r) => "rail_panels" in (r.body as object))).toEqual([]);
  });

  it("the collapsed rail's Show threads expands it with Threads on", async () => {
    fake.preferences = { rail_panels: "files", rail_collapsed: true };
    openApp(fake);
    await composer();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    await userEvent.setup().click(within(rail()).getByRole("button", { name: "Show threads" }));
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
    await waitFor(() => expect(section("kobe-rail-threads").hidden).toBe(false));
    await waitFor(() => expect(document.activeElement?.id).toBe("kobe-rail-threads"));
    // Saved like the toggle: the next load (another device) shows both.
    await waitFor(() => expect(fake.preferences["rail_panels"]).toBe("both"), WAIT);
  });
});

describe("Team console on the rail line (ac-5)", { timeout: 30_000 }, () => {
  it("is there for a team admin, before collapse, and gone from the bar", async () => {
    withAccess("team_admin", "owner");
    openApp(fake);
    await composer();
    const line = await header();
    const link = await within(line).findByRole("link", { name: "Team console" }, WAIT);
    expect(link.getAttribute("href")).toBe("/admin/team");
    expect(names(line).slice(-2)).toEqual(["Team console", "Collapse the rail"]);
    const admin = await within(bar()).findByRole("navigation", { name: "Administration" }, WAIT);
    expect(
      within(admin)
        .getAllByRole("link")
        .map((a) => a.getAttribute("aria-label")),
    ).toEqual(["Site console"]);
  });

  it("is not there for a member", async () => {
    withAccess("member");
    openApp(fake);
    await composer();
    const line = await header();
    await waitFor(() => expect(fake.requests.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(within(line).queryByRole("link", { name: "Team console" })).toBeNull();
  });
});

describe("one look for the rail's icon actions", () => {
  // The shell loads no CSS reset: a button kept the browser's box and a link (Team console,
  // Export my conversations) had none and the link blue. Every icon action carries one look.
  const LOOK = ["border", "bg-background", "text-foreground", "p-0"];

  it("links and buttons on the top line and in the Threads header share the same classes", async () => {
    withAccess("team_admin");
    openApp(fake);
    await composer();
    const line = await header();
    await within(line).findByRole("link", { name: "Team console" }, WAIT);
    const actions = [
      ...line.querySelectorAll<HTMLElement>(
        "a[data-slot='tooltip-trigger'], button[data-slot='tooltip-trigger']",
      ),
      screen.getByRole("link", { name: "Export my conversations" }),
      within(rail()).getByRole("button", { name: "New conversation" }),
    ];
    expect(actions.map((a) => a.tagName)).toEqual(expect.arrayContaining(["A", "BUTTON"]));
    for (const action of actions) {
      for (const cls of LOOK)
        expect(action.classList, `${action.getAttribute("aria-label")}`).toContain(cls);
    }
  });

  it("icon-action links keep the text colour over the chat's unlayered link blue (CSS contract)", () => {
    // `.app a { color: var(--admin-accent) }` is unlayered and beats utilities; the rail's own
    // rule is more specific (KOBE-421: the first fix kept the blue on gate1).
    expect(RAIL_CSS).toMatch(/\.rail a\[data-slot\] \{\s*color: var\(--foreground\);/);
    expect(RAIL_CSS).toMatch(/\.rail a\[data-slot\]:hover \{\s*color: var\(--accent-foreground\);/);
  });

  it("a pressed panel toggle shows the accent", async () => {
    openApp(fake);
    await composer();
    const threads = toggle("Threads panel");
    await waitFor(() => expect(threads.getAttribute("aria-pressed")).toBe("true"));
    expect(threads.className).toMatch(/aria-pressed:bg-accent/);
  });
});
