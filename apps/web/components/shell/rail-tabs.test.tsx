// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { composer, openApp, pressModShift } from "../chat/testing";

/**
 * KOBE-448: the rail is one section with the tabs Files | Apps (Threads is a panel since
 * KOBE-453). The tab is remembered per member, Files the first time; without apps (and no key to
 * add) there is no tablist and the section is Files alone.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
const APP = {
  appId: "a".repeat(64),
  connectorId: "11111111-1111-4111-8111-111111111111",
  connectorName: "Catalyst",
  iconUrl: null,
  tool: "open_lakehouse_explorer",
  title: "Lakehouse Explorer",
  uri: "ui://catalyst/lakehouse-explorer",
  sha256: "e".repeat(64),
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rail = () => screen.getByRole("complementary", { name: "Workspace" });
const tablist = () => screen.findByRole("tablist", { name: "Files and apps" }, WAIT);
const tab = (name: "Files" | "Apps") => within(rail()).getByRole("tab", { name });
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);

async function withApps() {
  fake.teamApps = [APP];
  openApp(fake);
  await composer();
  return tablist();
}

describe("Files | Apps (ac-1, ac-3)", () => {
  it("starts on Files; Apps shows the apps; each tab keeps its state", async () => {
    await withApps();
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(tab("Apps").getAttribute("aria-selected")).toBe("false");
    const files = screen.getByRole("tabpanel", { name: "Files" });
    expect(files.hidden).toBe(false);
    const user = userEvent.setup();
    // Files' own state: listed because its tab is on screen (KOBE-461).
    await within(files).findByRole("button", { name: "Refresh files" }, WAIT);
    expect(within(files).queryByRole("button", { name: "Open files" })).toBeNull();
    await user.click(tab("Apps"));
    const apps = screen.getByRole("tabpanel", { name: "Apps" });
    expect(apps.hidden).toBe(false);
    expect(files.hidden).toBe(true);
    expect(within(apps).getByRole("button", { name: /^Open Lakehouse Explorer/ })).toBeTruthy();
    await user.click(tab("Files"));
    // Kept mounted: still listed.
    expect(within(files).getByRole("button", { name: "Refresh files" })).toBeTruthy();
  });

  it("lists nothing on a load on Apps; the Files tab lists the first time, then reuses it (KOBE-461 ac-2)", async () => {
    fake.preferences = { rail_tab: "apps" };
    const wakes = () =>
      fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/workspace/wake").length;
    const listings = () => fake.workspaceListings.length;
    await withApps();
    await waitFor(() => expect(tab("Apps").getAttribute("aria-selected")).toBe("true"));
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(0);
    expect(listings()).toBe(0);
    const user = userEvent.setup();
    await user.click(tab("Files"));
    await waitFor(() => expect(wakes()).toBe(1), WAIT);
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    await user.click(tab("Apps"));
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    await user.click(tab("Files"));
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    expect(listings()).toBe(1);
    // Mod+Shift+F still lists again.
    act(() => void pressModShift("F"));
    await waitFor(() => expect(wakes()).toBe(2), WAIT);
  });

  it("remembers the member's tab across loads (another device too)", async () => {
    await withApps();
    await userEvent.setup().click(tab("Apps"));
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ rail_tab: "apps" }), WAIT);
    act(() => cleanup());
    openApp(fake);
    await composer();
    await tablist();
    await waitFor(() => expect(tab("Apps").getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tabpanel", { name: "Apps" }).hidden).toBe(false);
  });

  it("marks the rail settled once the stored tab is applied, not before (KOBE-415)", async () => {
    fake.preferences = { rail_tab: "apps" };
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const plain = fake.fetch;
    const holding: typeof fetch = async (input, init) => {
      if (String(input).endsWith(PREFERENCES_PATH)) await held;
      return plain(input, init);
    };
    Object.defineProperty(fake, "fetch", { value: holding });
    await withApps();
    // The apps are listed, the preferences not yet: Files for now, and not settled.
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(rail().hasAttribute("data-settled")).toBe(false);
    release();
    await waitFor(() => expect(rail().hasAttribute("data-settled")).toBe(true), WAIT);
    expect(tab("Apps").getAttribute("aria-selected")).toBe("true");
  });

  it("moves between the tabs with the arrow keys, Home and End; one tab stop", async () => {
    await withApps();
    const files = tab("Files");
    expect(files.tabIndex).toBe(0);
    expect(tab("Apps").tabIndex).toBe(-1);
    expect(files.getAttribute("aria-controls")).toBe("kobe-rail-files");
    files.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("Apps"));
    expect(tab("Apps").getAttribute("aria-selected")).toBe("true");
    expect(tab("Apps").tabIndex).toBe(0);
    await user.keyboard("{ArrowRight}"); // wraps
    expect(document.activeElement).toBe(tab("Files"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tab("Apps"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tab("Files"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tab("Apps"));
  });

  it("Mod+Shift+F goes to the Files tab", async () => {
    fake.preferences = { rail_tab: "apps" };
    await withApps();
    await waitFor(() => expect(tab("Apps").getAttribute("aria-selected")).toBe("true"));
    act(() => void pressModShift("F"));
    await waitFor(() => expect(tab("Files").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.activeElement?.id).toBe("kobe-rail-files"));
  });

  it("the toggle on the top line says Files and apps, and hiding it hides both", async () => {
    await withApps();
    const toggle = within(rail()).getByRole("button", { name: "Files and apps" });
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    expect(screen.queryByRole("tabpanel", { name: "Apps" })).toBeNull();
  });
});

describe("no apps (ac-2)", () => {
  it("no Apps tab and no tablist: the section is Files, whatever tab was stored", async () => {
    fake.preferences = { rail_tab: "apps" };
    openApp(fake);
    await composer();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Apps" })).toBeNull();
    expect(within(rail()).getByRole("region", { name: "Files" }).hidden).toBe(false);
  });

  it("a key to add is enough for the Apps tab", async () => {
    fake.teamAppsNeedKey = [
      { connectorId: APP.connectorId, connectorName: "Catalyst", title: "Lakehouse Explorer" },
    ];
    openApp(fake);
    await composer();
    await tablist();
    fireEvent.click(tab("Apps"));
    const apps = screen.getByRole("tabpanel", { name: "Apps" });
    expect(within(apps).getByRole("link", { name: /Add your key/ })).toBeTruthy();
  });
});

describe("the collapsed rail (ac-3)", () => {
  it("has one icon for the section, opening it on the last tab", async () => {
    fake.preferences = { rail_collapsed: true, rail_tab: "apps" };
    await withApps();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    const strip = must(rail().querySelector<HTMLElement>("[class*='icons']"));
    const labels = [...strip.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels.filter((l) => l === "Show files" || l === "Show apps")).toEqual(["Show apps"]);
    await userEvent.setup().click(within(rail()).getByRole("button", { name: "Show apps" }));
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
    expect(tab("Apps").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement?.id).toBe("kobe-rail-apps"));
  });

  it("opens on Files the first time", async () => {
    fake.preferences = { rail_collapsed: true };
    await withApps();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    await userEvent.setup().click(within(rail()).getByRole("button", { name: "Show files" }));
    await waitFor(() => expect(tab("Files").getAttribute("aria-selected")).toBe("true"));
  });
});

describe("review fixes (KOBE-448)", () => {
  it("a stored Apps tab never flashes Files while the apps list loads", async () => {
    fake.teamApps = [APP];
    fake.preferences = { rail_tab: "apps" };
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const inner = fake.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://kobe.test").pathname === "/v1/team/apps") await held;
      return inner(input, init);
    });
    openApp(fake);
    await composer();
    await waitFor(() => expect(screen.getByText("Loading apps…")).toBeTruthy());
    // Files stays hidden meanwhile: no flash of the wrong tab.
    expect(must(document.getElementById("kobe-rail-files")).hidden).toBe(true);
    release();
    await tablist();
    expect(tab("Apps").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Loading apps…")).toBeNull();
  });

  it("an apps list that can't be read leaves Files, without waiting", async () => {
    fake.preferences = { rail_tab: "apps" };
    fake.failNext.set("GET /v1/team/apps", new Response(null, { status: 500 }));
    openApp(fake);
    await composer();
    await waitFor(() =>
      expect(must(document.getElementById("kobe-rail-files")).hidden).toBe(false),
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Loading apps…")).toBeNull();
  });

  it("quick arrow presses save the last tab once (the saves are debounced)", async () => {
    await withApps();
    tab("Files").focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    await waitFor(() => expect(puts()).toHaveLength(1), WAIT);
    expect(puts()[0]?.body).toEqual({ rail_tab: "apps" });
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toHaveLength(1);
  });

  it("the Files tab's panel is the one Files element: no region inside it", async () => {
    await withApps();
    const panel = screen.getByRole("tabpanel", { name: "Files" });
    expect(panel.id).toBe("kobe-rail-files");
    expect(within(panel).queryByRole("region")).toBeNull();
  });
});
